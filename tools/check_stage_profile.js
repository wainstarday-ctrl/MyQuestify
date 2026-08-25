/**
 * Проверка поведения ядра сцен на слабом устройстве.
 *
 * Три свойства ядра нельзя увидеть глазами и невозможно проверить на машине
 * сборки обычным запуском:
 *
 *   1) разрешение холста следует профилю — иначе слабый телефон закрашивает
 *      втрое больше точек, чем нужно, и число частиц уже не спасает;
 *   2) профиль понижается сам, если кадры не успевают — сведения о числе
 *      ядер и объёме памяти для недорогих телефонов ничего не говорят;
 *   3) цикл кадров останавливается, когда сцену не видно — на телефоне она
 *      скрыта переключателем видов бо́льшую часть времени.
 *
 * Стенд подменяет окно браузера, физический движок и холст простыми
 * заглушками, а часы — счётчиком: кадр можно «сделать медленным», просто
 * назначив ему шаг. Браузер и устройство не нужны.
 *
 * Запуск:
 *     node tools/check_stage_profile.js
 *
 * Возвращает ненулевой код при любом несовпадении.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;

/**
 * Сверяет значение с ожидаемым и печатает строку отчёта.
 *
 * @param {string} title что проверяется
 * @param {*} actual полученное значение
 * @param {*} expected ожидаемое значение
 */
function expect(title, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures += 1; }
  console.log('    %s %s: %s%s',
    ok ? '✓' : '✗', title, actual,
    ok ? '' : ' (ожидалось ' + expected + ')');
}

/**
 * Создаёт окружение с ядром сцен.
 *
 * @param {object} device сведения об устройстве
 * @param {number} device.cores число ядер
 * @param {number|undefined} device.memory объём памяти, ГБ
 * @param {boolean} device.coarse сенсорный ввод
 * @param {number} device.pixelRatio плотность пикселей экрана
 * @returns {object} доступ к ядру и рычагам стенда
 */
function makeStage(device) {
  const listeners = {};
  let observerCallback = null;
  let visibilityCallback = null;
  let pending = null;

  const canvas = {
    width: 0,
    height: 0,
    hidden: false,
    getContext: () => ({
      setTransform() {}, clearRect() {}, save() {}, restore() {},
      beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {},
      lineTo() {}, fillRect() {}, fillText() {}, translate() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} })
    }),
    addEventListener() {},
    getBoundingClientRect: () => ({ width: 420, height: 300 })
  };

  const host = {
    clientWidth: 420,
    clientHeight: 300,
    getBoundingClientRect: () => ({ width: 420, height: 300 }),
    addEventListener() {},
    appendChild() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {}
  };

  // Движок-заглушка: ядро читает и пишет число проходов решателя, больше
  // от движка здесь ничего не требуется.
  const Matter = {
    Engine: {
      create: () => ({
        gravity: { x: 0, y: 1 },
        world: { bodies: [] },
        positionIterations: 6,
        velocityIterations: 4
      }),
      update() {},
      clear() {}
    },
    World: { add() {}, remove() {}, clear() {} },
    Composite: { add() {}, remove() {}, clear() {}, allBodies: () => [] },
    Bodies: {}, Body: {}, Constraint: {}, Query: { point: () => [] },
    Events: { on() {} }
  };

  const sandbox = { console: { info() {}, warn() {}, error() {} }, Math, Date };
  sandbox.window = {
    Matter,
    devicePixelRatio: device.pixelRatio,
    navigator: {
      hardwareConcurrency: device.cores,
      deviceMemory: device.memory
    },
    matchMedia: () => ({ matches: device.coarse }),
    requestAnimationFrame: (fn) => { pending = fn; return 1; },
    cancelAnimationFrame: () => { pending = null; },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    addEventListener(name, fn) { listeners[name] = fn; },
    ResizeObserver: function (fn) {
      observerCallback = fn;
      this.observe = () => {};
      this.disconnect = () => {};
    },
    IntersectionObserver: function (fn) {
      visibilityCallback = fn;
      this.observe = () => {};
      this.disconnect = () => {};
    },
    document: {
      hidden: false,
      addEventListener(name, fn) {
        if (name === 'visibilitychange') { visibilityCallback = visibilityCallback; }
        listeners['document:' + name] = fn;
      }
    },
    console: sandbox.console
  };
  sandbox.window.window = sandbox.window;
  sandbox.performance = { now: () => Date.now() };
  sandbox.global = sandbox.window;

  vm.createContext(sandbox);
  for (const file of ['stage.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(ROOT, 'static', 'js', file), 'utf8'),
      sandbox, { filename: file });
  }

  const Stage = sandbox.window.Stage;

  // Простейшая сцена: ядру важно лишь, что она строится и рисуется.
  let builds = 0;
  Stage.register('probe', () => ({
    usesPhysics: false,
    hint: '',
    build() { builds += 1; },
    resize() { builds += 1; },
    update() {},
    render() {},
    draggables: () => []
  }));

  Stage.init({ canvas, host });
  Stage.mount('probe');

  return {
    Stage,
    canvas,
    get builds() { return builds; },

    /**
     * Прогоняет кадры с заданным шагом.
     *
     * @param {number} count сколько кадров
     * @param {number} stepMs шаг между кадрами
     */
    run(count, stepMs) {
      let clock = 1000;
      for (let i = 0; i < count; i += 1) {
        clock += stepMs;
        if (!pending) { return; }
        const fn = pending;
        pending = null;
        fn(clock);
      }
    },

    /** Идёт ли цикл кадров. */
    get running() { return pending !== null; },

    /** Сообщает ядру, что сцена ушла за край экрана. */
    setVisible(visible) {
      visibilityCallback([{ isIntersecting: visible }]);
    }
  };
}

console.log('\n  Профиль по сведениям об устройстве');
{
  const weak = makeStage({ cores: 8, memory: 2, coarse: true, pixelRatio: 3 });
  expect('телефон с 2 ГБ', weak.Stage.status().profile, 'low');
  // Плотность 3 при пределе профиля 1: холст ровно в размер сцены.
  expect('ширина холста', weak.canvas.width, 420);

  const unknown = makeStage({ cores: 8, memory: undefined, coarse: true, pixelRatio: 3 });
  expect('телефон без сведений о памяти', unknown.Stage.status().profile, 'low');

  const mid = makeStage({ cores: 8, memory: 4, coarse: true, pixelRatio: 3 });
  expect('телефон с 4 ГБ', mid.Stage.status().profile, 'medium');
  // Предел среднего профиля — 1.5.
  expect('ширина холста', mid.canvas.width, 630);

  const desk = makeStage({ cores: 16, memory: 8, coarse: false, pixelRatio: 2 });
  expect('настольная машина', desk.Stage.status().profile, 'high');
  expect('ширина холста', desk.canvas.width, 840);
}

console.log('\n  Понижение профиля по измеренной плавности');
{
  const stage = makeStage({ cores: 16, memory: 8, coarse: false, pixelRatio: 2 });
  expect('начальный профиль', stage.Stage.status().profile, 'high');

  // Разогрев: первые кадры не измеряются.
  stage.run(45, 60);
  expect('во время разогрева профиль тот же', stage.Stage.status().profile, 'high');

  stage.run(90, 60);      // выборка медленных кадров
  expect('после медленной выборки', stage.Stage.status().profile, 'medium');
  expect('холст пересчитан', stage.canvas.width, 630);

  stage.run(45 + 90, 60); // разогрев и ещё одна выборка
  expect('после второй выборки', stage.Stage.status().profile, 'low');
  expect('холст пересчитан', stage.canvas.width, 420);

  stage.run(45 + 90, 60);
  expect('ниже низкого не опускается', stage.Stage.status().profile, 'low');
}

console.log('\n  Плавная сцена профиль не теряет');
{
  const stage = makeStage({ cores: 16, memory: 8, coarse: false, pixelRatio: 2 });
  stage.run(45 + 900, 16);
  expect('шестьдесят кадров в секунду', stage.Stage.status().profile, 'high');
}

console.log('\n  Долгая остановка за понижение не считается');
{
  const stage = makeStage({ cores: 16, memory: 8, coarse: false, pixelRatio: 2 });
  stage.run(45, 16);
  stage.run(200, 900);   // окно свёрнуто: шаг почти секунда
  expect('профиль сохранён', stage.Stage.status().profile, 'high');
}

console.log('\n  Останов цикла вне экрана');
{
  const stage = makeStage({ cores: 8, memory: 4, coarse: true, pixelRatio: 3 });
  stage.run(5, 16);
  expect('пока сцена видна — цикл идёт', stage.running, true);

  stage.setVisible(false);
  expect('сцена скрыта — цикл остановлен', stage.running, false);

  stage.setVisible(true);
  expect('сцена снова видна — цикл идёт', stage.running, true);
}

if (failures) {
  console.error('\n  НЕСОВПАДЕНИЙ: ' + failures + '\n');
  process.exit(1);
}
console.log('\n  ЯДРО СЦЕН ВЕДЁТ СЕБЯ КАК ЗАДУМАНО\n');
