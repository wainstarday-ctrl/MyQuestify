/**
 * Измерение нагрузки сцены «Облака Вдохновения» на холст.
 *
 * Сцена рисуется без физического движка, поэтому её стоимость определяется
 * почти целиком числом обращений к холсту за кадр. Три из них дороги
 * непропорционально остальным:
 *
 *   createLinearGradient — построение градиента, самая тяжёлая операция
 *                          двумерного холста;
 *   stroke               — обводка контура; триста отдельных обводок
 *                          одинаковым пером стоят кратно дороже одной
 *                          обводки контура из трёхсот отрезков;
 *   fillStyle            — присваивание строки цвета: каждая такая строка
 *                          собирается заново и тут же выбрасывается.
 *
 * Проверять их глазами на устройстве бесполезно: разница видна как «стало
 * плавнее», и на быстром телефоне не видна вовсе. Стенд подменяет холст
 * счётчиком и прогоняет сцену на месте, без браузера.
 *
 * Запуск:
 *     node tools/bench_clouds.js
 *
 * Возвращает ненулевой код, если какая-либо из границ превышена.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/** Размер холста стенда: близко к экрану телефона в горизонтальном виде. */
const WIDTH = 900;
const HEIGHT = 520;

/** Сколько кадров прогонять. */
const FRAMES = 120;

/** Шаг кадра, миллисекунды: шестьдесят кадров в секунду. */
const STEP = 16.7;

/**
 * Холст-счётчик.
 *
 * Реализует только то, чем пользуется сцена. Каждый вызов увеличивает
 * счётчик своего имени; присваивание fillStyle и strokeStyle перехватывается
 * через свойства с функцией записи, потому что это присваивание, а не вызов.
 */
function makeCountingContext() {
  const calls = Object.create(null);
  const bump = (name) => { calls[name] = (calls[name] || 0) + 1; };

  const gradient = { addColorStop() { bump('addColorStop'); } };

  const ctx = {
    calls,

    save() { bump('save'); },
    restore() { bump('restore'); },
    translate() { bump('translate'); },
    beginPath() { bump('beginPath'); },
    closePath() { bump('closePath'); },
    moveTo() { bump('moveTo'); },
    lineTo() { bump('lineTo'); },
    quadraticCurveTo() { bump('quadraticCurveTo'); },
    arc() { bump('arc'); },
    fill() { bump('fill'); },
    stroke() { bump('stroke'); },
    fillRect() { bump('fillRect'); },
    fillText() { bump('fillText'); },
    createLinearGradient() { bump('createLinearGradient'); return gradient; },
    createRadialGradient() { bump('createRadialGradient'); return gradient; },

    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    font: '',
    textAlign: 'left'
  };

  // Присваивание цвета считается отдельно, и отдельно от него — случай,
  // когда цвет задан строкой. Различие существенное: подстановка готового
  // градиента ничего не создаёт, а строка вида «rgba(...)», собранная в
  // цикле, живёт до ближайшей уборки мусора. Дорога именно она.
  let fillStyle = '#000';
  let strokeStyle = '#000';
  Object.defineProperty(ctx, 'fillStyle', {
    get: () => fillStyle,
    set: (value) => {
      bump(typeof value === 'string' ? 'строка цвета заливки' : 'заливка градиентом');
      fillStyle = value;
    }
  });
  Object.defineProperty(ctx, 'strokeStyle', {
    get: () => strokeStyle,
    set: (value) => { bump('строка цвета обводки'); strokeStyle = value; }
  });

  return ctx;
}

/** Вспомогательные расчёты, которые сцена получает от ядра. */
const util = {
  clamp: (value, low, high) => Math.min(high, Math.max(low, value)),
  rand: (low, high) => low + Math.random() * (high - low),
  mix: (a, b, k) => a.map((value, i) => value + (b[i] - value) * k),
  rgba: (color, alpha) =>
    'rgba(' + color.map(Math.round).join(', ') + ', ' + alpha + ')'
};

/** Слои отрисовки ядра: считаются как обычные обращения к холсту. */
const draw = {
  glow(ctx) { ctx.beginPath(); ctx.fill(); },
  vignette(ctx) { ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(); }
};

/**
 * Загружает сцену в отдельном окружении и возвращает её.
 *
 * Файл сцены рассчитан на браузер и обращается к window; здесь роль окна
 * играет обычный объект, а реестр ядра подменён приёмником.
 *
 * @param {object} env окружение сцены
 * @returns {object} объект сцены
 */
function loadScene(env) {
  let factory = null;

  const sandbox = {
    window: null,
    performance: { now: () => Date.now() },
    Math,
    console
  };
  sandbox.window = {
    Stage: {
      register(key, create) {
        if (key === 'clouds') { factory = create; }
      }
    }
  };
  sandbox.performance = { now: () => Date.now() };

  vm.createContext(sandbox);
  const source = fs.readFileSync(
    path.join(ROOT, 'static', 'js', 'scene-clouds.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'scene-clouds.js' });

  if (!factory) {
    throw new Error('сцена clouds не зарегистрировалась');
  }
  return factory(env);
}

/**
 * Прогоняет сцену и возвращает среднее число вызовов на кадр.
 *
 * @param {object} options
 * @param {number} options.density доля частиц профиля отрисовки
 * @param {boolean} options.storm держать ли тучи собранными
 * @returns {object} счётчики, поделённые на число кадров
 */
function measure(options) {
  const ctx = makeCountingContext();
  const env = {
    width: WIDTH,
    height: HEIGHT,
    level: 10,
    density: options.density,
    glow: true,
    util,
    draw,
    t: (key, fallback) => fallback
  };

  const scene = loadScene(env);
  scene.build(WIDTH, HEIGHT);

  if (options.storm) {
    // Гроза над всем небом — самое тяжёлое состояние сцены: идёт дождь,
    // тучи подсвечены изнутри, звёзды проступают сквозь темноту.
    for (let i = 0; i < 40; i += 1) {
      scene.pointerDown(WIDTH * Math.random(), HEIGHT * 0.3);
      scene.pointerUp();
    }
  }

  for (let frame = 0; frame < FRAMES; frame += 1) {
    scene.update(STEP);
    scene.render(ctx, WIDTH, HEIGHT);
  }

  const perFrame = {};
  for (const [name, count] of Object.entries(ctx.calls)) {
    perFrame[name] = count / FRAMES;
  }
  return perFrame;
}

/** Границы, за которыми отрисовка перестаёт быть дешёвой. */
const LIMITS = [
  {
    name: 'createLinearGradient',
    // Небо, и только оно. Градиенты клубов облаков хранятся между кадрами
    // и пересобираются лишь при заметном изменении оттенка тучи, поэтому
    // в установившейся грозе их не должно быть вовсе.
    limit: 3
  },
  {
    name: 'stroke',
    // Дождь — один контур. Остаётся обводка птиц (до пяти), молний
    // (по две на разряд) и ободка солнца.
    limit: 20
  },
  {
    name: 'строка цвета заливки',
    // Небо, вспышка, подпись, затемнение — и одна установка цвета на все
    // звёзды разом, а не по строке на звезду. Подстановка сохранённого
    // градиента в этот счёт не входит: она ничего не создаёт.
    limit: 12
  },
  {
    name: 'строка цвета обводки',
    // Дождь, птицы, молнии, ободок солнца — по одной установке на слой.
    limit: 12
  }
];

function main() {
  let failed = false;

  for (const profile of [
    { title: 'высокий профиль, гроза', density: 1, storm: true },
    { title: 'слабое устройство, гроза', density: 0.28, storm: true },
    { title: 'высокий профиль, ясно', density: 1, storm: false }
  ]) {
    const perFrame = measure(profile);
    console.log('\n  ' + profile.title);

    for (const { name, limit } of LIMITS) {
      const value = perFrame[name] || 0;
      const ok = value <= limit;
      if (!ok) { failed = true; }
      console.log(
        '    %s %s: %s за кадр (предел %s)',
        ok ? '✓' : '✗', name, value.toFixed(2), limit
      );
    }

    console.log('    · arc: %s, fill: %s, lineTo: %s за кадр',
      (perFrame.arc || 0).toFixed(1),
      (perFrame.fill || 0).toFixed(1),
      (perFrame.lineTo || 0).toFixed(1));
  }

  if (failed) {
    console.error('\n  ПРЕВЫШЕНЫ ГРАНИЦЫ НАГРУЗКИ НА ХОЛСТ\n');
    process.exit(1);
  }
  console.log('\n  НАГРУЗКА НА ХОЛСТ В ПРЕДЕЛАХ\n');
}

main();
