/**
 * Проверка мобильной серверной части.
 *
 * В мобильной сборке нет Python: роль сервера играет local-api.js, а роль
 * базы — хранилище браузера. Два свойства этой замены важны и незаметны:
 *
 *   1) читающий запрос не должен ничего записывать. Состояние хранится
 *      одним объектом, и каждая запись перекладывает журнал целиком —
 *      со всеми квестами, мыслями и перепиской. Одно действие пользователя
 *      вызывает пять-шесть чтений, и лишние записи стоят дороже полезной;
 *
 *   2) читающий запрос не должен менять состояние. Первое свойство
 *      опирается на второе: если бы обработчик GET что-то менял, отказ от
 *      записи после него терял бы данные.
 *
 * Стенд подменяет хранилище счётчиком и снимает слепок состояния до и после
 * каждого читающего запроса.
 *
 * Запуск:
 *     node tools/check_local_api.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;

function expect(title, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures += 1; }
  console.log('    %s %s: %s%s',
    ok ? '✓' : '✗', title, actual,
    ok ? '' : ' (ожидалось ' + expected + ')');
}

/**
 * Хранилище-заглушка поверх обычного объекта.
 *
 * Считает записи. Обещания разрешаются сразу — очередь задач Node доводит
 * их до конца между запросами стенда.
 */
function makeStorage() {
  const store = new Map();
  const counters = { writes: 0, reads: 0 };

  const request = (action) => {
    const req = {};
    // Обработчики назначаются вызывающей стороной после создания запроса,
    // поэтому вызов откладывается до следующего оборота очереди.
    setTimeout(() => {
      const value = action();
      req.result = value;
      if (req.onsuccess) { req.onsuccess(); }
    }, 0);
    return req;
  };

  return {
    counters,
    db: {
      objectStoreNames: { contains: () => true },
      createObjectStore() {},
      transaction: () => ({
        objectStore: () => ({
          put(value, key) {
            counters.writes += 1;
            // Копия, как при настоящей записи: хранилище не держит ссылку
            // на живой объект, и слепок должен вести себя так же.
            return request(() => store.set(key, JSON.parse(JSON.stringify(value))));
          },
          get(key) {
            counters.reads += 1;
            return request(() => store.get(key));
          }
        })
      })
    }
  };
}

/**
 * Загружает мобильную серверную часть с подменённым хранилищем.
 *
 * @returns {Promise<object>} доступ к запросам и счётчикам
 */
function load() {
  const storage = makeStorage();

  const sandbox = { console, Math, Date, JSON, Promise, setTimeout, clearTimeout };
  sandbox.window = {
    indexedDB: {
      open() {
        const req = {};
        // Обработчик читает request.result, поэтому база назначается до
        // вызова: подделка должна повторять порядок настоящего хранилища.
        setTimeout(() => {
          req.result = storage.db;
          if (req.onupgradeneeded) { req.onupgradeneeded(); }
          if (req.onsuccess) { req.onsuccess(); }
        }, 0);
        return req;
      }
    },
    OracleSafety: { check: () => ({ verdict: 'allow' }) },
    navigator: { language: 'ru' },
    setTimeout,
    clearTimeout
  };
  sandbox.window.window = sandbox.window;
  sandbox.global = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'static', 'js', 'local-api.js'), 'utf8'),
    sandbox, { filename: 'local-api.js' });

  const api = sandbox.window.LocalAPI;
  if (!api) { throw new Error('local-api.js не выставил LocalAPI'); }

  // Готовность хранилища: несколько оборотов очереди задач.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  return api.init().then(settle).then(() => ({
    counters: storage.counters,

    /**
     * Подставляет модуль выполнения модели с заданным состоянием.
     *
     * @param {string|null} state состояние или null, чтобы убрать модуль
     */
    setLLM(state) {
      if (state === null) {
        delete sandbox.window.LocalLLM;
        return;
      }
      sandbox.window.LocalLLM = {
        status: () => state,
        reason: () => (state === 'failed' ? 'проверочная причина' : '')
      };
    },

    request: (method, url, body) =>
      api.handle(url, { method, body: body ? JSON.stringify(body) : undefined })
        .then((value) => settle().then(() => value)),
    dump: () => JSON.stringify(api.dump())
  }));
}

/** Читающие запросы, которые делает интерфейс при каждом обновлении. */
const READS = [
  ['GET', '/api/tasks/'],
  ['GET', '/api/garden/'],
  ['GET', '/api/shop/'],
  ['GET', '/api/settings/'],
  ['GET', '/api/oracle/'],
  ['GET', '/api/priorities/'],
  ['GET', '/api/stats/monthly'],
  ['GET', '/api/health']
];

async function main() {
  const api = await load();

  console.log('\n  Чтение не пишет в хранилище');
  {
    // Один квест, чтобы журнал не был пустым.
    await api.request('POST', '/api/tasks/', {
      title: 'Проверка', estimated_hours: 2, priority: 'normal'
    });

    const before = api.counters.writes;
    for (const [method, url] of READS) {
      await api.request(method, url);
    }
    expect('записей после ' + READS.length + ' чтений',
      api.counters.writes - before, 0);
  }

  console.log('\n  Чтение не меняет состояние');
  {
    for (const [method, url] of READS) {
      const before = api.dump();
      await api.request(method, url);
      const ok = api.dump() === before;
      if (!ok) { failures += 1; }
      console.log('    %s %s %s', ok ? '✓' : '✗', method, url);
    }
  }

  console.log('\n  Изменение пишет ровно один раз');
  {
    const cases = [
      ['POST', '/api/tasks/', { title: 'Второй', estimated_hours: 1, priority: 'high' }],
      ['PATCH', '/api/settings/', { theme: 'light' }]
    ];
    for (const [method, url, body] of cases) {
      const before = api.counters.writes;
      await api.request(method, url, body);
      expect(method + ' ' + url, api.counters.writes - before, 1);
    }
  }

  console.log('\n  Состояние модели берётся у модуля выполнения');
  {
    // Выпуск с моделью подключает модуль local-llm.js, выпуск без неё —
    // нет. Маршрут состояния обязан отражать это, а не отвечать заранее
    // известным значением: именно так в 2.0.0 приложение с загруженной
    // моделью сообщало в шапке «модель не найдена».
    const cases = [
      { title: 'модуля нет (выпуск без модели)', llm: null,
        expectAvailable: false, expectStatus: 'absent' },
      { title: 'модуль загружает веса', llm: 'loading',
        expectAvailable: false, expectStatus: 'loading' },
      { title: 'модель готова', llm: 'ready',
        expectAvailable: true, expectStatus: 'ready' },
      { title: 'загрузка не удалась', llm: 'failed',
        expectAvailable: false, expectStatus: 'failed' }
    ];

    for (const item of cases) {
      api.setLLM(item.llm);
      const health = await api.request('GET', '/api/health');
      const ok = health.llm_available === item.expectAvailable
        && health.llm_status === item.expectStatus;
      if (!ok) { failures += 1; }
      console.log('    %s %s → llm_available=%s, llm_status=%s',
        ok ? '✓' : '✗', item.title, health.llm_available, health.llm_status);
    }

    api.setLLM(null);
  }

  console.log('\n  Записанное переживает перезагрузку');
  {
    const saved = api.dump();
    expect('состояние непусто', saved.length > 100, true);
  }

  if (failures) {
    console.error('\n  НЕСОВПАДЕНИЙ: ' + failures + '\n');
    process.exit(1);
  }
  console.log('\n  МОБИЛЬНАЯ СЕРВЕРНАЯ ЧАСТЬ ВЕДЁТ СЕБЯ КАК ЗАДУМАНО\n');
}

main().catch((error) => {
  console.error('\n  Стенд не отработал:', error);
  process.exit(1);
});
