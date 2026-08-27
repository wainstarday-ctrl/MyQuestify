/**
 * MyQuestify — локальная реализация серверной части.
 *
 * Модуль повторяет поведение маршрутов FastAPI средствами браузера и
 * принимает те же адреса с теми же телами запросов. Это позволяет одному и
 * тому же интерфейсу работать в двух режимах:
 *
 *   * настольном  — запросы уходят к серверу на Python;
 *   * мобильном   — обрабатываются здесь, без сервера вообще.
 *
 * Подмена выполняется на уровне единственной функции `api.request`, поэтому
 * остальной код приложения о режиме не знает и не меняется. Совпадение форм
 * ответов существенно: любое расхождение проявилось бы не сразу, а на
 * отдельном экране, и искать его пришлось бы вручную.
 *
 * Хранилище устроено как набор коллекций, сохраняемых целиком. Для личного
 * трекера с сотнями записей этого достаточно, а полноценные хранилища
 * IndexedDB с индексами потребовали бы схемы, миграций и асинхронных
 * курсоров ради выигрыша, которого на таких объёмах не возникает.
 *
 * Экспортирует `window.LocalAPI`.
 *
 * Порядок изложения
 * -----------------
 * 1. Постоянные величины и каталог сцен — SCENES дублирует
 *    `app/config.py`, потому что Python в мобильной сборке нет.
 *    Совпадение двух каталогов проверяется tests/test_scene_catalog.py.
 * 2. Хранилище: открытие базы, чтение и запись состояния одним объектом.
 * 3. Правила предметной области — награда, штраф, уровень сцены; те же,
 *    что на сервере.
 * 4. Таблица маршрутов ROUTES: метод, образец пути, обработчик.
 * 5. Точка входа handle — разбор запроса, поиск маршрута, сохранение.
 *    Сохранение выполняется только после изменяющих запросов; проверяется
 *    в tools/check_local_api.js.
 */
(function (global) {
  'use strict';

  /** Имя базы и версия схемы хранилища. */
  var DB_NAME = 'myquestify';
  var DB_VERSION = 1;
  var STORE = 'state';

  /** Ключи экономики. Должны совпадать с app/config.py. */
  var TOKENS_PER_HOUR = 10;
  var PENALTY_RATE = 0.5;
  var PENALTY_GRACE_MINUTES = 15;
  var TASKS_PER_TREE_LEVEL = 3;
  var MAX_TREE_LEVEL = 10;
  var DEFAULT_SCENE = 'garden';

  var PRIORITIES = {
    low: { reward: 0.8, order: 3 },
    normal: { reward: 1.0, order: 2 },
    high: { reward: 1.5, order: 1 }
  };

  /**
   * Каталог сцен. Дублирует app/config.py.
   *
   * Дублирование осознанное: мобильная сборка не содержит Python, и
   * единственный способ иметь общий источник — генерировать этот файл при
   * сборке. Для десяти записей, меняющихся редко, генератор дороже сверки.
   *
   * Расхождение этого списка с app/config.py — молчаливая неполадка: на
   * телефоне сцена просто не появляется в перечне, и понять это можно лишь
   * пересчитав вкладки на устройстве. Поэтому совпадение проверяется
   * автоматически: tests/test_scene_catalog.py разбирает оба источника и
   * сверяет ключи, порядок, цены и названия.
   */
  var SCENES = [
    { key: 'garden', price: 0,
      title: { ru: 'Сад Вдумчивости',
               en: 'Garden of Reflection' },
      tagline: { ru: 'Дерево растёт вместе с тобой',
                 en: 'The tree grows along with you' },
      description: { ru: 'Нажми на крону — посыплются плоды. Их можно ловить и бросать.',
                     en: 'Tap the crown and fruit will fall. You can catch and throw it.' } },
    { key: 'volcano', price: 300,
      title: { ru: 'Жерло Решимости',
               en: 'Crater of Resolve' },
      tagline: { ru: 'Держи нажатие — пойдёт лава',
                 en: 'Hold the press and lava flows' },
      description: { ru: 'Долгое нажатие на кратер запускает поток лавы, который стекает по склону и остывает.',
                     en: 'A long press on the crater starts a lava flow that runs down the slope and cools.' } },
    { key: 'clockwork', price: 450,
      title: { ru: 'Механизм Времени',
               en: 'Clockwork of Time' },
      tagline: { ru: 'Малое колесо движет большое',
                 en: 'A small wheel drives a large one' },
      description: { ru: 'Сцепленные шестерни часовой башни. Крутани маленькую — большие пойдут тяжело и медленно; раскрути большую — мелкие завертятся вихрем.',
                     en: 'Meshed gears of a clock tower. Spin the small one and the large ones turn slowly; spin the large one and the small ones race.' } },
    { key: 'cosmos', price: 600,
      title: { ru: 'Орбиты Замысла',
               en: 'Orbits of Intent' },
      tagline: { ru: 'Планеты держат орбиту',
                 en: 'Planets keep their orbits' },
      description: { ru: 'Планеты можно перетаскивать и менять местами, но каждая возвращается на свою орбиту.',
                     en: 'Planets can be dragged and swapped, but each returns to its own orbit.' } },
    { key: 'pond', price: 750,
      title: { ru: 'Пруд Безмолвия',
               en: 'Pond of Silence' },
      tagline: { ru: 'Вода помнит каждое касание',
                 en: 'Water remembers every touch' },
      description: { ru: 'Кувшинки покачиваются на воде. Проведи по глади рукой — волны разойдутся кругами и оттолкнут листья к берегам.',
                     en: 'Lily pads drift on the surface. Sweep your hand across the water and ripples push the leaves toward the banks.' } },
    { key: 'desk', price: 900,
      title: { ru: 'Стол Черновиков',
               en: 'Desk of Drafts' },
      tagline: { ru: 'Чем выше уровень, тем больше вещей',
                 en: 'The higher the level, the more objects' },
      description: { ru: 'На столе лежат предметы: их можно расшвыривать, ронять и складывать обратно.',
                     en: 'Objects lie on the desk: scatter them, drop them and pile them back up.' } },
    { key: 'weave', price: 1200,
      title: { ru: 'Плетение Смыслов',
               en: 'Weave of Meanings' },
      tagline: { ru: 'Потяни за нить — отзовётся вся сеть',
                 en: 'Pull one thread and the whole net answers' },
      description: { ru: 'Светящиеся узлы связаны упругими нитями и дрейфуют в невесомости. Потяни за один — сеть растянется, воспротивится и спружинит обратно в равновесие.',
                     en: 'Glowing nodes are linked by elastic threads and drift weightlessly. Pull one and the net stretches, resists and springs back into balance.' } },
    { key: 'campfire', price: 1500,
      title: { ru: 'Лагерь Уединения',
               en: 'Camp of Solitude' },
      tagline: { ru: 'Искры летят вверх',
                 en: 'Sparks rise upward' },
      description: { ru: 'Костёр в темноте: искры рождаются внизу и уходят вверх, закручиваясь вихрем за курсором. Подбрасывай поленья — пламя разгорается сильнее.',
                     en: 'A fire in the dark: sparks are born below and drift up, swirling after the cursor. Toss in logs and the flame grows.' } },
    { key: 'clouds', price: 1800,
      title: { ru: 'Облака Вдохновения',
               en: 'Clouds of Inspiration' },
      tagline: { ru: 'Солнце в твоих руках',
                 en: 'The sun in your hands' },
      description: { ru: 'Облака плывут по небу и возвращаются с другого края. Нажми на облако — соберётся туча и пойдёт дождь, а от частых нажатий ударит молния. Перетащи солнце — сменится время суток.',
                     en: 'Clouds drift across the sky and return from the other side. Tap a cloud and it gathers into a storm; press repeatedly and lightning strikes. Drag the sun to change the time of day.' } },
    { key: 'lab', price: 2000,
      title: { ru: 'Лаборатория Идей',
               en: 'Laboratory of Ideas' },
      tagline: { ru: 'Смешивай — получится третье',
                 en: 'Mix two and get a third' },
      description: { ru: 'Колбы с растворами на лабораторном столе. Возьми любую, наклони клавишами поворота — жидкость польётся. Попадёт в другую колбу — цвета смешаются.',
                     en: 'Flasks of reagents on a lab bench. Pick one up, tilt it with the rotation keys and pour. Hit another flask and the reagents react.' } }
  ];

  /**
   * Резервные фразы. На устройстве без языковой модели они становятся
   * единственным источником текста, поэтому набор шире, чем на настольной
   * версии, где модель обычно доступна.
   */
  var PHRASES = {
    ru: [
      'Один шаг сегодня стоит десяти планов на завтра.',
      'Начни с малого — импульс сделает остальное.',
      'Сосредоточенность важнее скорости. Ты справишься.',
      'Каждый завершённый час — это выросшая ветка твоего сада.',
      'Сложное становится простым, когда за него берёшься.',
      'Не жди вдохновения — оно приходит по ходу работы.',
      'Разбей на части — и половина страха исчезнет.',
      'Сделанное несовершенно лучше задуманного идеально.',
      'Время идёт в любом случае. Пусть идёт в твою сторону.',
      'Начало трудно только один раз.'
    ],
    en: [
      'One step today is worth ten plans for tomorrow.',
      'Start small — momentum will do the rest.',
      'Focus matters more than speed. You will manage.',
      'Every finished hour is a branch grown in your garden.',
      'The difficult becomes simple once you take it on.',
      'Do not wait for inspiration — it arrives along the way.',
      'Break it apart and half the fear disappears.',
      'Done imperfectly beats planned perfectly.',
      'Time passes either way. Let it pass in your favour.',
      'The beginning is hard only once.'
    ]
  };

  var db = null;
  var state = null;

  // --------------------------------------------------------------- хранилище

  /**
   * Открывает базу браузера.
   *
   * IndexedDB используется как простое хранилище пар «ключ — значение»:
   * коллекции сохраняются целиком. При отсутствии IndexedDB работа
   * продолжается в памяти — данные теряются при закрытии, но приложение
   * остаётся работоспособным, что важнее для проверки на незнакомом
   * устройстве.
   *
   * @returns {Promise<Object|null>}
   */
  function openDatabase() {
    return new Promise(function (resolve) {
      if (!global.indexedDB) { resolve(null); return; }

      var request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
    });
  }

  /**
   * Читает значение по ключу.
   * @param {string} key
   * @returns {Promise<*>}
   */
  function read(key) {
    return new Promise(function (resolve) {
      if (!db) { resolve(null); return; }
      var request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
    });
  }

  /**
   * Записывает значение по ключу.
   * @param {string} key
   * @param {*} value
   * @returns {Promise<void>}
   */
  function write(key, value) {
    return new Promise(function (resolve) {
      if (!db) { resolve(); return; }
      var request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
      request.onsuccess = function () { resolve(); };
      request.onerror = function () { resolve(); };
    });
  }

  /** Сохраняет всё состояние. */
  function persist() {
    return write('state', state);
  }

  /** Возвращает состояние по умолчанию для первого запуска. */
  function blankState() {
    return {
      nextTaskId: 1,
      nextThoughtId: 1,
      nextMessageId: 1,
      tokens: 0,
      tasks: [],
      thoughts: [],
      oracle: [],
      unlocks: [DEFAULT_SCENE],
      garden: { tree_level: 1, active_scene: DEFAULT_SCENE, bg_image_path: null },
      settings: {
        theme: 'dark',
        language: 'ru',
        notifications_enabled: true,
        notify_lead_minutes: 60,
        reduce_motion: false,
        show_hints: true,
        rotate_ccw_key: 'KeyQ',
        rotate_cw_key: 'KeyE'
      }
    };
  }

  // ------------------------------------------------------------ вспомогательное

  function nowIso() { return new Date().toISOString(); }

  /** Награда с учётом приоритета. Округление вверх, как на сервере. */
  function calcReward(hours, priority) {
    var meta = PRIORITIES[priority] || PRIORITIES.normal;
    return Math.round(hours * TOKENS_PER_HOUR * meta.reward);
  }

  /** Штраф — половина награды. */
  function calcPenalty(task) {
    return Math.max(0, Math.min(Math.round(task.reward * PENALTY_RATE), task.reward));
  }

  /** Просрочен ли открытый квест. */
  function isOverdue(task) {
    if (!task.deadline || task.status !== 'pending') { return false; }
    return new Date(task.deadline).getTime() < Date.now();
  }

  /** Приводит запись к форме, которую отдаёт сервер. */
  function serializeTask(task) {
    return {
      id: task.id,
      title: task.title,
      estimated_hours: task.estimated_hours,
      reward: task.reward,
      status: task.status,
      motivation: task.motivation,
      created_at: task.created_at,
      deadline: task.deadline,
      completed_at: task.completed_at || null,
      is_overdue: isOverdue(task),
      priority: task.priority || 'normal',
      penalty: task.penalty || 0
    };
  }

  /** Пересчитывает уровень сцены от числа завершённых квестов. */
  function recalcLevel() {
    var done = state.tasks.filter(function (task) {
      return task.status === 'completed';
    }).length;
    state.garden.tree_level = Math.min(
      MAX_TREE_LEVEL, 1 + Math.floor(done / TASKS_PER_TREE_LEVEL)
    );
    return state.garden.tree_level;
  }

  /** Локализованное поле каталога. */
  function pick(value) {
    var language = state.settings.language || 'ru';
    return value[language] || value.ru;
  }

  /** Витрина сцен в форме ответа сервера. */
  function sceneCatalog() {
    return SCENES.map(function (scene) {
      return {
        key: scene.key,
        title: pick(scene.title),
        tagline: pick(scene.tagline),
        description: pick(scene.description),
        price: scene.price,
        owned: scene.price === 0 || state.unlocks.indexOf(scene.key) !== -1,
        active: scene.key === state.garden.active_scene
      };
    });
  }

  /** Случайная фраза на языке интерфейса. */
  function phrase() {
    var list = PHRASES[state.settings.language] || PHRASES.ru;
    return list[Math.floor(Math.random() * list.length)];
  }

  /**
   * Системные инструкции для модели.
   *
   * Повторяют настольные, но короче: модель на полмиллиарда параметров
   * теряет нить длинной инструкции, а каждый лишний токен в промпте
   * заметно замедляет ответ на телефоне.
   */
  var PROMPTS = {
    motivation: {
      ru: 'Ты краткий наставник. Ответь ОДНОЙ мотивирующей фразой на русском. Не более 15 слов.',
      en: 'You are a brief mentor. Reply with ONE motivating sentence in English. No more than 15 words.'
    },
    oracle: {
      ru: 'Ты Оракул, голос древнего мыслителя. Отвечай по-русски, спокойно, не более двух предложений. Возвращай собеседника к посильному шагу.',
      en: 'You are the Oracle, voice of an ancient thinker. Answer in English, calmly, no more than two sentences. Return your companion to a manageable step.'
    }
  };

  /**
   * Порождает текст моделью, если она доступна.
   *
   * Возвращает заготовленную фразу при любой неудаче: отсутствие модели,
   * отказ устройства по памяти, ошибка вычисления. Приложение обязано
   * работать без модели, поэтому вызывающий код о её наличии не знает.
   *
   * @param {string} kind motivation или oracle
   * @param {string} input текст запроса
   * @returns {Promise<string>} непустой текст
   */
  function generate(kind, input) {
    var language = state.settings.language || 'ru';

    if (!global.LocalLLM) { return Promise.resolve(phrase()); }

    return global.LocalLLM.generate(
      PROMPTS[kind][language] || PROMPTS[kind].ru,
      input,
      { language: language, temperature: kind === 'oracle' ? 0.7 : 0.5 }
    ).then(function (text) {
      return text || phrase();
    });
  }

  /**
   * Применяет штрафы за просрочку.
   *
   * Логика повторяет серверную: отсрочка в четверть часа, баланс не уходит
   * в минус, повторно один квест не штрафуется.
   *
   * @returns {Object} тело ответа маршрута проверки просрочки
   */
  function sweepOverdue() {
    var cutoff = Date.now() - PENALTY_GRACE_MINUTES * 60000;
    var failed = [];
    var lost = 0;

    state.tasks.forEach(function (task) {
      if (task.status !== 'pending' || !task.deadline) { return; }
      if (new Date(task.deadline).getTime() > cutoff) { return; }

      var penalty = Math.max(0, Math.min(calcPenalty(task), state.tokens - lost));
      task.status = 'failed';
      task.failed_at = nowIso();
      task.penalty = penalty;
      lost += penalty;
      failed.push({ task_id: task.id, title: task.title, penalty: penalty });
    });

    if (failed.length) {
      state.tokens = Math.max(0, state.tokens - lost);
    }
    return { failed: failed, focus_tokens: state.tokens, tokens_lost: lost };
  }

  /** Строит дерево мыслей из плоского списка. */
  function thoughtTree(taskId, parentId) {
    return state.thoughts
      .filter(function (node) {
        return node.task_id === taskId && node.parent_id === (parentId || null);
      })
      .map(function (node) {
        return {
          id: node.id,
          task_id: node.task_id,
          parent_id: node.parent_id,
          text: node.text,
          done: node.done,
          generated: node.generated,
          children: thoughtTree(taskId, node.id)
        };
      });
  }

  /** Удаляет узел вместе с потомками. */
  function dropThought(id) {
    var children = state.thoughts.filter(function (node) {
      return node.parent_id === id;
    });
    children.forEach(function (child) { dropThought(child.id); });
    state.thoughts = state.thoughts.filter(function (node) { return node.id !== id; });
  }

  // ------------------------------------------------------------ маршрутизация

  /**
   * Таблица обработчиков. Ключ — метод и образец адреса, где `:id`
   * обозначает числовой параметр.
   */
  var ROUTES = [
    ['GET', '/api/health', function () {
      return { status: 'ok', version: 'mobile', frozen: false,
               llm_available: false, data_dir: 'browser' };
    }],

    ['GET', '/api/tasks/', function () {
      var order = { high: 1, normal: 2, low: 3 };
      return state.tasks.slice().sort(function (a, b) {
        // Порядок совпадает с серверным. Вниз уходит только завершённое:
        // просроченный квест можно доделать, и в конце списка он был бы
        // забыт.
        var doneA = a.status === 'completed' ? 1 : 0;
        var doneB = b.status === 'completed' ? 1 : 0;
        if (doneA !== doneB) { return doneA - doneB; }

        var prioA = order[a.priority || 'normal'];
        var prioB = order[b.priority || 'normal'];
        if (prioA !== prioB) { return prioA - prioB; }

        if (Boolean(a.deadline) !== Boolean(b.deadline)) { return a.deadline ? -1 : 1; }
        if (a.deadline && b.deadline && a.deadline !== b.deadline) {
          return a.deadline < b.deadline ? -1 : 1;
        }
        return b.created_at < a.created_at ? -1 : 1;
      }).map(serializeTask);
    }],

    ['POST', '/api/tasks/', function (body) {
      var task = {
        id: state.nextTaskId++,
        title: String(body.title || '').trim(),
        estimated_hours: body.estimated_hours,
        priority: body.priority || 'normal',
        deadline: body.deadline || null,
        status: 'pending',
        motivation: '',
        created_at: nowIso(),
        completed_at: null,
        penalty: 0
      };
      task.reward = calcReward(task.estimated_hours, task.priority);
      state.tasks.push(task);

      var label = (state.settings.language === 'en') ? 'Task' : 'Задача';
      return generate('motivation', label + ': ' + task.title)
        .then(function (text) {
          task.motivation = text;
          return serializeTask(task);
        });
    }],

    ['PATCH', '/api/tasks/:id/complete', function (body, params) {
      var task = findTask(params.id);
      if (!task) { throw httpError(404, 'Квест не найден'); }
      if (task.status === 'completed') { throw httpError(409, 'Квест уже завершён'); }

      var earned = calcReward(task.estimated_hours, task.priority);
      task.status = 'completed';
      task.completed_at = nowIso();
      task.reward = earned;
      state.tokens += earned;

      return {
        task: serializeTask(task),
        focus_tokens: state.tokens,
        tokens_earned: earned,
        tree_level: recalcLevel()
      };
    }],

    ['PATCH', '/api/tasks/:id', function (body, params) {
      var task = findTask(params.id);
      if (!task) { throw httpError(404, 'Квест не найден'); }
      if (task.status === 'completed') {
        throw httpError(409, 'Завершённый квест изменить нельзя');
      }

      if (body.title !== undefined && body.title !== null) {
        task.title = String(body.title).trim();
      }
      if (body.estimated_hours !== undefined && body.estimated_hours !== null) {
        task.estimated_hours = body.estimated_hours;
      }
      if (body.priority !== undefined && body.priority !== null) {
        task.priority = body.priority;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'deadline')) {
        task.deadline = body.deadline;
        var future = !body.deadline || new Date(body.deadline).getTime() > Date.now();
        if (future && task.status === 'failed') {
          task.status = 'pending';
          task.failed_at = null;
        }
      }
      task.reward = calcReward(task.estimated_hours, task.priority);
      return serializeTask(task);
    }],

    ['DELETE', '/api/tasks/:id', function (body, params) {
      var task = findTask(params.id);
      if (!task) { throw httpError(404, 'Квест не найден'); }

      state.thoughts = state.thoughts.filter(function (node) {
        return node.task_id !== task.id;
      });
      state.tasks = state.tasks.filter(function (item) { return item.id !== task.id; });
      recalcLevel();
      return null;
    }],

    ['POST', '/api/tasks/sweep_overdue', function () { return sweepOverdue(); }],

    ['GET', '/api/stats/monthly', function () {
      var buckets = {};
      state.tasks.forEach(function (task) {
        var moment = new Date(task.completed_at || task.created_at);
        var key = moment.getFullYear() + '-' + moment.getMonth();
        var bucket = buckets[key] || (buckets[key] = {
          completed: 0, failed: 0, pending: 0, earned: 0, lost: 0, hours: 0
        });

        if (task.status === 'completed') {
          bucket.completed += 1;
          bucket.earned += task.reward;
          bucket.hours += task.estimated_hours;
        } else if (task.status === 'failed') {
          bucket.failed += 1;
        } else {
          bucket.pending += 1;
        }
        bucket.lost += task.penalty || 0;
      });

      var stats = [];
      var cursor = new Date();
      for (var i = 0; i < 6; i += 1) {
        var key = cursor.getFullYear() + '-' + cursor.getMonth();
        var data = buckets[key] ||
          { completed: 0, failed: 0, pending: 0, earned: 0, lost: 0, hours: 0 };
        var closed = data.completed + data.failed;
        stats.unshift({
          year: cursor.getFullYear(),
          month: cursor.getMonth() + 1,
          completed: data.completed,
          failed: data.failed,
          pending: data.pending,
          earned: data.earned,
          lost: data.lost,
          hours: data.hours,
          rate: closed ? Math.round((100 * data.completed) / closed) : 0
        });
        cursor.setMonth(cursor.getMonth() - 1);
      }
      return stats;
    }],

    ['GET', '/api/garden/', function () {
      return {
        user_id: 1,
        bg_image_path: null,
        tree_level: state.garden.tree_level,
        focus_tokens: state.tokens,
        background_price: 100,
        active_scene: state.garden.active_scene,
        scenes: sceneCatalog()
      };
    }],

    ['GET', '/api/shop/', function () { return sceneCatalog(); }],

    ['POST', '/api/shop/:key/purchase', function (body, params) {
      var scene = SCENES.filter(function (item) { return item.key === params.key; })[0];
      if (!scene) { throw httpError(404, 'Сцена отсутствует в каталоге'); }
      if (scene.price === 0 || state.unlocks.indexOf(scene.key) !== -1) {
        throw httpError(409, 'Сцена уже доступна');
      }
      if (state.tokens < scene.price) {
        throw httpError(402, 'Недостаточно токенов: нужно ' + scene.price +
          ', доступно ' + state.tokens);
      }

      state.tokens -= scene.price;
      state.unlocks.push(scene.key);
      state.garden.active_scene = scene.key;

      return {
        focus_tokens: state.tokens,
        tokens_spent: scene.price,
        active_scene: scene.key,
        scenes: sceneCatalog()
      };
    }],

    ['PATCH', '/api/garden/scene/:key', function (body, params) {
      var scene = SCENES.filter(function (item) { return item.key === params.key; })[0];
      if (!scene) { throw httpError(404, 'Сцена отсутствует в каталоге'); }
      if (scene.price !== 0 && state.unlocks.indexOf(scene.key) === -1) {
        throw httpError(403, 'Сцена ещё не куплена');
      }

      state.garden.active_scene = scene.key;
      return { active_scene: scene.key, tree_level: state.garden.tree_level };
    }],

    ['GET', '/api/tasks/:id/thoughts', function (body, params) {
      return thoughtTree(params.id, null);
    }],

    ['POST', '/api/tasks/:id/thoughts', function (body, params) {
      var node = {
        id: state.nextThoughtId++,
        task_id: params.id,
        parent_id: body.parent_id || null,
        text: String(body.text || '').trim(),
        done: false,
        generated: false,
        created_at: nowIso()
      };
      state.thoughts.push(node);
      return {
        id: node.id, task_id: node.task_id, parent_id: node.parent_id,
        text: node.text, done: false, generated: false, children: []
      };
    }],

    ['POST', '/api/tasks/:id/thoughts/expand', function (body, params, query) {
      var task = findTask(params.id);
      if (!task) { throw httpError(404, 'Квест не найден'); }

      var parentId = query.parent_id ? parseInt(query.parent_id, 10) : null;
      var parent = state.thoughts.filter(function (node) {
        return node.id === parentId;
      })[0];
      var focus = parent ? parent.text : task.title;

      // Без языковой модели разбиение строится по шаблону, опирающемуся на
      // название шага: общие слова вроде «сделать первый шаг» не помогают.
      var steps = state.settings.language === 'en'
        ? ['Clarify what "' + focus.slice(0, 40) + '" means in practice',
           'Do the smallest piece from start to finish',
           'Check the result and note what is left']
        : ['Уточнить, что значит «' + focus.slice(0, 40) + '» на практике',
           'Сделать самый маленький кусок целиком',
           'Проверить результат и записать, что осталось'];

      return steps.map(function (text) {
        var node = {
          id: state.nextThoughtId++,
          task_id: params.id,
          parent_id: parentId,
          text: text,
          done: false,
          generated: true,
          created_at: nowIso()
        };
        state.thoughts.push(node);
        return {
          id: node.id, task_id: node.task_id, parent_id: node.parent_id,
          text: node.text, done: false, generated: true, children: []
        };
      });
    }],

    ['PATCH', '/api/thoughts/:id', function (body, params) {
      var node = state.thoughts.filter(function (item) {
        return item.id === params.id;
      })[0];
      if (!node) { throw httpError(404, 'Мысль не найдена'); }

      if (body.text !== undefined && body.text !== null) {
        node.text = String(body.text).trim();
      }
      if (body.done !== undefined && body.done !== null) { node.done = body.done; }

      return {
        id: node.id, task_id: node.task_id, parent_id: node.parent_id,
        text: node.text, done: node.done, generated: node.generated,
        children: thoughtTree(node.task_id, node.id)
      };
    }],

    ['DELETE', '/api/thoughts/:id', function (body, params) {
      dropThought(params.id);
      return null;
    }],

    ['GET', '/api/oracle/', function () { return state.oracle.slice(-40); }],

    ['POST', '/api/oracle/', function (body) {
      var language = state.settings.language || 'ru';
      var message = String(body.message || '').trim();

      state.oracle.push({
        id: state.nextMessageId++, role: 'user',
        content: message, created_at: nowIso()
      });

      // Проверка безопасности выполняется тем же кодом, что и на сервере:
      // модуль подключается отдельным файлом и одинаков в обоих режимах.
      var verdict = global.OracleSafety
        ? global.OracleSafety.screen(message, language)
        : { verdict: 'allow', reply: null };

      // Перехваченный защитой ответ выдаётся как есть: модель к нему
      // отношения не имеет, и обращаться к ней незачем.
      if (verdict.verdict !== 'allow') {
        state.oracle.push({
          id: state.nextMessageId++, role: 'oracle',
          content: verdict.reply, created_at: nowIso()
        });
        return { reply: verdict.reply, guarded: true };
      }

      return generate('oracle', message).then(function (reply) {
        // Готовый ответ проверяется повторно: модель может свернуть в
        // опасную тему сама, даже если вопрос был безобидным.
        var checked = global.OracleSafety
          ? global.OracleSafety.guard(reply, language)
          : reply;

        state.oracle.push({
          id: state.nextMessageId++, role: 'oracle',
          content: checked, created_at: nowIso()
        });
        return { reply: checked, guarded: checked !== reply };
      });
    }],

    ['DELETE', '/api/oracle/', function () { state.oracle = []; return null; }],

    ['GET', '/api/settings/', function () { return state.settings; }],

    ['PATCH', '/api/settings/', function (body) {
      Object.keys(body).forEach(function (key) {
        if (body[key] !== null && body[key] !== undefined &&
            Object.prototype.hasOwnProperty.call(state.settings, key)) {
          state.settings[key] = body[key];
        }
      });
      return state.settings;
    }],

    ['GET', '/api/priorities/', function () {
      var titles = {
        ru: { low: 'Спокойно', normal: 'Обычно', high: 'Срочно' },
        en: { low: 'Easy', normal: 'Normal', high: 'Urgent' }
      };
      var table = titles[state.settings.language] || titles.ru;
      return Object.keys(PRIORITIES)
        .sort(function (a, b) { return PRIORITIES[a].order - PRIORITIES[b].order; })
        .map(function (key) {
          return { key: key, title: table[key], reward_multiplier: PRIORITIES[key].reward };
        });
    }]
  ];

  function findTask(id) {
    return state.tasks.filter(function (task) { return task.id === id; })[0];
  }

  /**
   * Создаёт ошибку с кодом состояния, как её вернул бы сервер.
   * @param {number} status
   * @param {string} detail
   */
  function httpError(status, detail) {
    var error = new Error(detail);
    error.status = status;
    error.detail = detail;
    return error;
  }

  /**
   * Сопоставляет адрес с образцом маршрута.
   *
   * @param {string} pattern образец с параметрами вида `:id`
   * @param {string} path адрес запроса
   * @returns {?Object} значения параметров либо null
   */
  function match(pattern, path) {
    var expected = pattern.split('/');
    var actual = path.split('/');
    if (expected.length !== actual.length) { return null; }

    var params = {};
    for (var i = 0; i < expected.length; i += 1) {
      if (expected[i].charAt(0) === ':') {
        var name = expected[i].slice(1);
        var value = decodeURIComponent(actual[i]);
        // Числовые идентификаторы приводятся к числу: сравнение строки с
        // числом дало бы пустой результат там, где запись существует.
        params[name] = /^\d+$/.test(value) ? parseInt(value, 10) : value;
      } else if (expected[i] !== actual[i]) {
        return null;
      }
    }
    return params;
  }

  global.LocalAPI = {
    /**
     * Готовит хранилище к работе.
     *
     * @returns {Promise<Object>} само себя, для цепочки вызовов
     */
    init: function () {
      return openDatabase().then(function (database) {
        db = database;
        return read('state');
      }).then(function (saved) {
        state = saved || blankState();

        // Состояние, сохранённое прежней версией, может не иметь новых
        // полей. Недостающие добавляются, существующие не трогаются.
        var blank = blankState();
        Object.keys(blank).forEach(function (key) {
          if (state[key] === undefined) { state[key] = blank[key]; }
        });
        Object.keys(blank.settings).forEach(function (key) {
          if (state.settings[key] === undefined) {
            state.settings[key] = blank.settings[key];
          }
        });
        return global.LocalAPI;
      });
    },

    /**
     * Обрабатывает запрос вместо сервера.
     *
     * @param {string} url адрес вида `/api/...`
     * @param {Object} [options] метод и тело запроса
     * @returns {Promise<*>} тело ответа
     */
    handle: function (url, options) {
      var opts = options || {};
      var method = (opts.method || 'GET').toUpperCase();
      var parts = url.split('?');
      var path = parts[0];

      var query = {};
      if (parts[1]) {
        parts[1].split('&').forEach(function (pair) {
          var kv = pair.split('=');
          query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
        });
      }

      var body = {};
      if (opts.body && typeof opts.body === 'string') {
        try { body = JSON.parse(opts.body); } catch (error) { body = {}; }
      }

      for (var i = 0; i < ROUTES.length; i += 1) {
        if (ROUTES[i][0] !== method) { continue; }
        var params = match(ROUTES[i][1], path);
        if (!params) { continue; }

        try {
          var result = ROUTES[i][2](body, params, query);

          // Читающие запросы состояние не меняют, и сохранять после них
          // нечего. Прежде сохранение шло после любого запроса: открытие
          // списка квестов, обновление сада, чтение настроек — каждое
          // перекладывало в хранилище весь журнал целиком, со всеми
          // квестами, мыслями и перепиской с оракулом. Одно действие
          // пользователя вызывает пять-шесть чтений подряд, так что на
          // каждое изменение приходилось шесть полных записей вместо одной.
          //
          // Именно поэтому на телефоне подтормаживало нажатие, а не
          // отрисовка: браузер копировал всё состояние в отдельный поток
          // хранилища, и чем длиннее журнал, тем дольше.
          //
          // Проверка по методу, а не по признаку изменения: все обработчики,
          // меняющие состояние, объявлены как POST, PATCH или DELETE, и
          // сверка этого — отдельная проверка в tools/check_local_api.js.
          if (method === 'GET') {
            return Promise.resolve(result);
          }

          // Обработчик вправе вернуть обещание: генерация текста моделью
          // занимает секунды. Сохранение выполняется после его разрешения,
          // иначе в хранилище попало бы состояние без результата.
          return Promise.resolve(result).then(function (value) {
            return persist().then(function () { return value; });
          });
        } catch (error) {
          return Promise.reject(error);
        }
      }

      return Promise.reject(httpError(404, 'Маршрут не найден: ' + method + ' ' + path));
    },

    /** Полное состояние — используется при выгрузке данных. */
    dump: function () { return state; },

    /** Заменяет состояние целиком — используется при переносе данных. */
    restore: function (value) {
      state = value;
      return persist();
    }
  };
}(window));
