/**
 * MyQuestify — ядро интерактивных сцен.
 *
 * Заменяет штатный `Matter.Render`: тот умеет только плоскую заливку тел,
 * из-за чего любая сцена выглядит как набор кружков. Здесь физика и рисование
 * разделены — Matter считает динамику, а кадр рисуется вручную по 2D-контексту
 * с градиентами, тенями и свечением.
 *
 * Ядро отвечает за холст, DPI, цикл кадров, ввод и перетаскивание тел.
 * Конкретные сцены живут в scenes.js и регистрируются через `Stage.register`.
 *
 * Matter.js выбран как физический движок по трём причинам: он работает
 * в браузере без дополнительных зависимостей, распространяется под
 * лицензией MIT и решает ровно ту задачу, которая нужна проекту, —
 * двумерную динамику твёрдых тел. Более крупные движки вроде Box2D в
 * сборке для веба потребовали бы WebAssembly и увеличили бы поставку без
 * выигрыша в возможностях.
 *
 * При этом штатный модуль отрисовки Matter.Render не используется. Он
 * предназначен для отладки и заливает тела сплошным цветом, из-за чего
 * любая сцена выглядит набором геометрических фигур. Разделение динамики
 * и отрисовки позволяет считать физику движком, а рисовать вручную
 * градиентами, тенями и свечением.
 *
 * Экспортирует `window.Stage`. Без Matter.js ядро остаётся вызываемым
 * (no-op) и показывает инструкцию вместо сцены.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;

  /** Максимальный шаг физики: после сворачивания окна dt был бы огромным. */
  var MAX_STEP_MS = 32;
  var MIN_STEP_MS = 8;

  /** Радиус «прощения» при попадании мимо тела, в пикселях сцены. */
  var GRAB_TOLERANCE = 26;

  var registry = {};

  var S = {
    canvas: null,
    ctx: null,
    host: null,
    hint: null,
    fallback: null,
    width: 0,
    height: 0,
    dpr: 1,
    engine: null,
    scene: null,
    sceneKey: null,
    level: 1,
    running: false,
    lastTime: 0,
    rafId: 0,
    resizeTimer: 0,
    errorStreak: 0,
    interactive: true,
    hintsEnabled: true,
    hintTimer: 0,
    sceneConfig: null,
    observer: null,
    available: false,
    drag: { constraint: null, body: null, pointerId: null },
    hintDismissed: false
  };

  // ------------------------------------------------------------------ утилиты

  var util = {
    TAU: TAU,

    clamp: function (value, min, max) {
      return Math.min(max, Math.max(min, value));
    },

    rand: function (min, max) {
      return min + Math.random() * (max - min);
    },

    pick: function (list) {
      return list[Math.floor(Math.random() * list.length)];
    },

    /**
     * Линейная интерполяция между двумя цветами вида [r, g, b].
     * @param {number[]} a
     * @param {number[]} b
     * @param {number} t доля перехода 0…1
     * @returns {number[]}
     */
    mix: function (a, b, t) {
      var k = util.clamp(t, 0, 1);
      return [
        Math.round(a[0] + (b[0] - a[0]) * k),
        Math.round(a[1] + (b[1] - a[1]) * k),
        Math.round(a[2] + (b[2] - a[2]) * k)
      ];
    },

    rgba: function (rgb, alpha) {
      return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
    },

    /**
     * Плавная кривая ускорения-замедления для анимаций возврата.
     * @param {number} t 0…1
     * @returns {number}
     */
    easeInOut: function (t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
  };

  // ------------------------------------------------------------- рисование

  var draw = {
    /**
     * Шар с объёмной заливкой: блик сверху-слева, тень снизу, ободок света.
     *
     * Именно это отличает «кружок» от объекта: один радиальный градиент со
     * смещённым центром читается глазом как сфера.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x
     * @param {number} y
     * @param {number} r
     * @param {string} light цвет освещённой части
     * @param {string} dark цвет теневой части
     * @param {string} [rim] цвет контрового ободка
     */
    sphere: function (ctx, x, y, r, light, dark, rim) {
      var g = ctx.createRadialGradient(
        x - r * 0.36, y - r * 0.42, r * 0.06,
        x, y, r * 1.05
      );
      g.addColorStop(0, light);
      g.addColorStop(1, dark);

      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();

      if (rim) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.97, TAU * 0.08, TAU * 0.44);
        ctx.strokeStyle = rim;
        ctx.lineWidth = Math.max(1, r * 0.08);
        ctx.stroke();
      }

      // Точечный блик — читается даже на радиусе в 6 пикселей.
      ctx.beginPath();
      ctx.ellipse(
        x - r * 0.34, y - r * 0.40, r * 0.26, r * 0.18,
        -0.6, 0, TAU
      );
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fill();
    },

    /**
     * Мягкое свечение вокруг точки. Рисуется в режиме сложения, поэтому
     * несколько источников складываются в яркость, а не перекрывают друг друга.
     */
    glow: function (ctx, x, y, r, color, alpha) {
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color.replace('ALPHA', alpha));
      g.addColorStop(0.55, color.replace('ALPHA', alpha * 0.28));
      g.addColorStop(1, color.replace('ALPHA', 0));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
    },

    /** Строит путь по вершинам тела Matter (без заливки). */
    bodyPath: function (ctx, body) {
      var parts = body.parts.length > 1 ? body.parts.slice(1) : [body];
      ctx.beginPath();
      for (var p = 0; p < parts.length; p += 1) {
        var v = parts[p].vertices;
        ctx.moveTo(v[0].x, v[0].y);
        for (var i = 1; i < v.length; i += 1) {
          ctx.lineTo(v[i].x, v[i].y);
        }
        ctx.closePath();
      }
    },

    /**
     * Заливает тело вертикальным градиентом с контуром — базовый способ
     * нарисовать любой прямоугольный предмет объёмно.
     */
    bodyFill: function (ctx, body, top, bottom, stroke) {
      var b = body.bounds;
      var g = ctx.createLinearGradient(0, b.min.y, 0, b.max.y);
      g.addColorStop(0, top);
      g.addColorStop(1, bottom);

      draw.bodyPath(ctx, body);
      ctx.fillStyle = g;
      ctx.fill();

      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    },

    /** Мягкая эллиптическая тень под объектом. */
    contactShadow: function (ctx, x, y, rx, ry, alpha) {
      var g = ctx.createRadialGradient(x, y, 0, x, y, rx);
      g.addColorStop(0, 'rgba(0,0,0,' + alpha + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, ry / rx);
      ctx.translate(-x, -y);
      ctx.beginPath();
      ctx.arc(x, y, rx, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
    },

    /**
     * Слой атмосферных частиц: пыль, споры, снежинки, пепел.
     *
     * Пустая сцена выглядит макетом, даже если геометрия хороша. Медленное
     * движение мелких точек в глубине — самый дешёвый способ показать, что
     * пространство живое, и он не отвлекает от главного объекта.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object[]} motes массив частиц из draw.seedMotes
     * @param {number} width
     * @param {number} height
     * @param {number} dt шаг кадра
     * @param {string} color цвет с плейсхолдером ALPHA
     */
    motes: function (ctx, motes, width, height, dt, color) {
      for (var i = 0; i < motes.length; i += 1) {
        var mote = motes[i];
        mote.x += mote.vx * dt;
        mote.y += mote.vy * dt;
        mote.phase += mote.drift * dt;
        mote.x += Math.sin(mote.phase) * 0.12;

        // Заворачивание по краям вместо пересоздания: частицы не исчезают
        // на глазах и не появляются вспышкой в центре.
        if (mote.y < -12) { mote.y = height + 10; mote.x = Math.random() * width; }
        if (mote.y > height + 12) { mote.y = -10; mote.x = Math.random() * width; }
        if (mote.x < -12) { mote.x = width + 10; }
        if (mote.x > width + 12) { mote.x = -10; }

        var alpha = mote.alpha * (0.6 + 0.4 * Math.sin(mote.phase * 2));
        ctx.beginPath();
        ctx.arc(mote.x, mote.y, mote.r, 0, Math.PI * 2);
        ctx.fillStyle = color.replace('ALPHA', alpha.toFixed(3));
        ctx.fill();
      }
    },

    /**
     * Создаёт набор частиц под размер сцены.
     *
     * @param {number} count количество
     * @param {number} width
     * @param {number} height
     * @param {Object} options rise — лететь вверх, speed — множитель скорости
     * @returns {Object[]}
     */
    seedMotes: function (count, width, height, options) {
      var opts = options || {};
      var rise = opts.rise ? -1 : 1;
      var speed = opts.speed || 1;
      var list = [];

      for (var i = 0; i < count; i += 1) {
        list.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: 0.5 + Math.random() * 1.8,
          vx: (Math.random() - 0.5) * 0.012 * speed,
          vy: rise * (0.006 + Math.random() * 0.022) * speed,
          alpha: 0.12 + Math.random() * 0.42,
          phase: Math.random() * Math.PI * 2,
          drift: 0.0004 + Math.random() * 0.0016
        });
      }
      return list;
    },

    /**
     * Виньетка по краям кадра.
     *
     * Затемнённые углы собирают взгляд к центру — без неё сцена выглядит
     * равномерно освещённым прямоугольником, то есть плоско.
     */
    vignette: function (ctx, width, height, strength) {
      var gradient = ctx.createRadialGradient(
        width / 2, height * 0.48, Math.min(width, height) * 0.28,
        width / 2, height * 0.5, Math.max(width, height) * 0.78
      );
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(1, 'rgba(0,0,0,' + (strength || 0.45) + ')');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    },

    /**
     * Дальний силуэт: холмы, кроны, крыши — одной ломаной с сглаживанием.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} width
     * @param {number} baseY линия горизонта
     * @param {number} amplitude высота гребней
     * @param {number} seed сдвиг фазы, чтобы слои не совпадали
     * @param {string} color
     */
    ridge: function (ctx, width, baseY, amplitude, seed, color) {
      ctx.beginPath();
      ctx.moveTo(0, baseY + amplitude);
      for (var x = 0; x <= width; x += 12) {
        var y = baseY
          - Math.sin(x * 0.006 + seed) * amplitude
          - Math.sin(x * 0.017 + seed * 2.3) * amplitude * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, baseY + amplitude * 3);
      ctx.lineTo(0, baseY + amplitude * 3);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    },

    /** Прямоугольник со скруглением (для сцен, рисующих не по телам). */
    roundRect: function (ctx, x, y, w, h, r) {
      var radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + w, y, x + w, y + h, radius);
      ctx.arcTo(x + w, y + h, x, y + h, radius);
      ctx.arcTo(x, y + h, x, y, radius);
      ctx.arcTo(x, y, x + w, y, radius);
      ctx.closePath();
    }
  };

  // ---------------------------------------------------------------- размеры

  /**
   * Текущий размер контейнера в CSS-пикселях.
   * @returns {{width: number, height: number}}
   */
  function measure() {
    var rect = S.host.getBoundingClientRect();
    return {
      width: Math.max(240, Math.round(rect.width)),
      height: Math.max(240, Math.round(rect.height))
    };
  }

  /**
   * Подгоняет буфер холста под размер и плотность экрана.
   *
   * Без множителя devicePixelRatio на мониторе с масштабом 150 % картинка
   * растягивается системой и выглядит мылом — именно это отличает «дёшево»
   * от «дорого» в canvas-графике.
   */
  function applySize() {
    var size = measure();
    S.width = size.width;
    S.height = size.height;
    S.dpr = util.clamp(global.devicePixelRatio || 1, 1, 2.5);

    S.canvas.width = Math.round(S.width * S.dpr);
    S.canvas.height = Math.round(S.height * S.dpr);
    S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  }

  // ------------------------------------------------------------------ ввод

  /**
   * Переводит координаты указателя в систему координат сцены.
   * @param {PointerEvent} event
   * @returns {{x: number, y: number}}
   */
  function toScene(event) {
    var rect = S.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (S.width / rect.width),
      y: (event.clientY - rect.top) * (S.height / rect.height)
    };
  }

  /**
   * Ищет тело под курсором среди перетаскиваемых.
   *
   * Сначала точное попадание, затем — ближайшее тело в радиусе допуска.
   * Мелкие объекты иначе почти невозможно поймать: промах в три пикселя
   * ощущается как «не работает».
   *
   * @param {number} x
   * @param {number} y
   * @returns {?Object} тело Matter либо null
   */
  function findGrabTarget(x, y) {
    if (!S.scene || typeof S.scene.draggables !== 'function') { return null; }

    var bodies = S.scene.draggables() || [];
    if (!bodies.length) { return null; }

    var M = global.Matter;
    var exact = M.Query.point(bodies, { x: x, y: y });
    if (exact.length) {
      return exact[exact.length - 1];   // верхнее из перекрывающихся
    }

    var best = null;
    var bestDistance = GRAB_TOLERANCE;
    for (var i = 0; i < bodies.length; i += 1) {
      var dx = bodies[i].position.x - x;
      var dy = bodies[i].position.y - y;
      var distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = bodies[i];
      }
    }
    return best;
  }

  /**
   * Начинает перетаскивание тела пружинной связью.
   *
   * Собственная связь вместо `MouseConstraint`: тот захватывает любое тело
   * под курсором, включая статичную декорацию, и блокирует клики по сцене.
   */
  function beginDrag(body, x, y) {
    var M = global.Matter;

    M.Sleeping.set(body, false);
    S.drag.body = body;
    S.drag.constraint = M.Constraint.create({
      pointA: { x: x, y: y },
      bodyB: body,
      pointB: {
        x: (x - body.position.x) * Math.cos(-body.angle) - (y - body.position.y) * Math.sin(-body.angle),
        y: (x - body.position.x) * Math.sin(-body.angle) + (y - body.position.y) * Math.cos(-body.angle)
      },
      length: 0,
      stiffness: 0.22,
      damping: 0.14,
      render: { visible: false }
    });
    M.Composite.add(S.engine.world, S.drag.constraint);
  }

  function endDrag() {
    if (S.drag.constraint) {
      global.Matter.Composite.remove(S.engine.world, S.drag.constraint);
    }
    S.drag.constraint = null;
    S.drag.body = null;
    S.drag.pointerId = null;
  }

  function dismissHint() {
    if (S.hint && !S.hintDismissed) {
      S.hintDismissed = true;
      S.hint.classList.add('is-faded');
    }
    global.clearTimeout(S.hintTimer);
  }

  /**
   * Показывает подсказку и гасит её через пять секунд.
   *
   * Постоянная плашка внизу перекрывает нижнюю часть сцены — ровно ту, где
   * копятся упавшие плоды и стекает лава. Пяти секунд хватает прочитать
   * строку, дальше она только мешает.
   */
  function armHint() {
    global.clearTimeout(S.hintTimer);
    if (!S.hint) { return; }

    if (!S.hintsEnabled) {
      S.hint.classList.add('is-faded');
      S.hintDismissed = true;
      return;
    }

    S.hintDismissed = false;
    S.hint.classList.remove('is-faded');
    S.hintTimer = global.setTimeout(function () {
      S.hintDismissed = true;
      S.hint.classList.add('is-faded');
    }, 5000);
  }

  function onPointerDown(event) {
    // Только основная кнопка: правый клик открывает контекстное меню,
    // средний — прокрутку, и захватывать их значит ломать ожидания.
    if (event.button !== 0 || !S.scene) { return; }

    // Режим предпросмотра: сцена живёт и рисуется, но не отвечает на ввод.
    // Иначе смотреть было бы нечем — покупка теряла бы смысл.
    if (!S.interactive) {
      dismissHint();
      return;
    }

    var point = toScene(event);
    dismissHint();

    try {
      S.canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      /* захват указателя не критичен */
    }

    // Приоритет у перетаскивания: если под курсором предмет, тащим его,
    // а действие сцены (сбор плодов, извержение) не запускаем.
    var target = S.scene.usesPhysics === false ? null : findGrabTarget(point.x, point.y);
    if (target) {
      S.drag.pointerId = event.pointerId;
      beginDrag(target, point.x, point.y);
      event.preventDefault();
      return;
    }

    if (typeof S.scene.pointerDown === 'function') {
      S.scene.pointerDown(point.x, point.y);
    }
    S.drag.pointerId = event.pointerId;
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!S.interactive || !S.scene || S.drag.pointerId !== event.pointerId) { return; }

    var point = toScene(event);
    if (S.drag.constraint) {
      S.drag.constraint.pointA.x = point.x;
      S.drag.constraint.pointA.y = point.y;
    } else if (typeof S.scene.pointerMove === 'function') {
      S.scene.pointerMove(point.x, point.y);
    }
  }

  function onPointerUp(event) {
    if (S.drag.pointerId !== event.pointerId) { return; }

    var point = toScene(event);
    if (!S.drag.constraint && S.scene && typeof S.scene.pointerUp === 'function') {
      S.scene.pointerUp(point.x, point.y);
    }
    endDrag();

    try {
      S.canvas.releasePointerCapture(event.pointerId);
    } catch (error) {
      /* уже отпущен */
    }
  }

  /**
   * Пробрасывает нажатия клавиш активной сцене.
   *
   * Слушатель на документе, а не на холсте: у canvas нет фокуса по
   * умолчанию, и без клика по нему клавиши бы не доходили.
   */
  function bindKeyboard() {
    global.addEventListener('keydown', function (event) {
      if (!S.interactive || !S.scene || typeof S.scene.keyDown !== 'function') { return; }

      // Пока курсор в поле ввода, клавиши принадлежат ему.
      var target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
          target.isContentEditable)) { return; }

      if (S.scene.keyDown(event.code)) { event.preventDefault(); }
    });

    global.addEventListener('keyup', function (event) {
      if (S.scene && typeof S.scene.keyUp === 'function') { S.scene.keyUp(event.code); }
    });
  }

  function bindPointer() {
    S.canvas.addEventListener('pointerdown', onPointerDown);
    S.canvas.addEventListener('pointermove', onPointerMove);
    S.canvas.addEventListener('pointerup', onPointerUp);
    S.canvas.addEventListener('pointercancel', onPointerUp);
    S.canvas.addEventListener('pointerleave', onPointerUp);
    // Контекстное меню поверх сцены выглядит как сбой, а не как функция.
    S.canvas.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    });
  }

  // ------------------------------------------------------------- цикл кадров

  function frame(timestamp) {
    if (!S.running) { return; }

    var delta = S.lastTime ? timestamp - S.lastTime : 16.7;
    S.lastTime = timestamp;
    var step = util.clamp(delta, MIN_STEP_MS, MAX_STEP_MS);

    if (S.scene) {
      // Необработанное исключение внутри кадра останавливает
      // requestAnimationFrame навсегда и без следа: сцена просто замирает
      // чёрным прямоугольником. Ловим, считаем и после серии сбоев
      // останавливаемся явно, с сообщением.
      try {
        if (S.scene.usesPhysics !== false && S.engine) {
          global.Matter.Engine.update(S.engine, step);
        }
        if (typeof S.scene.update === 'function') {
          S.scene.update(step, timestamp);
        }

        S.ctx.clearRect(0, 0, S.width, S.height);
        // dt нужен слоям, которые двигаются при отрисовке (частицы, блики).
        S.scene.render(S.ctx, S.width, S.height, step);
        S.errorStreak = 0;
      } catch (error) {
        S.errorStreak += 1;
        if (S.errorStreak === 1 || S.errorStreak % 60 === 0) {
          console.error('Ошибка кадра сцены «' + S.sceneKey + '»:', error);
        }
        if (S.errorStreak > 180) {
          stop();
          if (S.fallback) {
            S.fallback.hidden = false;
            S.fallback.textContent =
              'Сцена «' + S.sceneKey + '» остановлена из-за ошибки отрисовки. ' +
              'Подробности в консоли (F12).';
          }
          return;
        }
      }
    }

    S.rafId = global.requestAnimationFrame(frame);
  }

  function start() {
    if (S.running) { return; }
    S.running = true;
    S.lastTime = 0;
    S.rafId = global.requestAnimationFrame(frame);
  }

  function stop() {
    S.running = false;
    if (S.rafId) { global.cancelAnimationFrame(S.rafId); }
    S.rafId = 0;
  }

  // ------------------------------------------------------- окружение сцены

  /**
   * Объект, который ядро передаёт каждой сцене.
   *
   * Размер и уровень читаются функциями, а не копируются полями: сцена живёт
   * дольше одного кадра, и снимок размера устарел бы после первого же resize.
   */
  var env = {
    get M() { return global.Matter; },
    get engine() { return S.engine; },
    get world() { return S.engine ? S.engine.world : null; },
    get width() { return S.width; },
    get height() { return S.height; },
    get level() { return S.level; },
    draw: draw,
    util: util
  };

  function teardownScene() {
    if (S.scene && typeof S.scene.destroy === 'function') {
      S.scene.destroy();
    }
    if (S.engine) {
      global.Matter.Composite.clear(S.engine.world, false);
    }
    S.scene = null;
    S.sceneKey = null;
  }

  function sceneText(key, fallback) {
    return global.I18n ? global.I18n.t(key, fallback) : fallback;
  }

  // -------------------------------------------------------------------- API

  var Stage = {
    /**
     * Регистрирует фабрику сцены.
     * @param {string} key ключ, совпадающий с ключом каталога на бэкенде
     * @param {function} factory функция (env) → объект сцены
     */
    register: function (key, factory) {
      registry[key] = factory;
    },

    /** Список зарегистрированных ключей. */
    keys: function () {
      return Object.keys(registry);
    },

    /**
     * Инициализирует холст и физический движок.
     *
     * @param {Object} config
     * @param {HTMLCanvasElement} config.canvas
     * @param {HTMLElement} config.host контейнер, несущий фон
     * @param {HTMLElement} [config.hint] подсказка, гаснет после первого действия
     * @param {HTMLElement} [config.fallback] блок при отсутствии Matter.js
     * @returns {boolean} удалось ли запустить ядро
     */
    init: function (config) {
      S.canvas = config.canvas;
      S.host = config.host;
      S.hint = config.hint || null;
      S.fallback = config.fallback || null;

      if (!global.Matter) {
        S.available = false;
        if (S.fallback) { S.fallback.hidden = false; }
        if (S.hint) { S.hint.hidden = true; }
        if (S.canvas) { S.canvas.hidden = true; }
        return false;
      }

      S.ctx = S.canvas.getContext('2d');
      applySize();

      S.engine = global.Matter.Engine.create();
      S.engine.gravity.y = 1;
      S.engine.positionIterations = 8;
      S.engine.velocityIterations = 6;

      bindPointer();
      bindKeyboard();

      var onResize = function () {
        global.clearTimeout(S.resizeTimer);
        S.resizeTimer = global.setTimeout(function () {
          applySize();
          if (S.scene && typeof S.scene.resize === 'function') {
            S.scene.resize(S.width, S.height);
          }
        }, 120);
      };

      if (typeof global.ResizeObserver === 'function') {
        S.observer = new global.ResizeObserver(onResize);
        S.observer.observe(S.host);
      } else {
        global.addEventListener('resize', onResize);
      }

      S.available = true;
      start();
      return true;
    },

    /**
     * Переключает активную сцену.
     * @param {string} key ключ сцены
     * @returns {boolean} успех
     */
    mount: function (key) {
      if (!S.available || !registry[key]) { return false; }
      if (S.sceneKey === key) { return true; }

      teardownScene();
      applySize();

      try {
        S.scene = registry[key](env);
        S.sceneKey = key;
        S.hintDismissed = false;

        if (S.hint) {
          S.hint.textContent = sceneText('scene.hint.' + S.sceneKey, S.scene.hint);
        }

        // Сцена может принимать настройки (раскладку клавиш).
        if (typeof S.scene.configure === 'function' && S.sceneConfig) {
          S.scene.configure(S.sceneConfig);
        }

        S.scene.build(S.width, S.height);
        // Подсказка появляется заново при каждой смене сцены: правила у
        // каждой свои, и один раз прочитанное к новой сцене не относится.
        armHint();
      } catch (error) {
        console.error('Не удалось построить сцену «' + key + '»:', error);
        S.scene = null;
        S.sceneKey = null;
        return false;
      }

      S.errorStreak = 0;
      // Цикл мог остановиться после предыдущей сбойной сцены.
      start();
      return true;
    },

    /**
     * Применяет пользовательские настройки: подсказки и раскладку клавиш.
     * @param {Object} config фрагмент настроек
     */
    applySettings: function (config) {
      S.sceneConfig = config || null;
      S.hintsEnabled = !config || config.show_hints !== false;

      if (S.scene && typeof S.scene.configure === 'function' && S.sceneConfig) {
        S.scene.configure(S.sceneConfig);
      }
      if (!S.hintsEnabled && S.hint) {
        global.clearTimeout(S.hintTimer);
        S.hint.classList.add('is-faded');
        S.hintDismissed = true;
      }
    },

    /** Replaces the current scene hint after a language change. */
    retranslate: function () {
      if (S.hint && S.scene) {
        S.hint.textContent = sceneText('scene.hint.' + S.sceneKey, S.scene.hint);
      }
    },

    /** Показывает подсказку текущей сцены на пять секунд. */
    showHint: function () {
      armHint();
    },

    /**
     * Включает или выключает реакцию сцены на ввод.
     *
     * В предпросмотре сцена рисуется и живёт своей жизнью, но не отзывается
     * на мышь: посмотреть можно, поиграть — только после покупки.
     *
     * @param {boolean} value
     */
    setInteractive: function (value) {
      S.interactive = Boolean(value);
      if (!S.interactive) { endDrag(); }
      if (S.canvas) {
        S.canvas.style.cursor = S.interactive ? 'crosshair' : 'not-allowed';
      }
    },

    /**
     * Возвращает текущую сцену в исходное состояние.
     *
     * Объект сцены пересоздаётся из реестра, а не сбрасывается по полям.
     * Сброс полей потребовал бы от каждой сцены помнить полный перечень
     * своего состояния, и любое забытое поле оставляло бы след прошлого
     * сеанса: разбросанные предметы, прогоревшие поленья, смешанные
     * растворы. Пересоздание не оставляет такой возможности.
     *
     * @returns {boolean} удалось ли пересобрать сцену
     */
    reset: function () {
      if (!S.available || !S.sceneKey) { return false; }

      var key = S.sceneKey;
      // Ключ обнуляется намеренно: mount пропускает повторное подключение
      // той же сцены, а здесь требуется именно оно.
      S.sceneKey = null;
      return Stage.mount(key);
    },

    /** Ключ активной сцены. */
    current: function () {
      return S.sceneKey;
    },

    /**
     * Пересчитывает размер холста под контейнер.
     *
     * Нужен после показа скрытой панели: пока элемент был ``hidden``, его
     * ширина равнялась нулю, и ResizeObserver об этом уже отчитался.
     */
    resize: function () {
      if (!S.available) { return; }
      applySize();
      if (S.scene && typeof S.scene.resize === 'function') {
        S.scene.resize(S.width, S.height);
      }
    },

    /**
     * Обновляет уровень: сцены масштабируют содержимое под него.
     * @param {number} level 1…10
     */
    setLevel: function (level) {
      var next = util.clamp(Number(level) || 1, 1, 10);
      if (next === S.level) { return; }
      S.level = next;
      if (S.scene && typeof S.scene.setLevel === 'function') {
        S.scene.setLevel(next);
      }
    },

    /**
     * Подставляет пользовательский фон контейнера.
     * @param {?string} url публичный URL изображения либо null
     */
    setBackground: function (url) {
      if (!S.host) { return; }

      if (url) {
        // Метка времени сбивает кэш WebView2: имя файла меняется, но при
        // повторном обращении к тому же URL движок отдал бы старую картинку.
        S.host.style.backgroundImage =
          'linear-gradient(rgba(6,8,12,0.42), rgba(6,8,12,0.62)), ' +
          'url("' + encodeURI(url) + '?v=' + Date.now() + '")';
        S.host.classList.add('has-custom-bg');
      } else {
        S.host.style.backgroundImage = '';
        S.host.classList.remove('has-custom-bg');
      }
    },

    /**
     * Праздничный отклик сцены на завершённый квест.
     * @param {number} count интенсивность (обычно число часов)
     */
    celebrate: function (count) {
      if (S.scene && typeof S.scene.celebrate === 'function') {
        S.scene.celebrate(count);
        dismissHint();
      }
    },

    isAvailable: function () {
      return S.available;
    },

    /** Останавливает цикл и освобождает ресурсы. */
    destroy: function () {
      stop();
      teardownScene();
      if (S.observer) { S.observer.disconnect(); }
      if (S.engine) { global.Matter.Engine.clear(S.engine); }
      S.available = false;
    }
  };

  global.Stage = Stage;
}(window));
