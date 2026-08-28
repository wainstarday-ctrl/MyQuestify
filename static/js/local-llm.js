/**
 * MyQuestify — выполнение языковой модели в мобильной сборке.
 *
 * В мобильной версии нет Python, а значит и llama-cpp-python. Единственный
 * способ выполнить модель, не написав отдельное дополнение к оболочке на
 * C++ и Java, — взять сборку llama.cpp для WebAssembly и запустить её в том
 * же окружении, где работает интерфейс.
 *
 * Плата за это существенна и должна быть названа:
 *
 *   * скорость ниже собственной сборки в три-пять раз: WebAssembly не
 *     использует расширенные наборы команд процессора;
 *   * модель целиком держится в памяти вкладки, и при её нехватке система
 *     закрывает приложение без предупреждения;
 *   * доступная память ограничена четырьмя гигабайтами по устройству
 *     WebAssembly, а на практике заметно меньше.
 *
 * Поэтому модуль отказывается загружать модель на устройствах, не
 * отвечающих требованиям, а при любой неудаче возвращает управление
 * заготовленным фразам. Приложение обязано работать без модели: она
 * улучшение, а не условие работоспособности.
 *
 * Экспортирует `window.LocalLLM`.
 */
(function (global) {
  'use strict';

  /**
   * Наименьший объём памяти устройства, при котором имеет смысл пробовать.
   *
   * Модель на полмиллиарда параметров в четырёхбитном представлении
   * занимает около 400 МБ под веса, плюс контекст и исполняющая среда.
   * Android отдаёт приложению примерно 45 % памяти устройства, поэтому при
   * четырёх гигабайтах остаётся около 1.8 ГБ — с запасом, но без роскоши.
   */
  var MIN_DEVICE_MEMORY_GB = 4;

  /** Размер окна контекста. Больше — заметно дороже по памяти. */
  var CONTEXT_SIZE = 1024;

  /** Предел длины ответа. Короткие ответы и задуманы, и быстрее считаются. */
  var MAX_TOKENS = 96;

  var engine = null;
  var loading = null;
  var status = 'idle';
  var lastError = '';

  /**
   * Проверяет, стоит ли пытаться загрузить модель на этом устройстве.
   *
   * Проверка выполняется до загрузки: попытка на слабом устройстве
   * заканчивается не сообщением об ошибке, а закрытием приложения системой,
   * и пользователь остаётся без объяснения.
   *
   * @returns {{ok: boolean, reason: string}}
   */
  function checkDevice() {
    if (typeof WebAssembly === 'undefined') {
      return { ok: false, reason: 'WebAssembly не поддерживается' };
    }

    var memory = global.navigator && global.navigator.deviceMemory;
    if (memory && memory < MIN_DEVICE_MEMORY_GB) {
      return {
        ok: false,
        reason: 'памяти устройства недостаточно: ' + memory +
                ' ГБ при необходимых ' + MIN_DEVICE_MEMORY_GB
      };
    }

    // Отсутствие сведений о памяти не считается отказом: часть браузеров их
    // не сообщает, и запрет по этому признаку отсёк бы исправные
    // устройства. Риск принимается сознательно.
    return { ok: true, reason: '' };
  }

  /**
   * Загружает библиотеку выполнения и веса.
   *
   * Файлы берутся из состава приложения: выпуск с моделью содержит их
   * рядом с интерфейсом. Загрузка по сети здесь неуместна — приложение
   * заявлено как работающее без сети.
   *
   * @returns {Promise<Object|null>} готовый исполнитель либо null
   */
  function load() {
    if (engine) { return Promise.resolve(engine); }
    if (loading) { return loading; }

    var device = checkDevice();
    if (!device.ok) {
      status = 'unsupported';
      lastError = device.reason;
      return Promise.resolve(null);
    }

    status = 'loading';

    loading = import('./vendor/wllama/index.js')
      .then(function (module) {
        var Wllama = module.Wllama;
        if (!Wllama) {
          throw new Error('в модуле нет ожидаемого класса Wllama');
        }

        var runtime = new Wllama({
          'single-thread/wllama.wasm': 'static/js/vendor/wllama/single-thread/wllama.wasm',
          'multi-thread/wllama.wasm': 'static/js/vendor/wllama/multi-thread/wllama.wasm'
        });

        return runtime.loadModelFromUrl('static/models/model.gguf', {
          n_ctx: CONTEXT_SIZE,
          // Число потоков не задаётся: библиотека выбирает его сама по
          // числу ядер, а на телефоне избыточный параллелизм лишь
          // разогревает устройство без выигрыша в скорости.
          allowOffline: true
        }).then(function () {
          engine = runtime;
          status = 'ready';
          return runtime;
        });
      })
      .catch(function (error) {
        // Неудача загрузки не должна прерывать работу приложения: оно
        // рассчитано на отсутствие модели и перейдёт к заготовленным
        // фразам, как в настольной версии без весов.
        status = 'failed';
        lastError = error && error.message ? error.message : String(error);
        if (global.console) {
          global.console.warn('MyQuestify: модель не загружена —', lastError);
        }
        engine = null;
        return null;
      })
      .then(function (result) {
        loading = null;
        return result;
      });

    return loading;
  }

  /**
   * Собирает промпт в разметке ChatML.
   *
   * Разметка соответствует семейству Qwen, к которому принадлежит
   * используемая модель. В отличие от настольной версии автоопределение
   * здесь не нужно: веса поставляются вместе с приложением, и их формат
   * известен заранее.
   *
   * @param {string} system системная инструкция
   * @param {string} user реплика пользователя
   * @returns {string}
   */
  function buildPrompt(system, user) {
    return '<|im_start|>system\n' + system + '<|im_end|>\n' +
           '<|im_start|>user\n' + user + '<|im_end|>\n' +
           '<|im_start|>assistant\n';
  }

  /**
   * Очищает ответ от служебных меток и обрезает до одной мысли.
   *
   * @param {string} raw ответ модели
   * @returns {string}
   */
  function postprocess(raw) {
    var text = String(raw || '').trim();

    ['<|im_end|>', '<|im_start|>', '</s>', '<|endoftext|>'].forEach(function (marker) {
      text = text.split(marker)[0];
    });

    // Модель такого размера склонна продолжать диалог за пользователя,
    // поэтому вывод обрезается по первому переводу строки.
    text = text.split('\n')[0].trim();
    text = text.replace(/^["'«»\s]+|["'«»\s]+$/g, '');

    return text;
  }

  /**
   * Проверяет, что ответ написан на ожидаемом языке.
   *
   * Модели, дообученные под один язык, отвечают на нём даже при инструкции
   * на другом. Проверка по доле кириллицы среди букв достаточна для пары
   * «русский и английский».
   *
   * @param {string} text ответ
   * @param {string} language ожидаемый язык
   * @returns {boolean}
   */
  function matchesLanguage(text, language) {
    var letters = text.replace(/[^\p{L}]/gu, '');
    if (letters.length < 8) { return true; }

    var cyrillic = (letters.match(/[\u0400-\u04FF]/g) || []).length;
    var share = cyrillic / letters.length;
    return language === 'ru' ? share > 0.5 : share < 0.25;
  }

  global.LocalLLM = {
    /**
     * Готовит модель к работе.
     *
     * Вызывается не при запуске приложения, а при первом обращении к
     * генерации: загрузка занимает секунды и удерживает сотни мегабайт,
     * и платить за это до того, как пользователь захотел ответ, незачем.
     *
     * @returns {Promise<boolean>} доступна ли модель
     */
    prepare: function () {
      return load().then(function (result) { return Boolean(result); });
    },

    /** Состояние: idle, loading, ready, failed, unsupported. */
    status: function () { return status; },

    /** Причина отказа, если модель недоступна. */
    reason: function () { return lastError; },

    /** Отвечает ли устройство требованиям. */
    isSupported: function () { return checkDevice().ok; },

    /**
     * Порождает текст по инструкции.
     *
     * @param {string} system системная инструкция
     * @param {string} user реплика пользователя
     * @param {Object} [options] language — ожидаемый язык ответа
     * @returns {Promise<?string>} текст либо null, если модель недоступна
     *     или ответ не прошёл проверку
     */
    generate: function (system, user, options) {
      var opts = options || {};
      var language = opts.language || 'ru';

      return load().then(function (runtime) {
        if (!runtime) { return null; }

        return runtime.createCompletion(buildPrompt(system, user), {
          nPredict: opts.maxTokens || MAX_TOKENS,
          sampling: {
            temp: opts.temperature || 0.4,
            top_p: 0.9,
            // Наказание за повтор существенно для малых моделей: без него
            // они зацикливаются на одной фразе.
            penalty_repeat: 1.15
          }
        });
      }).then(function (raw) {
        if (raw === null || raw === undefined) { return null; }

        var text = postprocess(raw);
        if (!text) { return null; }

        if (!matchesLanguage(text, language)) {
          // Ответ на чужом языке выглядит сбоем даже когда осмыслен,
          // поэтому передаётся управление заготовленным фразам.
          return null;
        }
        return text;
      }).catch(function (error) {
        if (global.console) {
          global.console.warn('MyQuestify: генерация не удалась —', error);
        }
        return null;
      });
    },

    /**
     * Освобождает память.
     *
     * Вызывается при уходе приложения в фон: удерживать сотни мегабайт,
     * пока приложение не на экране, — верный способ быть закрытым системой.
     */
    release: function () {
      if (engine && typeof engine.exit === 'function') {
        try { engine.exit(); } catch (error) { /* уже освобождена */ }
      }
      engine = null;
      status = 'idle';
    }
  };

  // Прогрев после запуска приложения.
  //
  // Загрузка весов занимает секунды и заметно нагружает телефон, поэтому
  // при первом обращении к оракулу пользователь ждал бы молча, не понимая,
  // работает ли модель вообще. Прогрев переносит ожидание на время, когда
  // человек только осматривается: шапка при этом показывает «модель
  // загружается», и состояние видно с самого начала.
  //
  // Задержка отмеряется от завершения загрузки страницы, чтобы прогрев не
  // соперничал за память и время с построением интерфейса и первой сцены.
  // Отдельная проверка на уход в фон не нужна: release() освобождает
  // память, а следующий вызов generate() загрузит веса заново.
  var WARMUP_DELAY_MS = 2000;

  function scheduleWarmup() {
    global.setTimeout(function () {
      if (status === 'idle') { load(); }
    }, WARMUP_DELAY_MS);
  }

  if (global.document && global.document.readyState === 'complete') {
    scheduleWarmup();
  } else {
    global.addEventListener('load', scheduleWarmup);
  }
}(window));
