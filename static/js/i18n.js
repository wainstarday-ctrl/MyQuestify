/**
 * MyQuestify — перевод интерфейса.
 *
 * Строки хранятся плоским словарём с ключами вида «раздел.элемент». Плоская
 * структура выбрана намеренно: вложенные объекты требуют разбора пути при
 * каждом обращении, а выигрыш даёт только на словарях в несколько сотен
 * записей, каких здесь нет.
 *
 * Разметка размечается атрибутами:
 *   data-i18n              — заменяет текстовое содержимое элемента;
 *   data-i18n-placeholder  — подсказку поля ввода;
 *   data-i18n-title        — всплывающую подсказку.
 *
 * Строки, собираемые в коде (уведомления, карточки квестов), проходят через
 * функцию `t`. Отсутствующий ключ возвращается как есть: пропущенный перевод
 * должен бросаться в глаза при проверке, а не подменяться пустотой.
 *
 * Экспортирует `window.I18n`.
 */
(function (global) {
  'use strict';

  var DICT = {
    en: {
      // ---- шапка ----
      'brand.tagline': 'hours turn into reward',
      'wallet.label': 'Focus tokens',
      'engine.checking': 'checking model…',
      'engine.online': 'local model active',
      'engine.fallback': 'model not found · fallback phrases',
      'engine.offline': 'backend unavailable',
      'settings.open': 'Settings',
      'language.switch': 'Switch to Russian',

      // ---- журнал квестов ----
      'quests.eyebrow': 'Quest log',
      'quests.title': 'Tasks',
      'composer.title.label': 'What needs doing',
      'composer.title.placeholder': 'For example: draft the architecture chapter',
      'composer.hours': 'Hours',
      'composer.deadline': 'Deadline',
      'composer.priority': 'Priority',
      'composer.reward': 'Reward:',
      'composer.submit': 'Accept quest',
      'priority.low': 'Easy',
      'priority.normal': 'Normal',
      'priority.high': 'Urgent',
      'priority.low.hint': 'Reward ×0.8, mild penalty for missing the deadline',
      'priority.normal.hint': 'Reward ×1, penalty is half the reward',
      'priority.high.hint': 'Reward ×1.5, but a miss costs half of that larger reward',

      // ---- карточка квеста ----
      'task.complete': 'Complete',
      'task.finishLate': 'Finish late',
      'task.finishLate.hint': 'Finish after the deadline: half the reward',
      'task.chain': 'Thought chain',
      'task.edit': 'Edit quest',
      'task.delete': 'Delete quest',
      'task.deleteConfirm': 'Press again to delete the quest',
      'task.hours': 'h',
      'task.until': 'due',
      'status.pending': 'in progress',
      'status.completed': 'completed',
      'status.failed': 'failed',
      'status.overdue': 'overdue',
      'tasks.loading': 'Loading tasks…',
      'tasks.empty': 'No quests yet. Describe the first one and the model will add a word of encouragement.',

      // ---- календарь ----
      // Сокращения дней недели в календаре квестов. Собственный календарь
      // выбора срока строит их кодом, здесь же они заданы разметкой.
      'weekday.mon': 'Mo',
      'weekday.tue': 'Tu',
      'weekday.wed': 'We',
      'weekday.thu': 'Th',
      'weekday.fri': 'Fr',
      'weekday.sat': 'Sa',
      'weekday.sun': 'Su',

      'agenda.prev': 'Previous month',
      'agenda.next': 'Next month',
      'agenda.legend.high': 'urgent',
      'agenda.legend.normal': 'normal',
      'agenda.legend.low': 'easy',
      'agenda.legend.failed': 'overdue',
      'agenda.legend.done': 'done',
      'agenda.dayEmpty': 'No quests on this day.',
      'agenda.dayCount': 'Quests:',
      'agenda.dayDone': 'completed',
      'agenda.dayFailed': 'overdue',

      // ---- прогресс ----
      'progress.title': 'Monthly progress',
      'progress.empty': 'No closed quests yet.',
      'progress.closed': 'closed',
      'progress.hours': 'h',
      'progress.overdue': 'overdue',

      // ---- сцена ----
      // Подсказки сцен. Ключ строится из ключа сцены, поэтому новая сцена
      // получает перевод добавлением одной строки.
      'hint.garden': 'Tap the crown and fruit will fall. You can catch and throw it.',
      'hint.volcano': 'Press and hold the crater — lava will flow. Drops cool as they run down.',
      'hint.cosmos': 'Drag a planet onto another orbit and they swap. Release anywhere and it returns.',
      'hint.desk': 'Grab objects and scatter them. Tap an empty spot to push everything nearby.',
      'hint.clockwork': 'Grab a gear and spin it. A small one turns a large one with effort; a large one sends the small ones racing.',
      'hint.pond': 'Sweep across the water — ripples spread and push the lily pads. The leaves can be picked up.',
      'hint.weave': 'Pull any node — the net stretches and resists. Release it and it springs back into balance.',
      'hint.campfire': 'Tap near the top to toss in a log. Sweep your hand over the fire to fan it and swirl the sparks.',
      'hint.lab': 'Pick up a flask and tilt it with the rotation keys. Pour into a neighbour and the reagents react.',

      // Подписи, которые сцены рисуют прямо на холсте.
      'scene.fuel': 'FUEL',
      'lab.tilt': 'tilt',
      'reagent.azure': 'azure',
      'reagent.crimson': 'crimson',
      'reagent.verdant': 'verdant',
      'reagent.amber': 'amber',
      'reagent.violet': 'violet',
      'reagent.ash': 'ash',
      'reagent.pearl': 'pearl',
      'effect.foam': 'Foam!',
      'effect.smoke': 'Smoke!',
      'effect.flash': 'Flash!',
      'effect.crystal': 'Crystals!',
      'effect.bubble': 'Boiling!',
      'planet.0': 'Mercury',
      'planet.1': 'Venus',
      'planet.2': 'Earth',
      'planet.3': 'Mars',
      'planet.4': 'Jupiter',
      'planet.5': 'Saturn',
      'planet.6': 'Uranus',
      'planet.7': 'Neptune',

      'scene.eyebrow': 'Scene',
      'scene.tab': 'Scene',
      'oracle.tab': 'Oracle',
      'scene.level': 'Level',
      'scene.note': 'Each scene answers a finished quest in its own way.',
      'scene.reset': 'Reset scene',
      'scene.reset.hint': 'Return the scene to its initial state',
      'scene.shop': 'Scene shop',
      'scene.fallback': 'Physics engine not found. Put matter.min.js into static/js/vendor/ and restart the application.',
      'scene.resetDone': 'has been returned to its initial state.',
      'scene.unavailable': 'Scene unavailable.',

      // ---- магазин ----
      'shop.eyebrow': 'Shop',
      'shop.title': 'Interactive scenes',
      'shop.loading': 'Loading the catalogue…',
      'shop.buy': 'Buy',
      'shop.preview': 'Preview',
      'shop.open': 'Open',
      'shop.active': 'active',
      'shop.owned': 'owned',
      'shop.short': 'need',
      'shop.locked': 'Locked —',
      'preview.exit': 'Back',
      'preview.buy': 'Unlock',
      'preview.note': 'Preview. Unlock permanently for',
      'preview.viewOnly': '— preview only.',

      // ---- цепочка мыслей ----
      'chain.eyebrow': 'Thought chain',
      'chain.list': 'List',
      'chain.web': 'Web',
      'chain.loading': 'Loading the chain…',
      'chain.empty': 'The chain is empty. Write the first thought below or ask the model to break the quest down.',
      'chain.placeholder': 'New top-level thought…',
      'chain.placeholderChild': 'New thought inside',
      'chain.add': 'Add',
      'chain.expand': 'Expand with model',
      'chain.target': 'nest in',
      'chain.clearTarget': 'Clear selection',
      'chain.editHint': 'Click to edit',
      'chain.branch': 'Expand with model',
      'chain.child': 'Add your own sub-step',
      'chain.drop': 'Delete with descendants',
      'chain.dropConfirm': 'Press again to delete with sub-steps',
      'chain.generated': 'model',
      'chain.webHint': 'Click a node to nest a new thought inside it. Nodes can be dragged.',
      'chain.editorPlaceholder': 'Write your thought…',
      'chain.added': 'Steps added:',

      // ---- Оракул ----
      'oracle.placeholder': 'Ask the Oracle about your path…',
      'oracle.send': 'Ask',
      'oracle.thinking': 'The Oracle is pondering…',
      'oracle.clear': 'Clear conversation',
      'oracle.clearConfirm': 'Clear for sure?',
      'oracle.cleared': 'Conversation cleared. Let us begin anew.',
      'oracle.greeting': 'Ask. I will answer briefly — long speeches rarely change anything.',
      'oracle.more': 'Details',
      'oracle.note': 'Answers from the Oracle are generated by a language model on this device. They are general information, may contain inaccuracies and do not constitute medical, psychological, legal, financial or other professional advice. Do not rely on them for decisions affecting health, safety, property or rights: consult a qualified specialist in such cases.',

      // ---- настройки ----
      'picker.none': 'No deadline',
      'picker.time': 'Time',
      'picker.tonight': 'Today 21:00',
      'picker.done': 'Done',
      'picker.past': 'That time has already passed',
      'picker.pastDay': 'Date in the past',
      'picker.prevYear': 'Previous year',
      'picker.prevMonth': 'Previous month',
      'picker.nextMonth': 'Next month',
      'picker.nextYear': 'Next year',
      'picker.hours': 'Hours',
      'picker.minutes': 'Minutes',

      'settings.eyebrow': 'Settings',
      'settings.title': 'Interface and reminders',
      'settings.theme': 'Colour theme',
      'settings.theme.hint': 'Glass and lighting are rebuilt for the selected mode.',
      'settings.theme.dark': 'Dark',
      'settings.theme.light': 'Light',
      'settings.language': 'Interface language',
      'settings.language.hint': 'Also sets the language the model answers in, including background reminders.',
      'settings.notify': 'Deadline reminders',
      'settings.notify.hint': 'Arrive even when the window is closed: the application minimises to the tray and keeps running. Full exit is through the icon menu.',
      'settings.lead': 'Warn in advance',
      'settings.lead.hint': 'How many minutes before the deadline to send a reminder.',
      'settings.hints': 'Scene hints',
      'settings.hints.hint': 'The line below the scene fades after five seconds and returns when the scene changes. Turn off to hide it entirely.',
      'settings.keys': 'Rotation keys',
      'settings.keys.hint': 'Tilt a held object in scenes — a flask in the Laboratory, for instance. Click a field and press a key.',
      'settings.keys.ccw': 'counter',
      'settings.keys.cw': 'clockwise',
      'settings.motion': 'Reduce motion',
      'settings.motion.hint': 'Stops the background gradients. Scene physics keeps running.',

      // ---- правка ----
      'edit.eyebrow': 'Editing',
      'edit.title': 'Quest',
      'edit.name': 'Title',
      'edit.save': 'Save',

      // ---- условия ----
      'terms.eyebrow': 'Terms of use',
      'terms.title': 'Chat with the Oracle',
      'oracle.loading': 'Loading the conversation…',
      'terms.h1': 'Nature of the service',
      'terms.p1': 'Chat with the Oracle is an entertainment feature of the MyQuestify application. Replies are produced by a language model running locally on the user\u2019s device by statistically continuing text. The model has no knowledge of the user\u2019s particular situation, does not verify facts and may state information that is not true.',
      'terms.h2': 'No professional advice',
      'terms.p2': 'Material obtained in this section is provided "as is", is of a general informational nature only and does not constitute medical, psychological, psychotherapeutic, legal, tax, financial, investment, educational or any other professional advice. Using this feature does not create a doctor-patient, attorney-client, adviser-client or any other relationship implying professional responsibility.',
      'terms.h3': 'User decisions',
      'terms.p3': 'The user makes decisions independently and bears responsibility for them. Replies from the Oracle must not be used as grounds for actions affecting life and health, safety, property, rights and obligations, nor for declining to consult a specialist or to follow professional recommendations received earlier.',
      'terms.h4': 'Limitation of liability',
      'terms.p4': 'The developer makes no warranty as to the accuracy, completeness, timeliness or fitness of replies for any purpose, and bears no liability for direct or indirect losses arising from their use, to the extent permitted by applicable law.',
      'terms.h5': 'Emergencies',
      'terms.p5': 'This feature is not intended for use in emergencies. In case of a threat to life or health, contact an emergency service or a medical professional immediately.',
      'terms.h6': 'Data',
      'terms.p6': 'The conversation is stored in a local database on the user\u2019s device and is not transmitted to third parties. The history can be deleted with the "Clear conversation" button.',

      // ---- уведомления ----
      'toast.needTitle': 'Write down what needs doing.',
      'toast.badHours': 'The estimate must be between 1 and 24 hours.',
      'toast.pastDeadline': 'That deadline has passed. Choose a time in the future.',
      'toast.created': 'Quest accepted. Reward:',
      'toast.updated': 'Quest updated. Reward:',
      'toast.deleted': 'Quest deleted.',
      'toast.completedFor': 'for',
      'toast.levelUp': 'Level grew to',
      'toast.levelUpTail': '. The scene is richer now.',
      'toast.scenePurchased': 'Scene unlocked. Spent',
      'toast.overdue': 'Overdue quests:',
      'toast.overdueTail': 'deducted.',
      'toast.emptyTitle': 'The title cannot be empty.',
      'toast.completedLocked': 'A completed quest cannot be edited.',
      'toast.keyTaken': 'That key is already bound to the other rotation.',
      'toast.keyKind': 'Use a letter, digit, arrow or space.',
      'toast.leadRange': 'The warning can be from 5 minutes to a day.',
      'toast.language': 'Interface language switched to English.',
      'toast.notifyDenied': 'Notifications are blocked in the device settings.',

      // ---- экран загрузки ----
      'splash.tagline': 'hours turn into reward'
    }
  };

  var current = 'ru';

  /**
   * Ключ памятки оформления в хранилище браузера.
   *
   * Язык и тема хранятся в настройках, но те читаются с задержкой: сначала
   * готовится хранилище, потом уходит запрос. Экран загрузки к этому моменту
   * уже показан, и до ответа он был бы на языке по умолчанию — то есть
   * пользователь, выбравший английский, каждый раз видел бы русскую цитату,
   * а выбравший светлую тему — вспышку тёмного фона.
   *
   * Памятка решает именно это: два значения записываются при каждом
   * изменении и читаются мгновенно, ещё до первого запроса. Источником
   * истины остаются настройки — памятка лишь позволяет угадать верно.
   */
  var CACHE_KEY = 'myquestify.appearance';

  /**
   * Читает памятку оформления.
   *
   * @returns {Object} сохранённые язык и тема либо пустой объект
   */
  function readCache() {
    try {
      return JSON.parse(global.localStorage.getItem(CACHE_KEY)) || {};
    } catch (error) {
      // Хранилище может быть недоступно: приватный режим, запрет политикой.
      // Отсутствие памятки не мешает работе, лишь возвращает прежнее
      // поведение с оформлением по умолчанию.
      return {};
    }
  }

  /**
   * Сохраняет памятку оформления.
   *
   * @param {string} language код языка
   * @param {string} theme тема оформления
   */
  function writeCache(language, theme) {
    try {
      global.localStorage.setItem(CACHE_KEY, JSON.stringify({
        language: language,
        theme: theme
      }));
    } catch (error) {
      /* запись необязательна */
    }
  }

  /**
   * Переводит ключ на текущий язык.
   *
   * @param {string} key ключ словаря
   * @param {string} [fallback] текст, если ключа нет; по умолчанию сам ключ
   * @returns {string}
   */
  function t(key, fallback) {
    if (current === 'ru') { return fallback !== undefined ? fallback : key; }
    var table = DICT[current] || {};
    if (table[key] !== undefined) { return table[key]; }
    return fallback !== undefined ? fallback : key;
  }

  /**
   * Применяет перевод ко всем размеченным элементам документа.
   *
   * Русские строки остаются в разметке и служат запасным значением: так
   * страница осмысленна даже до выполнения скриптов, а перевод сводится к
   * подмене там, где она нужна.
   */
  function apply() {
    var table = DICT[current] || null;

    // Исходные русские значения сохраняются при первом проходе: без них
    // возврат к русскому потребовал бы второго словаря.
    var nodes = document.querySelectorAll('[data-i18n]');
    Array.prototype.forEach.call(nodes, function (node) {
      var key = node.dataset.i18n;
      var value = (table && table[key] !== undefined) ? table[key] : null;

      // Подстановка через textContent удаляет дочерние элементы. Если внутри
      // есть разметка — ссылка, значок, — заменяется только первый текстовый
      // узел, а вложенные элементы остаются на месте.
      var child = node.firstChild;
      var textNode = null;
      while (child) {
        if (child.nodeType === 3 && child.nodeValue.trim()) { textNode = child; break; }
        child = child.nextSibling;
      }

      var hasElements = node.children && node.children.length > 0;

      if (hasElements && textNode) {
        if (node.dataset.i18nRu === undefined) {
          node.dataset.i18nRu = textNode.nodeValue;
        }
        textNode.nodeValue = value !== null ? value : node.dataset.i18nRu;
        return;
      }

      if (node.dataset.i18nRu === undefined) {
        node.dataset.i18nRu = node.textContent;
      }
      node.textContent = value !== null ? value : node.dataset.i18nRu;
    });

    var placeholders = document.querySelectorAll('[data-i18n-placeholder]');
    Array.prototype.forEach.call(placeholders, function (node) {
      if (node.dataset.i18nPlaceholderRu === undefined) {
        node.dataset.i18nPlaceholderRu = node.placeholder || '';
      }
      var key = node.dataset.i18nPlaceholder;
      node.placeholder = (table && table[key] !== undefined)
        ? table[key] : node.dataset.i18nPlaceholderRu;
    });

    var titles = document.querySelectorAll('[data-i18n-title]');
    Array.prototype.forEach.call(titles, function (node) {
      if (node.dataset.i18nTitleRu === undefined) {
        node.dataset.i18nTitleRu = node.title || '';
      }
      var key = node.dataset.i18nTitle;
      node.title = (table && table[key] !== undefined)
        ? table[key] : node.dataset.i18nTitleRu;
    });

    document.documentElement.lang = current;
  }

  global.I18n = {
    /**
     * Устанавливает язык и перерисовывает размеченные элементы.
     * @param {string} language ru или en
     */
    set: function (language) {
      current = (language === 'en') ? 'en' : 'ru';
      apply();
    },

    /**
     * Применяет запомненное оформление до получения настроек.
     *
     * Вызывается первой строкой запуска, чтобы экран загрузки появился
     * сразу на верном языке и в верной теме. Если памятки нет — первый
     * запуск или очищенное хранилище, — остаётся оформление по умолчанию.
     *
     * @returns {Object} применённые значения
     */
    restore: function () {
      var cache = readCache();

      if (cache.language) {
        current = cache.language === 'en' ? 'en' : 'ru';
        apply();
      }
      if (cache.theme) {
        document.documentElement.dataset.theme = cache.theme;
      }
      return cache;
    },

    /**
     * Запоминает оформление для следующего запуска.
     *
     * @param {string} language код языка
     * @param {string} theme тема
     */
    remember: function (language, theme) {
      writeCache(language, theme);
    },

    /** Текущий язык. */
    current: function () { return current; },

    /** Противоположный язык — для кнопки переключения. */
    other: function () { return current === 'ru' ? 'en' : 'ru'; },

    t: t,
    apply: apply
  };
}(window));
