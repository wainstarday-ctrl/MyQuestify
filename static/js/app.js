/**
 * MyQuestify — клиентская логика.
 *
 * Слои:
 *   api    — тонкая обёртка над fetch с единым разбором ошибок FastAPI;
 *   state  — единственный источник правды на клиенте;
 *   render — отрисовка списка квестов, вкладок сцен и витрины магазина;
 *   ui     — тосты, блокировка кнопок, связь с ядром сцен (`Stage`).
 *
 * Запросы идут только на собственный origin: приложение офлайновое.
 */
(function () {
  'use strict';

  /**
   * Переводит строку, собираемую в коде.
   *
   * Русский текст передаётся вторым доводом и служит запасным значением:
   * так строка остаётся читаемой в самом коде, а перевод не требует
   * заглядывать в словарь, чтобы понять, что здесь выводится.
   *
   * @param {string} key ключ словаря
   * @param {string} ru русский вариант
   * @returns {string}
   */
  function t(key, ru) {
    return window.I18n ? window.I18n.t(key, ru) : ru;
  }

  var TOKENS_PER_HOUR = 10;   // должно совпадать с app.config.TOKENS_PER_HOUR

  // Множители дублируют app.config.PRIORITIES: предпросмотр награды должен
  // считаться мгновенно, без запроса к серверу.
  var PRIORITY_MULTIPLIER = { low: 0.8, normal: 1, high: 1.5 };
  function priorityLabel(priority) {
    var ru = { low: 'спокойно', normal: 'обычно', high: 'срочно' };
    return t('priority.' + priority, ru[priority] || priority).toLowerCase();
  }

  var MONTHS = {
    ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
         'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
    en: ['January', 'February', 'March', 'April', 'May', 'June',
         'July', 'August', 'September', 'October', 'November', 'December']
  };

  /** Название месяца на текущем языке интерфейса. */
  function monthName(index) {
    var lang = window.I18n ? window.I18n.current() : 'ru';
    return (MONTHS[lang] || MONTHS.ru)[index];
  }
  var TOAST_LIFETIME_MS = 4200;

  /** Подписи статусов. Ключи словаря совпадают со значениями с сервера. */
  function statusLabel(status) {
    var ru = { pending: 'в работе', completed: 'завершена', failed: 'провалена' };
    return t('status.' + status, ru[status] || status);
  }

  var state = {
    tasks: [],
    scenes: [],
    tokens: 0,
    treeLevel: 1,
    activeScene: 'garden',
    previewScene: null,
    activeView: 'scene',
    oracleLoaded: false,
    openTaskId: null,
    chainTree: [],
    chainMode: 'list',
    chainParent: null,
    chainParentText: '',
    priority: 'normal',
    agendaMonth: null,
    editingId: null,
    editPriority: 'normal',
    stats: [],
    showDone: false,
    settings: {
      theme: 'dark',
      notifications_enabled: true,
      notify_lead_minutes: 60,
      reduce_motion: false
    }
  };

  var dom = {};

  // ------------------------------------------------------------------ утилиты

  function cacheDom() {
    dom.tokenValue = document.getElementById('token-value');
    dom.wallet = document.getElementById('wallet');
    dom.engine = document.getElementById('engine-status');
    dom.engineText = document.getElementById('engine-text');

    dom.title = document.getElementById('task-title');
    dom.hours = document.getElementById('task-hours');
    dom.deadline = document.getElementById('task-deadline');
    dom.rewardPreview = document.getElementById('reward-preview');
    dom.createBtn = document.getElementById('create-task');

    dom.tasksRoot = document.getElementById('tasks-root');
    dom.questCounter = document.getElementById('quests-counter');
    dom.prioritySwitch = document.getElementById('priority-switch');
    dom.agendaGrid = document.getElementById('agenda-grid');
    dom.agendaMonth = document.getElementById('agenda-month');
    dom.agendaPrev = document.getElementById('agenda-prev');
    dom.agendaNext = document.getElementById('agenda-next');
    dom.progressChart = document.getElementById('progress-chart');
    dom.progressSummary = document.getElementById('progress-summary');

    dom.editModal = document.getElementById('edit-modal');
    dom.editTitle = document.getElementById('edit-task-title');
    dom.editHours = document.getElementById('edit-hours');
    dom.editDeadline = document.getElementById('edit-deadline');
    dom.editPriority = document.getElementById('edit-priority');
    dom.editReward = document.getElementById('edit-reward');
    dom.editSave = document.getElementById('edit-save');
    dom.editHeading = document.getElementById('edit-title');

    dom.stage = document.getElementById('scene-stage');
    dom.canvas = document.getElementById('scene-canvas');
    dom.stageHint = document.getElementById('stage-hint');
    dom.stageFallback = document.getElementById('stage-fallback');
    dom.sceneTitle = document.getElementById('scene-title');
    dom.sceneTabs = document.getElementById('scene-tabs');
    dom.treeLevel = document.getElementById('tree-level');


    dom.shopModal = document.getElementById('shop-modal');
    dom.shopRoot = document.getElementById('shop-root');
    dom.openShop = document.getElementById('open-shop');
    dom.resetScene = document.getElementById('reset-scene');
    dom.langToggle = document.getElementById('lang-toggle');
    dom.languageSwitch = document.getElementById('language-switch');
    dom.previewBar = document.getElementById('preview-bar');
    dom.previewText = document.getElementById('preview-text');
    dom.previewBuy = document.getElementById('preview-buy');
    dom.previewExit = document.getElementById('preview-exit');

    dom.viewScene = document.getElementById('view-scene');
    dom.viewOracle = document.getElementById('view-oracle');
    dom.viewTabs = document.querySelector('.tabs--view');

    dom.oracleLog = document.getElementById('oracle-log');
    dom.oracleInput = document.getElementById('oracle-input');
    dom.oracleSend = document.getElementById('oracle-send');
    dom.oracleClear = document.getElementById('oracle-clear');
    dom.oracleTerms = document.getElementById('oracle-terms');
    dom.termsModal = document.getElementById('terms-modal');

    dom.thoughtsModal = document.getElementById('thoughts-modal');
    dom.thoughtsRoot = document.getElementById('thoughts-root');
    dom.thoughtsTitle = document.getElementById('thoughts-title');
    dom.thoughtInput = document.getElementById('thought-input');
    dom.thoughtAdd = document.getElementById('thought-add');
    dom.thoughtExpand = document.getElementById('thought-expand');
    dom.chainModes = document.getElementById('chain-modes');
    dom.thoughtsWeb = document.getElementById('thoughts-web');
    dom.webCanvas = document.getElementById('web-canvas');
    dom.chainTarget = document.getElementById('chain-target');
    dom.chainTargetName = document.getElementById('chain-target-name');
    dom.chainTargetClear = document.getElementById('chain-target-clear');

    dom.settingsModal = document.getElementById('settings-modal');
    dom.openSettings = document.getElementById('open-settings');
    dom.themeSwitch = document.getElementById('theme-switch');
    dom.notifyToggle = document.getElementById('notify-toggle');
    dom.notifyLead = document.getElementById('notify-lead');
    dom.motionToggle = document.getElementById('motion-toggle');
    dom.hintsToggle = document.getElementById('hints-toggle');
    dom.settingKeys = document.getElementById('setting-keys');
    dom.keyCcw = document.getElementById('key-ccw');
    dom.keyCw = document.getElementById('key-cw');
    dom.keyCcwValue = document.getElementById('key-ccw-value');
    dom.keyCwValue = document.getElementById('key-cw-value');

    dom.toasts = document.getElementById('toasts');
  }

  /**
   * Экранирует строку перед вставкой в разметку.
   * @param {*} value
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Форматирует дату в короткий локальный вид.
   * @param {?string} iso
   * @returns {string}
   */
  function formatDate(iso) {
    if (!iso) { return ''; }
    var date = new Date(iso);
    if (isNaN(date.getTime())) { return ''; }
    return date.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  /**
   * Переводит значение datetime-local в ISO с таймзоной.
   * Без этого сервер получил бы время без смещения и сравнение с дедлайном
   * поехало бы на величину часового пояса.
   * @param {string} localValue
   * @returns {?string}
   */
  function toIsoWithZone(localValue) {
    if (!localValue) { return null; }
    var date = new Date(localValue);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  /**
   * Проверяет, что срок указывает в будущее.
   *
   * Календарь не даёт выбрать прошедший момент, но проверка перед отправкой
   * остаётся: значение поля может быть подставлено иным путём, а квест с
   * истёкшим сроком создавался бы сразу просроченным.
   *
   * @param {?string} iso значение в формате ISO 8601
   * @returns {boolean} ``true``, если срок отсутствует или ещё не наступил
   */
  function isDeadlineValid(iso) {
    if (!iso) { return true; }
    var date = new Date(iso);
    return !isNaN(date.getTime()) && date.getTime() > Date.now();
  }

  /**
   * Показывает уведомление.
   * @param {string} message
   * @param {('success'|'info'|'error')} [kind='info']
   */
  /**
   * Показывает всплывающее уведомление.
   *
   * Повторное сообщение с тем же текстом заменяет прежнее, а не добавляет
   * второе. Стопка одинаковых уведомлений заслоняет интерфейс и не несёт
   * сведений: пользователь и так видел первое.
   *
   * @param {string} message текст
   * @param {string} [kind] вид: info, success, error
   */
  function toast(message, kind) {
    // Повтор того же текста: продлеваем время показа прежнего сообщения и
    // отмечаем счётчиком, сколько раз оно повторилось.
    var existing = dom.toasts.querySelector('[data-message="' +
      String(message).replace(/"/g, '&quot;') + '"]');

    if (existing) {
      var count = (parseInt(existing.dataset.count, 10) || 1) + 1;
      existing.dataset.count = count;
      existing.textContent = message + ' ×' + count;
      existing.classList.remove('is-leaving');

      // Отсчёт запускается заново: сообщение должно провисеть полное время
      // после последнего повтора, а не исчезнуть по таймеру первого.
      window.clearTimeout(existing.dismissTimer);
      existing.dismissTimer = window.setTimeout(function () {
        existing.classList.add('is-leaving');
        window.setTimeout(function () { existing.remove(); }, 240);
      }, TOAST_LIFETIME_MS);
      return;
    }

    var node = document.createElement('div');
    node.className = 'toast toast--' + (kind || 'info');
    node.textContent = message;
    node.dataset.message = message;
    node.dataset.count = '1';
    dom.toasts.appendChild(node);

    // Число одновременно видимых сообщений ограничено: на узком экране
    // четвёртое уже перекрывает интерфейс целиком.
    while (dom.toasts.children.length > 3) {
      dom.toasts.removeChild(dom.toasts.firstChild);
    }

    node.dismissTimer = window.setTimeout(function () {
      node.classList.add('is-leaving');
      window.setTimeout(function () { node.remove(); }, 240);
    }, TOAST_LIFETIME_MS);
  }

  /**
   * Переключает состояние занятости кнопки.
   * @param {HTMLButtonElement} button
   * @param {boolean} busy
   */
  function setBusy(button, busy) {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
  }

  // ---------------------------------------------------------------------- api

  var api = {
    /**
     * Выполняет запрос и разворачивает ошибку FastAPI в читаемое сообщение.
     * @param {string} url
     * @param {RequestInit} [options]
     * @returns {Promise<Object>}
     */
    request: function (url, options) {
      // В мобильной сборке сервера нет: запрос обрабатывается локальной
      // реализацией с тем же набором адресов и форм ответов. Подмена
      // выполняется здесь, в единственной точке, поэтому остальной код
      // приложения не различает режимы.
      if (window.LocalAPI && window.LocalAPI.ready) {
        return window.LocalAPI.handle(url, options).catch(function (error) {
          var failure = new Error(error.detail || error.message ||
            t('error.request', 'Ошибка обработки запроса'));
          failure.status = error.status || 500;
          throw failure;
        });
      }

      return fetch(url, options).then(function (response) {
        // Тело читается как текст и разбирается вручную. Ответ 204 приходит
        // с заголовком application/json, но пустым телом, и response.json()
        // на нём падает с «Unexpected end of JSON input» — именно так
        // ломались удаление беседы и удаление мысли.
        return response.text().then(function (raw) {
          var body = null;
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch (error) {
              body = raw;   // не-JSON ответ (например, страница ошибки)
            }
          }

          if (response.ok) { return body; }

          var detail = body && body.detail;
          if (Array.isArray(detail)) {
            // Ошибки валидации Pydantic приходят массивом объектов.
            detail = detail.map(function (item) { return item.msg; }).join('; ');
          }
          var failure = new Error(detail || (t('error.server', 'Ошибка сервера (') + response.status + ')'));
          failure.status = response.status;
          throw failure;
        });
      });
    },

    listTasks: function () {
      return api.request('/api/tasks/');
    },

    createTask: function (payload) {
      return api.request('/api/tasks/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    },

    completeTask: function (taskId) {
      return api.request('/api/tasks/' + taskId + '/complete', { method: 'PATCH' });
    },

    getGarden: function () {
      return api.request('/api/garden/');
    },

    purchaseScene: function (key) {
      return api.request('/api/shop/' + encodeURIComponent(key) + '/purchase',
        { method: 'POST' });
    },

    selectScene: function (key) {
      return api.request('/api/garden/scene/' + encodeURIComponent(key),
        { method: 'PATCH' });
    },

    listThoughts: function (taskId) {
      return api.request('/api/tasks/' + taskId + '/thoughts');
    },

    createThought: function (taskId, payload) {
      return api.request('/api/tasks/' + taskId + '/thoughts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    },

    updateThought: function (thoughtId, payload) {
      return api.request('/api/thoughts/' + thoughtId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    },

    deleteThought: function (thoughtId) {
      return api.request('/api/thoughts/' + thoughtId, { method: 'DELETE' });
    },

    expandThoughts: function (taskId, parentId) {
      var parent = parseInt(parentId, 10);
      var query = isNaN(parent) ? '' : '?parent_id=' + parent;
      return api.request('/api/tasks/' + taskId + '/thoughts/expand' + query,
        { method: 'POST' });
    },

    oracleHistory: function () {
      return api.request('/api/oracle/');
    },

    oracleAsk: function (message) {
      return api.request('/api/oracle/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message })
      });
    },

    oracleClear: function () {
      return api.request('/api/oracle/', { method: 'DELETE' });
    },

    getSettings: function () {
      return api.request('/api/settings/');
    },

    updateSettings: function (payload) {
      return api.request('/api/settings/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    },

    updateTask: function (taskId, payload) {
      return api.request('/api/tasks/' + taskId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    },

    deleteTask: function (taskId) {
      return api.request('/api/tasks/' + taskId, { method: 'DELETE' });
    },

    monthlyStats: function () {
      return api.request('/api/stats/monthly');
    },

    sweepOverdue: function () {
      return api.request('/api/tasks/sweep_overdue', { method: 'POST' });
    },

    health: function () {
      return api.request('/api/health');
    }
  };

  // ------------------------------------------------------------------- рендер

  /**
   * Обновляет счётчик токенов с коротким «толчком».
   * @param {number} value
   */
  function renderTokens(value) {
    state.tokens = value;
    dom.tokenValue.textContent = value;
    dom.wallet.classList.add('is-bumped');
    window.setTimeout(function () { dom.wallet.classList.remove('is-bumped'); }, 240);
    syncAffordability();
  }

  /**
   * Блокирует покупки, на которые не хватает токенов.
   *
   * Кнопка, которая нажимается и отвечает ошибкой, раздражает сильнее, чем
   * кнопка, заранее показывающая недоступность.
   */
  function syncAffordability() {
    // Кнопка покупки объясняет свою недоступность: без подписи она выглядит
    // как сломанная, а не как «не хватает средств».
    var buttons = document.querySelectorAll('[data-buy]');
    Array.prototype.forEach.call(buttons, function (button) {
      var price = parseInt(button.dataset.price, 10);
      var short = price - state.tokens;
      button.disabled = short > 0;
      button.title = short > 0
        ? 'Не хватает ' + short + ' FT — заверши ещё квесты'
        : 'Открыть сцену за ' + price + ' FT';
    });
  }

  /**
   * Собирает разметку одного квеста.
   * @param {Object} task
   * @returns {string}
   */
  function taskMarkup(task) {
    var segments = '';
    var visibleHours = Math.min(task.estimated_hours, 24);
    for (var i = 0; i < visibleHours; i += 1) {
      segments += '<span class="hours__seg"></span>';
    }

    var priority = task.priority || 'normal';
    var chips = '<span class="chip chip--' + task.status + '">' +
      escapeHtml(statusLabel(task.status)) + '</span>' +
      '<span class="chip chip--prio chip--prio-' + priority + '">' +
      escapeHtml(priorityLabel(priority)) + '</span>';

    if (task.penalty > 0) {
      chips += '<span class="chip chip--penalty">−' + task.penalty + ' FT</span>';
    }

    if (task.is_overdue) {
      chips += '<span class="chip chip--overdue">просрочена</span>';
    }
    if (task.deadline) {
      chips += '<span>' + escapeHtml(t('task.until', 'до')) + ' ' +
        escapeHtml(formatDate(task.deadline)) + '</span>';
    }

    var action = task.status === 'pending'
      ? '<button class="btn btn--complete" type="button" data-complete="' +
        task.id + '">' + escapeHtml(t('task.complete', 'Завершить')) + '</button>'
      : '';
    // Просроченный квест тоже можно завершить: штраф уже удержан, и с
    // учётом награды пользователь получает половину.
    if (task.status === 'failed') {
      action = '<button class="btn btn--complete" type="button" data-complete="' +
        task.id + '" title="' + escapeHtml(t('task.finishLate.hint', 'Завершить с опозданием: половина награды')) +
        '">' + escapeHtml(t('task.finishLate', 'Доделать')) + '</button>';
    }

    action += '<span class="task__tools">' +
      '<button class="chain__act" type="button" data-chain="' + task.id +
        '" title="' + escapeHtml(t('task.chain', 'Цепочка мыслей')) + '">⌘</button>' +
      '<button class="chain__act" type="button" data-edit-task="' + task.id +
        '" title="' + escapeHtml(t('task.edit', 'Изменить квест')) + '">✎</button>' +
      '<button class="chain__act chain__act--danger" type="button" data-drop-task="' +
        task.id + '" title="' + escapeHtml(t('task.delete', 'Удалить квест')) + '">×</button>' +
      '</span>';

    var note = task.motivation
      ? '<p class="task__note">' + escapeHtml(task.motivation) + '</p>'
      : '';

    return '' +
      '<article class="task task--' + task.status + ' task--prio-' + priority +
        '" data-task-id="' + task.id + '">' +
        '<div class="task__main">' +
          '<h3 class="task__title">' + escapeHtml(task.title) + '</h3>' +
          '<div class="hours">' +
            '<span class="hours__bar">' + segments + '</span>' +
            '<span>' + task.estimated_hours + ' ' + escapeHtml(t('task.hours', 'ч')) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="task__side">' +
          '<span class="task__reward">+' + task.reward + ' FT</span>' +
          action +
        '</div>' +
        note +
        '<div class="task__meta">' + chips + '</div>' +
      '</article>';
  }

  /**
   * Рисует месячный календарь с отметками сроков.
   *
   * Данные берутся из уже загруженного списка квестов, а не отдельным
   * запросом: список и календарь обязаны показывать одно и то же, а два
   * источника рано или поздно разойдутся.
   */
  function renderAgenda() {
    var view = state.agendaMonth || new Date();
    state.agendaMonth = view;

    var year = view.getFullYear();
    var month = view.getMonth();
    dom.agendaMonth.textContent = monthName(month) + ' ' + year;

    // Группировка по дню: у одной даты может быть несколько квестов, и
    // точка должна отражать самый срочный из них.
    var byDay = {};
    state.tasks.forEach(function (task) {
      if (!task.deadline) { return; }
      var date = new Date(task.deadline);
      if (isNaN(date.getTime()) ||
          date.getFullYear() !== year || date.getMonth() !== month) { return; }

      var day = date.getDate();
      if (!byDay[day]) { byDay[day] = { high: 0, normal: 0, low: 0, failed: 0, done: 0, total: 0 }; }

      byDay[day].total += 1;
      if (task.status === 'failed') {
        byDay[day].failed += 1;
      } else if (task.status === 'completed') {
        byDay[day].done += 1;
      } else if (task.is_overdue) {
        // Открытый квест с прошедшим сроком отмечается как просроченный
        // сразу, не дожидаясь ближайшей проверки на сервере.
        byDay[day].failed += 1;
      } else {
        byDay[day][task.priority || 'normal'] += 1;
      }
    });

    var first = new Date(year, month, 1);
    var offset = (first.getDay() + 6) % 7;   // неделя с понедельника
    var days = new Date(year, month + 1, 0).getDate();
    var today = new Date();

    var cells = '';
    for (var blank = 0; blank < offset; blank += 1) {
      cells += '<span class="agenda__day agenda__day--empty"></span>';
    }

    for (var day = 1; day <= days; day += 1) {
      var info = byDay[day];
      var isToday = today.getFullYear() === year &&
        today.getMonth() === month && today.getDate() === day;

      var dots = '';
      var openCount = 0;
      if (info) {
        // Открытые квесты первыми и в полную яркость, выполненные — следом
        // и приглушённо: закрытое дело не должно спорить за внимание с тем,
        // что ещё предстоит.
        ['failed', 'high', 'normal', 'low'].forEach(function (kind) {
          if (info[kind] > 0) {
            openCount += info[kind];
            dots += '<i class="agenda__dot agenda__dot--' + kind + '"></i>';
          }
        });
        if (info.done > 0) {
          dots += '<i class="agenda__dot agenda__dot--done"></i>';
        }
      }

      // День только с выполненными квестами не выделяется жирным: он уже
      // не требует действий.
      var dayClass = 'agenda__day' + (isToday ? ' is-today' : '');
      if (info) {
        dayClass += openCount > 0 ? ' has-tasks' : ' is-settled';
      }

      var tip = '';
      if (info) {
        tip = t('agenda.dayCount', 'Квестов:') + ' ' + info.total;
        if (info.done) { tip += ', ' + t('agenda.dayDone', 'выполнено') + ' ' + info.done; }
        if (info.failed) { tip += ', ' + t('agenda.dayFailed', 'просрочено') + ' ' + info.failed; }
      }

      cells += '<button type="button" class="' + dayClass +
        '" data-day="' + day + '"' +
        (tip ? ' title="' + tip + '"' : '') + '>' +
        '<span class="agenda__num">' + day + '</span>' +
        '<span class="agenda__dots">' + dots + '</span>' +
        '</button>';
    }

    dom.agendaGrid.innerHTML = cells;
  }

  /**
   * Рисует столбчатую диаграмму итогов по месяцам.
   *
   * Высота столбца — доля доведённых до конца среди закрытых квестов.
   * Абсолютное число закрытых показано насыщенностью: месяц с одним
   * выполненным квестом не должен выглядеть так же убедительно, как месяц
   * с двадцатью, хотя доля в обоих случаях равна ста процентам.
   */
  function renderProgress() {
    if (!state.stats.length) {
      dom.progressChart.innerHTML =
        '<p class="progress__empty">' + escapeHtml(t('progress.empty', 'Пока нет закрытых квестов.')) + '</p>';
      dom.progressSummary.textContent = '—';
      return;
    }

    var maxClosed = state.stats.reduce(function (peak, item) {
      return Math.max(peak, item.completed + item.failed);
    }, 1);

    dom.progressChart.innerHTML = state.stats.map(function (item) {
      var closed = item.completed + item.failed;
      var height = closed ? Math.max(6, item.rate) : 3;
      var weight = closed ? 0.35 + 0.65 * (closed / maxClosed) : 0.15;
      var label = monthName(item.month - 1).slice(0, 3).toLowerCase();

      var tip = label + ' ' + item.year + ': выполнено ' + item.completed +
        ', просрочено ' + item.failed +
        ', заработано ' + item.earned + ' FT' +
        (item.lost ? ', удержано ' + item.lost + ' FT' : '');

      return '<div class="progress__col" title="' + escapeHtml(tip) + '">' +
        '<span class="progress__value">' + (closed ? item.rate + '%' : '') + '</span>' +
        '<span class="progress__bar" style="height:' + height + '%;opacity:' +
          weight.toFixed(2) + '"></span>' +
        '<span class="progress__label">' + label + '</span>' +
        '</div>';
    }).join('');

    var totals = state.stats.reduce(function (sum, item) {
      sum.completed += item.completed;
      sum.failed += item.failed;
      sum.earned += item.earned;
      sum.hours += item.hours;
      return sum;
    }, { completed: 0, failed: 0, earned: 0, hours: 0 });

    dom.progressSummary.textContent =
      totals.completed + ' ' + t('progress.closed', 'закрыто') + ' · ' +
      totals.hours + ' ' + t('progress.hours', 'ч') + ' · ' + totals.earned + ' FT' +
      (totals.failed ? ' · ' + totals.failed + ' ' + t('progress.overdue', 'просрочено') : '');
  }

  /** Запрашивает помесячные итоги и перерисовывает диаграмму. */
  function reloadProgress() {
    return api.monthlyStats().then(function (stats) {
      state.stats = stats;
      renderProgress();
    }).catch(function () {
      // Статистика второстепенна: её отсутствие не должно мешать работе.
      dom.progressChart.innerHTML = '';
    });
  }

  /**
   * Подсвечивает квесты выбранного дня в списке.
   * @param {number} day число месяца
   */
  function focusDay(day) {
    var view = state.agendaMonth || new Date();
    var matches = state.tasks.filter(function (task) {
      if (!task.deadline) { return false; }
      var date = new Date(task.deadline);
      return date.getFullYear() === view.getFullYear() &&
        date.getMonth() === view.getMonth() && date.getDate() === day;
    });

    if (!matches.length) {
      toast(t('agenda.dayEmpty', 'На этот день квестов нет.'), 'info');
      return;
    }

    // Прокручиваем к незакрытому квесту дня, если он есть: именно он
    // интересует пользователя, а не уже сделанное.
    var target = matches.filter(function (task) {
      return task.status === 'pending';
    })[0] || matches[0];

    var card = dom.tasksRoot.querySelector('[data-task-id="' + target.id + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('is-flash');
      window.setTimeout(function () { card.classList.remove('is-flash'); }, 1400);
    }
  }

  /**
   * Перепланирует мобильные напоминания.
   *
   * Вызывается после любого изменения списка квестов. Настольная версия
   * этого не требует: там планировщик сам просматривает базу раз в минуту,
   * тогда как на телефоне расписание передаётся системе заранее и о
   * последующих изменениях не знает.
   */
  function resyncReminders() {
    if (!window.MobileNotify) { return; }
    window.MobileNotify.schedule(state.tasks, state.settings);
  }

  /** Перерисовывает список квестов и счётчик в шапке панели. */
  function renderTasks() {
    dom.tasksRoot.setAttribute('aria-busy', 'false');

    if (state.tasks.length) {
      var open = state.tasks.filter(function (task) {
        return task.status !== 'completed';
      });
      var closed = state.tasks.filter(function (task) {
        return task.status === 'completed';
      });

      var markup = open.map(taskMarkup).join('');

      // Завершённые убираются под сворачиваемый заголовок. Список растёт
      // без предела, и закрытые дела вытесняют открытые за край экрана —
      // на телефоне это происходит уже на пятом квесте. Держать их
      // видимыми незачем: они не требуют действий, а история доступна на
      // диаграмме по месяцам.
      if (closed.length) {
        markup += '<button class="tasks__fold" type="button" id="toggle-done"' +
          ' aria-expanded="' + (state.showDone ? 'true' : 'false') + '">' +
          '<span class="tasks__fold-arrow">' + (state.showDone ? '▾' : '▸') + '</span>' +
          escapeHtml(t('tasks.completed', 'Завершённые')) + ' · ' + closed.length +
          '</button>';

        if (state.showDone) {
          markup += '<div class="tasks__done">' +
            closed.map(taskMarkup).join('') + '</div>';
        }
      }

      dom.tasksRoot.innerHTML = markup;
      dom.questCounter.textContent = closed.length + ' / ' + state.tasks.length;
    } else {
      dom.tasksRoot.innerHTML =
        '<p class="tasks__placeholder">' +
          escapeHtml(t('tasks.empty', 'Квестов пока нет. Опиши первый — модель добавит напутствие.')) + '</p>';
      dom.questCounter.textContent = '0 / 0';
    }

    // Календарь перерисовывается в обоих случаях. Ранний выход при пустом
    // списке оставлял в нём отметки удалённых квестов: список очищался, а
    // сетка сроков сохраняла прежнее состояние.
    renderAgenda();
    resyncReminders();
  }

  /**
   * Рисует вкладки всех сцен: купленные обычные, запертые — с замком.
   *
   * Запертые сцены остаются видимыми намеренно. Скрытая позиция каталога
   * неотличима от несуществующей: пользователь не знает, что содержимое
   * есть, и не имеет повода зарабатывать токены. Замок сообщает и о
   * наличии сцены, и об условии доступа к ней.
   */
  function renderTabs() {
    dom.sceneTabs.innerHTML = state.scenes.map(function (scene) {
      var active = scene.key === state.previewScene ||
        (!state.previewScene && scene.key === state.activeScene);
      var locked = !scene.owned;

      return '<button class="tab' + (active ? ' is-active' : '') +
        (locked ? ' is-locked' : '') + '" type="button" data-scene="' +
        escapeHtml(scene.key) + '" title="' +
        (locked ? t('shop.locked', 'Заперта —') + ' ' + scene.price + ' FT' : scene.tagline) + '">' +
        (locked ? '<span class="tab__lock">🔒</span>' : '<span class="tab__dot"></span>') +
        escapeHtml(scene.title) + '</button>';
    }).join('');

    var shownKey = state.previewScene || state.activeScene;
    var current = state.scenes.filter(function (scene) {
      return scene.key === shownKey;
    })[0];
    if (current) { dom.sceneTitle.textContent = current.title; }

    dom.previewBar.hidden = !state.previewScene;
    if (state.previewScene) {
      var locked = state.scenes.filter(function (scene) {
        return scene.key === state.previewScene;
      })[0];
      dom.previewText.textContent = locked
        ? t('preview.note', 'Предпросмотр. Открыть навсегда —') + ' ' + locked.price + ' FT.'
        : t('preview.note', 'Предпросмотр.');
      dom.previewBuy.dataset.buy = state.previewScene;
      dom.previewBuy.dataset.price = locked ? locked.price : 0;
      dom.previewBuy.disabled = !locked || state.tokens < locked.price;
    }
  }

  /** Рисует витрину магазина. */
  function renderShop() {
    dom.shopRoot.innerHTML = state.scenes.map(function (scene) {
      var footer;
      if (scene.owned) {
        footer = '<span class="shop__badge">' + escapeHtml(scene.key === state.activeScene
            ? t('shop.active', 'активна') : t('shop.owned', 'куплена')) + '</span>' +
          '<button class="btn btn--ghost" type="button" data-select="' +
          escapeHtml(scene.key) + '">' + escapeHtml(t('shop.open', 'Открыть')) + '</button>';
      } else {
        var short = scene.price - state.tokens;
        var note = short > 0
          ? '<span class="shop__need">' + escapeHtml(t('shop.short', 'не хватает')) +
            ' ' + short + ' FT</span>'
          : '';
        footer = '<span class="shop__price">' + scene.price + ' FT</span>' + note +
          '<button class="btn btn--ghost" type="button" data-preview="' +
          escapeHtml(scene.key) + '">' + escapeHtml(t('shop.preview', 'Посмотреть')) + '</button>' +
          '<button class="btn btn--accent" type="button" data-buy="' +
          escapeHtml(scene.key) + '" data-price="' + scene.price + '">' + escapeHtml(t('shop.buy', 'Купить')) + '</button>';
      }

      return '' +
        '<article class="shop__card' + (scene.owned ? ' is-owned' : '') + '">' +
          '<p class="shop__tagline">' + escapeHtml(scene.tagline) + '</p>' +
          '<h3 class="shop__name">' + escapeHtml(scene.title) + '</h3>' +
          '<p class="shop__desc">' + escapeHtml(scene.description) + '</p>' +
          '<div class="shop__foot">' + footer + '</div>' +
        '</article>';
    }).join('');

    syncAffordability();
  }

  /**
   * Применяет состояние сцены, пришедшее с сервера.
   * @param {Object} payload ответ /api/garden/ или покупки
   */
  function applySceneState(payload) {
    if (payload.scenes) { state.scenes = payload.scenes; }
    if (payload.active_scene) { state.activeScene = payload.active_scene; }
    if (typeof payload.tree_level === 'number') {
      state.treeLevel = payload.tree_level;
      dom.treeLevel.textContent = payload.tree_level;
    }
    renderTabs();
    renderShop();

    window.Stage.setLevel(state.treeLevel);
    window.Stage.mount(state.previewScene || state.activeScene);
    window.Stage.setInteractive(!state.previewScene);

  }

  // ---------------------------------------------------------------- действия


  // ------------------------------------------------------- цепочка мыслей

  /**
   * Собирает разметку поддерева.
   *
   * Рекурсия по данным, а не по DOM: сервер уже отдаёт вложенную структуру,
   * и перестраивать её обходом элементов было бы лишней работой.
   *
   * @param {Object[]} nodes узлы одного уровня
   * @returns {string}
   */
  function chainMarkup(nodes) {
    if (!nodes || !nodes.length) { return ''; }

    return '<ul class="chain__list">' + nodes.map(function (node) {
      var badge = node.generated
        ? '<span class="chain__badge">' + escapeHtml(t('chain.generated', 'модель')) + '</span>'
        : '';

      return '' +
        '<li class="chain__node">' +
          '<div class="chain__node-row' + (node.done ? ' is-done' : '') + '">' +
            '<input class="chain__check" type="checkbox" data-toggle="' + node.id + '"' +
              (node.done ? ' checked' : '') + ' aria-label="Выполнено">' +
            '<span class="chain__text" data-edit="' + node.id + '" ' +
              'title="' + escapeHtml(t('chain.editHint', 'Нажми, чтобы изменить')) + '">' +
              escapeHtml(node.text) + '</span>' +
            badge +
            '<span class="chain__actions">' +
              '<button class="chain__act" type="button" data-branch="' + node.id +
                '" title="' + escapeHtml(t('chain.branch', 'Развернуть моделью')) + '">✦</button>' +
              '<button class="chain__act" type="button" data-child="' + node.id +
                '" title="' + escapeHtml(t('chain.child', 'Добавить свой подшаг')) + '">+</button>' +
              '<button class="chain__act chain__act--danger" type="button" data-drop="' +
                node.id + '" title="' + escapeHtml(t('chain.drop', 'Удалить с потомками')) + '">×</button>' +
            '</span>' +
          '</div>' +
          chainMarkup(node.children) +
        '</li>';
    }).join('') + '</ul>';
  }

  /**
   * Создаёт поле ввода внутри строки узла.
   *
   * Собственный редактор вместо window.prompt: встроенный браузер WebView2
   * блокирует модальные диалоги JavaScript, и вызов prompt() молча
   * возвращал null — подшаг просто не добавлялся.
   *
   * @param {string} value начальный текст
   * @param {function(string):void} onCommit вызывается с непустым значением
   * @param {function():void} [onCancel] вызывается при отмене
   * @returns {HTMLInputElement}
   */
  function makeEditor(value, onCommit, onCancel) {
    var input = document.createElement('input');
    input.className = 'chain__editor';
    input.type = 'text';
    input.maxLength = 400;
    input.value = value || '';
    input.placeholder = t('chain.editorPlaceholder', 'Впиши свою мысль…');

    var settled = false;

    function commit() {
      if (settled) { return; }
      settled = true;
      var text = input.value.trim();
      if (text && text !== value) {
        onCommit(text);
      } else if (onCancel) {
        onCancel();
      }
    }

    function cancel() {
      if (settled) { return; }
      settled = true;
      if (onCancel) { onCancel(); }
    }

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', commit);

    return input;
  }

  /** Перерисовывает цепочку открытого квеста. */
  function renderChain(nodes) {
    state.chainTree = nodes || [];

    if (!state.chainTree.length) {
      dom.thoughtsRoot.innerHTML =
        '<p class="tasks__placeholder">' + escapeHtml(t('chain.empty',
        'Цепочка пуста. Впиши первую мысль внизу или попроси модель развернуть квест.')) + '</p>';
    } else {
      dom.thoughtsRoot.innerHTML = chainMarkup(state.chainTree);
    }

    if (state.chainMode === 'web') { drawWeb(); }
  }

  /**
   * Запоминает узел, в который вкладывается следующая мысль.
   *
   * Общий для списка и паутины: выбрал шар в графе — поле внизу пишет в
   * него, и наоборот. Иначе два вида жили бы каждый со своим состоянием.
   *
   * @param {?number} id идентификатор узла либо null для верхнего уровня
   * @param {?string} text текст узла для подписи
   */
  function setChainParent(id, text) {
    state.chainParent = id;
    state.chainParentText = text || '';

    dom.chainTarget.hidden = !id;
    if (id) {
      dom.chainTargetName.textContent = text || 'выбранный шаг';
      dom.thoughtInput.placeholder = t('chain.placeholderChild', 'Новая мысль внутри') +
        ' «' + (text || '').slice(0, 28) + '»…';
    } else {
      dom.thoughtInput.placeholder = t('chain.placeholder', 'Новая мысль верхнего уровня…');
    }

    if (window.ThoughtWeb) { window.ThoughtWeb.select(id); }

    // Подсветка в списке идёт тем же состоянием, что и кольцо в паутине.
    Array.prototype.forEach.call(
      dom.thoughtsRoot.querySelectorAll('.chain__node-row'),
      function (row) {
        var edit = row.querySelector('[data-edit]');
        row.classList.toggle('is-target',
          Boolean(id) && edit && parseInt(edit.dataset.edit, 10) === id);
      }
    );
  }

  /** Перерисовывает паутину по текущему дереву. */
  function drawWeb() {
    if (!window.ThoughtWeb) { return; }
    var task = state.tasks.filter(function (item) {
      return item.id === state.openTaskId;
    })[0];
    window.ThoughtWeb.render(
      dom.webCanvas, dom.thoughtsWeb, state.chainTree, task ? task.title : 'Квест',
      setChainParent
    );
    window.ThoughtWeb.select(state.chainParent);
  }

  /**
   * Переключает вид цепочки.
   * @param {string} mode list | web
   */
  function switchChainMode(mode) {
    state.chainMode = mode;
    dom.thoughtsRoot.hidden = mode !== 'list';
    dom.thoughtsWeb.hidden = mode !== 'web';

    Array.prototype.forEach.call(
      dom.chainModes.querySelectorAll('[data-chain-mode]'),
      function (button) {
        button.classList.toggle('is-active', button.dataset.chainMode === mode);
      }
    );

    if (mode === 'web') { drawWeb(); }
  }

  /** Перечитывает цепочку с сервера. */
  function reloadChain() {
    if (!state.openTaskId) { return Promise.resolve(); }
    return api.listThoughts(state.openTaskId)
      .then(renderChain)
      .catch(function (error) { toast(error.message, 'error'); });
  }

  /**
   * Заменяет текст узла полем ввода.
   *
   * @param {number} nodeId идентификатор узла
   * @param {HTMLElement} span элемент с текстом
   */
  function openTextEditor(nodeId, span) {
    if (span.dataset.editing === '1') { return; }
    span.dataset.editing = '1';

    var original = span.textContent;
    var input = makeEditor(original, function (text) {
      api.updateThought(nodeId, { text: text })
        .then(reloadChain)
        .catch(function (error) {
          toast(error.message, 'error');
          reloadChain();
        });
    }, function () {
      span.dataset.editing = '';
      input.replaceWith(span);
    });

    span.replaceWith(input);
    input.focus();
    input.select();
  }

  /**
   * Открывает поле ввода нового подшага под узлом.
   *
   * @param {number} parentId родительский узел
   * @param {HTMLElement} button нажатая кнопка «+»
   */
  function openChildEditor(parentId, button) {
    var node = button.closest('.chain__node');
    if (!node || node.querySelector('.chain__editor')) { return; }

    var list = node.querySelector(':scope > .chain__list');
    if (!list) {
      list = document.createElement('ul');
      list.className = 'chain__list';
      node.appendChild(list);
    }

    var item = document.createElement('li');
    item.className = 'chain__node';
    var row = document.createElement('div');
    row.className = 'chain__node-row';
    item.appendChild(row);
    list.appendChild(item);

    var input = makeEditor('', function (text) {
      addThought(text, parentId);
    }, function () {
      item.remove();
    });

    row.appendChild(input);
    input.focus();
  }

  /**
   * Открывает окно цепочки для квеста.
   * @param {number} taskId
   */
  function openChain(taskId) {
    var task = state.tasks.filter(function (item) { return item.id === taskId; })[0];
    state.openTaskId = taskId;
    dom.thoughtsTitle.textContent = task ? task.title : 'Квест';
    dom.thoughtsRoot.innerHTML = '<p class="tasks__placeholder">Загрузка цепочки…</p>';
    setChainParent(null, null);
    switchChainMode('list');
    openModal('thoughts');
    reloadChain();
  }

  /**
   * Просит модель развернуть узел (или весь квест, если parentId пуст).
   * @param {?number} parentId
   * @param {HTMLButtonElement} button
   */
  function expandChain(parentId, button) {
    if (!state.openTaskId) { return; }
    setBusy(button, true);

    api.expandThoughts(state.openTaskId, parentId)
      .then(function (created) {
        toast(t('chain.added', 'Добавлено шагов:') + ' ' + created.length + '.', 'info');
        return reloadChain();
      })
      .catch(function (error) { toast(error.message, 'error'); })
      .then(function () { setBusy(button, false); });
  }

  /**
   * Добавляет узел цепочки.
   * @param {string} text
   * @param {?number} parentId
   */
  function addThought(text, parentId) {
    var cleaned = (text || '').trim();
    if (!cleaned || !state.openTaskId) { return; }

    // Страховка от нечислового родителя: сервер ждёт целое либо null.
    var parent = parseInt(parentId, 10);
    if (isNaN(parent)) { parent = null; }

    api.createThought(state.openTaskId, { text: cleaned, parent_id: parent })
      .then(function () {
        dom.thoughtInput.value = '';
        return reloadChain();
      })
      .catch(function (error) { toast(error.message, 'error'); });
  }

  // ------------------------------------------------------------- Оракул

  /**
   * Добавляет реплику в ленту беседы.
   * @param {string} role user | oracle
   * @param {string} content
   * @param {boolean} [guarded] ответ выдан защитой, а не моделью
   * @returns {HTMLElement} созданный элемент
   */
  function appendBubble(role, content, guarded, key) {
    var node = document.createElement('div');
    node.className = 'bubble bubble--' + (role === 'user' ? 'user' : 'oracle') +
      (guarded ? ' bubble--guarded' : '');
    node.textContent = content;

    // Служебные реплики — приветствие, отметка об очистке, «Оракул
    // размышляет» — помечаются ключом и переводятся при смене языка.
    // Реплики беседы ключа не получают: они хранятся на сервере в том виде,
    // в котором были написаны, и переписывать историю нельзя.
    if (key) {
      node.dataset.i18n = key;
      node.dataset.i18nRu = content;
    }
    dom.oracleLog.appendChild(node);
    dom.oracleLog.scrollTop = dom.oracleLog.scrollHeight;
    return node;
  }

  /** Загружает историю беседы один раз при первом открытии вкладки. */
  function loadOracle() {
    if (state.oracleLoaded) { return; }
    state.oracleLoaded = true;

    api.oracleHistory().then(function (messages) {
      dom.oracleLog.innerHTML = '';
      if (!messages.length) {
        appendBubble('oracle',
          t('oracle.greeting', 'Спрашивай. Я отвечу коротко — длинные речи редко меняют дела.'),
          false, 'oracle.greeting');
        return;
      }
      messages.forEach(function (message) {
        appendBubble(message.role, message.content);
      });
    }).catch(function (error) {
      dom.oracleLog.innerHTML = '';
      toast(error.message, 'error');
    });
  }

  /** Отправляет вопрос Оракулу. */
  function askOracle() {
    var message = dom.oracleInput.value.trim();
    if (!message) { return; }

    appendBubble('user', message);
    dom.oracleInput.value = '';
    setBusy(dom.oracleSend, true);

    // Генерация на CPU занимает секунды: без заглушки лента выглядит зависшей.
    var pending = appendBubble('oracle', t('oracle.thinking', 'Оракул размышляет…'),
        false, 'oracle.thinking');
    pending.classList.add('bubble--typing');

    api.oracleAsk(message).then(function (result) {
      pending.remove();
      appendBubble('oracle', result.reply, result.guarded);
    }).catch(function (error) {
      pending.remove();
      toast(error.message, 'error');
    }).then(function () {
      setBusy(dom.oracleSend, false);
      dom.oracleInput.focus();
    });
  }

  // ----------------------------------------------------------- настройки

  /**
   * Применяет настройки к документу.
   *
   * Тема ставится атрибутом на <html>, а не классом на body: переменные
   * объявлены на :root, и переключение одним атрибутом перекрашивает всё
   * дерево без единого перерасчёта разметки.
   *
   * @param {Object} settings ответ /api/settings/
   */
  function applySettings(settings) {
    state.settings = settings;

    // Язык применяется до темы: подписи, зависящие от языка, должны быть
    // на месте к моменту первой отрисовки, иначе интерфейс на мгновение
    // покажет русский текст в английском режиме.
    if (window.I18n) {
      var changed = window.I18n.current() !== (settings.language || 'ru');
      window.I18n.set(settings.language || 'ru');
      renderLanguageToggle();

      // Календари собирают свою разметку один раз, поэтому при смене языка
      // их нужно пересобрать: подписи месяцев и кнопок в них уже подставлены.
      if (changed) {
        [dom.deadlinePicker, dom.editPicker].forEach(function (picker) {
          if (picker && picker.retranslate) { picker.retranslate(); }
        });

        // Лента беседы перечитывается: приветствие и служебные сообщения
        // создаются кодом, и подстановка по атрибутам их не затрагивает.
        // Сами реплики диалога при этом не переводятся — это слова
        // пользователя и ответы модели, сказанные на прежнем языке.
        if (state.oracleLoaded) {
          state.oracleLoaded = false;
          loadOracle();
        }

        // Подсказка сцены задаётся при её построении и сама не обновится.
        if (window.Stage && window.Stage.retranslateHint) {
          window.Stage.retranslateHint();
        }
      }
    }

    document.documentElement.dataset.theme = settings.theme;

    // Строка состояния окрашивается под тему: светлые значки на светлом
    // фоне становятся невидимыми.
    if (window.MobileShell) { window.MobileShell.applyTheme(settings.theme); }

    // Памятка обновляется при каждом применении настроек, поэтому следующий
    // запуск начнётся сразу с верного оформления.
    if (window.I18n) {
      window.I18n.remember(settings.language || 'ru', settings.theme);
    }
    document.documentElement.dataset.motion =
      settings.reduce_motion ? 'reduced' : 'full';

    Array.prototype.forEach.call(
      dom.themeSwitch.querySelectorAll('[data-theme-value]'),
      function (button) {
        button.classList.toggle('is-active',
          button.dataset.themeValue === settings.theme);
      }
    );

    dom.notifyToggle.checked = settings.notifications_enabled;
    dom.notifyLead.value = settings.notify_lead_minutes;
    dom.motionToggle.checked = settings.reduce_motion;
    dom.hintsToggle.checked = settings.show_hints !== false;

    Array.prototype.forEach.call(
      dom.languageSwitch.querySelectorAll('[data-language]'),
      function (button) {
        button.classList.toggle('is-active',
          button.dataset.language === (settings.language || 'ru'));
      }
    );

    dom.keyCcwValue.textContent = keyLabel(settings.rotate_ccw_key);
    dom.keyCwValue.textContent = keyLabel(settings.rotate_cw_key);

    // Ядро сцен должно знать раскладку и режим подсказок: они влияют на
    // поведение, а не только на вид настроек.
    if (window.Stage && window.Stage.applySettings) {
      window.Stage.applySettings(settings);
    }
  }

  /**
   * Обновляет подпись на кнопке языка.
   *
   * Активный код выделен, второй приглушён — так кнопка одновременно
   * показывает текущее состояние и то, во что переключит, без подписи.
   */
  function renderLanguageToggle() {
    var lang = window.I18n ? window.I18n.current() : 'ru';

    // Коды на кнопке закреплены за своими местами: слева всегда RU, справа
    // всегда EN. Меняется только подсветка. Прежде подписи переставлялись
    // местами вместе с подсветкой, и две перестановки взаимно погашались —
    // выделенным оставался код неактивного языка.
    dom.langToggle.dataset.lang = lang;
  }

  /**
   * Переключает язык интерфейса.
   *
   * Значение сохраняется на сервере, а не только в памяти страницы: от него
   * зависит язык ответов модели, включая напоминания, которые приходят при
   * закрытом окне.
   *
   * @param {string} language ru или en
   */
  function switchLanguage(language) {
    api.updateSettings({ language: language })
      .then(function (settings) {
        applySettings(settings);

        // Данные, пришедшие с сервера, содержат переведённые названия сцен
        // и приоритетов, поэтому их нужно перезапросить, а не просто
        // перерисовать имеющееся.
        return api.getGarden();
      })
      .then(function (garden) {
        applySceneState(garden);
        renderTasks();
        renderProgress();
        toast(t('toast.language', 'Язык интерфейса переключён на русский.'), 'info');
      })
      .catch(function (error) { toast(error.message, 'error'); });
  }

  /**
   * Человекочитаемая подпись кода клавиши.
   * @param {string} code KeyboardEvent.code
   * @returns {string}
   */
  function keyLabel(code) {
    if (!code) { return '—'; }
    if (code.indexOf('Key') === 0) { return code.slice(3); }
    if (code.indexOf('Digit') === 0) { return code.slice(5); }
    if (code === 'Space') { return 'Пробел'; }
    return code.replace('Arrow', '↕');
  }

  /**
   * Ждёт нажатия клавиши и сохраняет её как новую привязку.
   *
   * Слушатель одноразовый и с capture: иначе нажатие успело бы дойти до
   * ядра сцен и повернуть предмет прямо во время настройки.
   *
   * @param {string} which ccw | cw
   * @param {HTMLElement} button кнопка привязки
   */
  function captureKey(which, button) {
    button.classList.add('is-listening');
    var valueNode = which === 'ccw' ? dom.keyCcwValue : dom.keyCwValue;
    var previous = valueNode.textContent;
    valueNode.textContent = '…';

    function finish(code) {
      button.classList.remove('is-listening');
      document.removeEventListener('keydown', onKey, true);

      if (!code) {
        valueNode.textContent = previous;
        return;
      }

      var patch = {};
      patch[which === 'ccw' ? 'rotate_ccw_key' : 'rotate_cw_key'] = code;
      saveSettings(patch);
    }

    function onKey(event) {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === 'Escape') { finish(null); return; }

      var allowed = /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space)$/;
      if (!allowed.test(event.code)) {
        toast(t('toast.keyKind', 'Подойдёт буква, цифра, стрелка или пробел.'), 'error');
        return;
      }

      var other = which === 'ccw'
        ? state.settings.rotate_cw_key : state.settings.rotate_ccw_key;
      if (event.code === other) {
        toast(t('toast.keyTaken', 'Эта клавиша уже занята вторым поворотом.'), 'error');
        return;
      }

      finish(event.code);
    }

    document.addEventListener('keydown', onKey, true);
  }

  /**
   * Отправляет частичное изменение настроек.
   * @param {Object} patch только изменённые поля
   */
  function saveSettings(patch) {
    api.updateSettings(patch)
      .then(applySettings)
      .catch(function (error) { toast(error.message, 'error'); });
  }

  /**
   * Переключает вид правой панели.
   * @param {string} view scene | oracle
   */
  function switchView(view) {
    state.activeView = view;
    dom.viewScene.hidden = view !== 'scene';
    dom.viewOracle.hidden = view !== 'oracle';

    Array.prototype.forEach.call(
      dom.viewTabs.querySelectorAll('[data-view]'),
      function (button) {
        button.classList.toggle('is-active', button.dataset.view === view);
      }
    );

    if (view === 'oracle') {
      loadOracle();
      dom.oracleInput.focus();
    } else if (window.Stage && typeof window.Stage.resize === 'function') {
      // Сцена простаивала скрытой: пока панель была hidden, её ширина
      // равнялась нулю, и холст надо пересчитать по факту показа.
      window.Stage.resize();
    }
  }

  // ---------------------------------------------------- правка квестов

  /**
   * Открывает окно правки, заполняя поля текущими значениями квеста.
   * @param {number} taskId идентификатор квеста
   */
  function openEditor(taskId) {
    var task = state.tasks.filter(function (item) { return item.id === taskId; })[0];
    if (!task) { return; }

    if (task.status === 'completed') {
      toast(t('toast.completedLocked', 'Завершённый квест изменить нельзя.'), 'error');
      return;
    }

    state.editingId = taskId;
    state.editPriority = task.priority || 'normal';

    dom.editHeading.textContent = task.title;
    dom.editTitle.value = task.title;
    dom.editHours.value = task.estimated_hours;

    if (dom.editPicker && dom.editPicker.setValue) {
      dom.editPicker.setValue(task.deadline);
    }

    setEditPriority(state.editPriority);
    openModal('edit');
    dom.editTitle.focus();
  }

  /**
   * Переключает приоритет в окне правки.
   * @param {string} value low | normal | high
   */
  function setEditPriority(value) {
    state.editPriority = value;
    Array.prototype.forEach.call(
      dom.editPriority.querySelectorAll('[data-priority]'),
      function (button) {
        button.classList.toggle('is-active', button.dataset.priority === value);
      }
    );
    dom.editPriority.dataset.value = value;
    updateEditReward();
  }

  /** Пересчитывает предпросмотр награды в окне правки. */
  function updateEditReward() {
    var hours = parseInt(dom.editHours.value, 10);
    var valid = !isNaN(hours) && hours >= 1 && hours <= 24;
    var multiplier = PRIORITY_MULTIPLIER[state.editPriority] || 1;
    dom.editReward.textContent = valid
      ? String(Math.round(hours * TOKENS_PER_HOUR * multiplier))
      : '—';
  }

  /** Сохраняет изменения квеста. */
  function saveEdit() {
    if (!state.editingId) { return; }

    var title = dom.editTitle.value.trim();
    var hours = parseInt(dom.editHours.value, 10);

    if (!title) {
      toast(t('toast.emptyTitle', 'Название не может быть пустым.'), 'error');
      dom.editTitle.focus();
      return;
    }
    if (isNaN(hours) || hours < 1 || hours > 24) {
      toast(t('toast.badHours', 'Оценка должна быть от 1 до 24 часов.'), 'error');
      dom.editHours.focus();
      return;
    }

    var newDeadline = toIsoWithZone(dom.editDeadline.value);
    if (!isDeadlineValid(newDeadline)) {
      toast(t('toast.pastDeadline', 'Срок уже прошёл. Выбери время в будущем.'), 'error');
      return;
    }

    setBusy(dom.editSave, true);

    api.updateTask(state.editingId, {
      title: title,
      estimated_hours: hours,
      deadline: newDeadline,
      priority: state.editPriority
    }).then(function (task) {
      var index = state.tasks.findIndex(function (item) { return item.id === task.id; });
      if (index !== -1) { state.tasks[index] = task; }
      renderTasks();
      closeModal('edit');
      state.editingId = null;
      toast(t('toast.updated', 'Квест обновлён. Награда:') + ' ' + task.reward + ' FT.', 'success');
      return reloadProgress();
    }).catch(function (error) {
      toast(error.message, 'error');
    }).then(function () {
      setBusy(dom.editSave, false);
    });
  }

  /**
   * Удаляет квест после подтверждения вторым нажатием.
   * @param {number} taskId идентификатор квеста
   * @param {HTMLElement} button нажатая кнопка
   */
  function removeTask(taskId, button) {
    // Диалоги браузера в WebView2 недоступны, поэтому необратимое действие
    // подтверждается повторным нажатием той же кнопки.
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = '✓';
      button.title = t('task.deleteConfirm', 'Нажми ещё раз, чтобы удалить квест');
      button.classList.add('chain__act--armed');
      window.setTimeout(function () {
        if (!button.isConnected) { return; }
        button.dataset.armed = '';
        button.textContent = '×';
        button.title = t('task.delete', 'Удалить квест');
        button.classList.remove('chain__act--armed');
      }, 3000);
      return;
    }

    api.deleteTask(taskId).then(function () {
      state.tasks = state.tasks.filter(function (item) { return item.id !== taskId; });
      renderTasks();
      toast(t('toast.deleted', 'Квест удалён.'), 'info');
      return Promise.all([reloadProgress(), api.getGarden().then(applySceneState)]);
    }).catch(function (error) {
      toast(error.message, 'error');
    });
  }

  /** Пересчитывает предпросмотр награды при вводе часов. */
  function updateRewardPreview() {
    var hours = parseInt(dom.hours.value, 10);
    var valid = !isNaN(hours) && hours >= 1 && hours <= 24;
    var multiplier = PRIORITY_MULTIPLIER[state.priority] || 1;
    dom.rewardPreview.textContent = valid
      ? String(Math.round(hours * TOKENS_PER_HOUR * multiplier))
      : '—';
  }

  /**
   * Переключает приоритет нового квеста.
   * @param {string} value low | normal | high
   */
  function setPriority(value) {
    state.priority = value;
    Array.prototype.forEach.call(
      dom.prioritySwitch.querySelectorAll('[data-priority]'),
      function (button) {
        button.classList.toggle('is-active', button.dataset.priority === value);
      }
    );
    dom.prioritySwitch.dataset.value = value;
    updateRewardPreview();
  }

  /**
   * Создаёт квест. Генерация фразы идёт на сервере и занимает время,
   * поэтому кнопка блокируется до ответа.
   */
  function handleCreate() {
    var title = dom.title.value.trim();
    var hours = parseInt(dom.hours.value, 10);

    if (!title) {
      toast(t('toast.needTitle', 'Впиши, что нужно сделать.'), 'error');
      dom.title.focus();
      return;
    }
    if (isNaN(hours) || hours < 1 || hours > 24) {
      toast(t('toast.badHours', 'Оценка должна быть от 1 до 24 часов.'), 'error');
      dom.hours.focus();
      return;
    }

    var deadline = toIsoWithZone(dom.deadline.value);
    if (!isDeadlineValid(deadline)) {
      toast(t('toast.pastDeadline', 'Срок уже прошёл. Выбери время в будущем.'), 'error');
      return;
    }

    setBusy(dom.createBtn, true);

    api.createTask({
      title: title,
      estimated_hours: hours,
      deadline: deadline,
      priority: state.priority
    }).then(function (task) {
      state.tasks.unshift(task);
      renderTasks();
      dom.title.value = '';
      if (dom.deadlinePicker && dom.deadlinePicker.reset) {
        dom.deadlinePicker.reset();
      } else {
        dom.deadline.value = '';
      }
      dom.title.focus();
      toast(t('toast.created', 'Квест принят. Награда:') + ' ' + task.reward + ' FT.', 'success');
    }).catch(function (error) {
      toast(error.message, 'error');
    }).then(function () {
      setBusy(dom.createBtn, false);
    });
  }

  /**
   * Завершает квест: начисляет токены и запускает отклик сцены.
   * @param {number} taskId
   * @param {HTMLButtonElement} button
   */
  function handleComplete(taskId, button) {
    setBusy(button, true);

    api.completeTask(taskId).then(function (result) {
      var index = state.tasks.findIndex(function (task) { return task.id === taskId; });
      if (index !== -1) { state.tasks[index] = result.task; }

      renderTasks();
      renderTokens(result.focus_tokens);

      if (result.tree_level !== state.treeLevel) {
        state.treeLevel = result.tree_level;
        dom.treeLevel.textContent = result.tree_level;
        window.Stage.setLevel(result.tree_level);
        toast(t('toast.levelUp', 'Уровень вырос до') + ' ' + result.tree_level +
          t('toast.levelUpTail', '. Сцена стала богаче.'), 'info');
      }

      // Отклик соразмерен вложенным часам: чем крупнее квест, тем заметнее.
      window.Stage.celebrate(Math.max(1, Math.min(result.task.estimated_hours, 6)));

      toast('+' + result.tokens_earned + ' FT ' + t('toast.completedFor', 'за') +
        ' «' + result.task.title + '».', 'success');
      reloadProgress();
    }).catch(function (error) {
      toast(error.message, 'error');
      setBusy(button, false);
    });
  }

  /**
   * Покупает сцену и сразу её открывает.
   * @param {string} key
   * @param {HTMLButtonElement} button
   */
  function handlePurchase(key, button) {
    setBusy(button, true);

    api.purchaseScene(key).then(function (result) {
      state.previewScene = null;
      window.Stage.setInteractive(true);
      renderTokens(result.focus_tokens);
      applySceneState(result);
      toast(t('toast.scenePurchased', 'Сцена открыта. Списано') + ' ' +
        result.tokens_spent + ' FT.', 'success');
      closeModal('shop');
    }).catch(function (error) {
      toast(error.message, 'error');
      setBusy(button, false);
    });
  }

  /**
   * Переключает активную сцену.
   * @param {string} key
   */
  function handleSelect(key) {
    if (key === state.activeScene) { closeModal('shop'); return; }

    api.selectScene(key).then(function (result) {
      state.activeScene = result.active_scene;
      state.scenes = state.scenes.map(function (scene) {
        return Object.assign({}, scene, { active: scene.key === result.active_scene });
      });
      renderTabs();
      renderShop();
      window.Stage.mount(result.active_scene);
      closeModal('shop');
    }).catch(function (error) {
      toast(error.message, 'error');
    });
  }

  var MODALS = {};

  /**
   * Делает модальное окно перетаскиваемым за шапку.
   *
   * Позиция задаётся через ``transform``, а не ``left/top``: трансформация
   * не вызывает пересчёта разметки и, в отличие от смены позиционирования,
   * не разрывает ``backdrop-filter`` — стекло продолжает преломлять фон
   * во время перетаскивания.
   *
   * @param {HTMLElement} panel окно
   * @param {HTMLElement} handle элемент-ручка
   */
  function makeDraggable(panel, handle) {
    var offset = { x: 0, y: 0 };
    var origin = { x: 0, y: 0 };
    var dragging = false;

    handle.addEventListener('pointerdown', function (event) {
      // Клик по кнопке закрытия не должен превращаться в перетаскивание.
      if (event.button !== 0 || event.target.closest('[data-close]')) { return; }

      dragging = true;
      origin.x = event.clientX - offset.x;
      origin.y = event.clientY - offset.y;
      panel.classList.add('is-dragging');

      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        /* захват указателя не критичен */
      }
      event.preventDefault();
    });

    handle.addEventListener('pointermove', function (event) {
      if (!dragging) { return; }

      var next = { x: event.clientX - origin.x, y: event.clientY - origin.y };
      var rect = panel.getBoundingClientRect();

      // Ограничение по экрану: окно, утащенное за край, вернуть было бы
      // нечем — шапка вместе с ним ушла бы из зоны видимости.
      var maxX = window.innerWidth - 80 - (rect.left - offset.x);
      var minX = 80 - (rect.right - offset.x);
      var maxY = window.innerHeight - 60 - (rect.top - offset.y);
      var minY = -(rect.top - offset.y);

      offset.x = Math.min(maxX, Math.max(minX, next.x));
      offset.y = Math.min(maxY, Math.max(minY, next.y));
      panel.style.transform = 'translate(' + offset.x + 'px, ' + offset.y + 'px)';
    });

    function stop(event) {
      if (!dragging) { return; }
      dragging = false;
      panel.classList.remove('is-dragging');
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* уже отпущен */
      }
    }

    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  /**
   * Открывает модальное окно по имени.
   * @param {string} name shop | thoughts | settings
   */
  /**
   * Показывает запертую сцену без покупки.
   *
   * Монтирование чисто клиентское: сервер о предпросмотре не знает, ничего
   * не списывает и активную сцену не меняет. Так пользователь видит, за что
   * платит, — иначе цена назначена вслепую.
   *
   * @param {string} key ключ сцены
   */
  function previewScene(key) {
    var scene = state.scenes.filter(function (item) { return item.key === key; })[0];
    if (!scene) { return; }

    if (scene.owned) {
      handleSelect(key);
      return;
    }

    state.previewScene = key;
    renderTabs();
    setPriority('normal');
    switchView('scene');
    window.Stage.mount(key);
    // Смотреть можно, трогать — нет: иначе покупка ничего не добавляет.
    window.Stage.setInteractive(false);
    closeModal('shop');
    toast('«' + scene.title + '» ' + t('preview.viewOnly', '— только просмотр.'), 'info');
  }

  /** Возвращает купленную активную сцену после предпросмотра. */
  function exitPreview() {
    if (!state.previewScene) { return; }
    state.previewScene = null;
    renderTabs();
    window.Stage.mount(state.activeScene);
    window.Stage.setInteractive(true);
  }

  function openModal(name) {
    var modal = MODALS[name];
    if (!modal) { return; }

    modal.hidden = false;

    // Класс появления снимается по окончании анимации: иначе её финальный
    // transform перебивал бы позицию, заданную перетаскиванием.
    var panel = modal.querySelector('.modal__panel');
    if (panel) {
      panel.classList.add('is-entering');
      window.setTimeout(function () { panel.classList.remove('is-entering'); }, 300);
    }
  }

  function closeModal(name) {
    if (MODALS[name]) { MODALS[name].hidden = true; }
  }

  function closeAllModals() {
    Object.keys(MODALS).forEach(function (name) { MODALS[name].hidden = true; });
  }

  /** Отражает наличие локальной модели в шапке. */
  function refreshEngineStatus() {
    /**
     * Записывает состояние вместе с ключом перевода.
     *
     * Ключ хранится в самом элементе, поэтому при смене языка подстановка
     * возьмёт актуальное состояние, а не исходное «проверка модели…»,
     * записанное в разметке.
     *
     * @param {string} state online | fallback | offline
     * @param {string} key ключ словаря
     * @param {string} ru русский текст
     */
    function setState(state, key, ru) {
      dom.engine.dataset.state = state;
      dom.engineText.dataset.i18n = key;
      dom.engineText.dataset.i18nRu = ru;
      dom.engineText.textContent = t(key, ru);
    }

    // Загрузка весов на телефоне занимает секунды, поэтому одного опроса
    // при запуске недостаточно: он застал бы модель в состоянии загрузки
    // и навсегда оставил бы в шапке «модель не найдена». Опрос
    // повторяется, пока состояние не станет окончательным.
    //
    // Настольной версии это не касается: там модель загружает сервер до
    // ответа на первый запрос, и промежуточного состояния не бывает —
    // поле llm_status в ответе отсутствует, и повтор не назначается.
    var RECHECK_DELAY_MS = 1500;
    var RECHECK_LIMIT = 120;          // около трёх минут
    var rechecks = 0;

    function apply(info) {
      if (info.llm_available) {
        setState('online', 'engine.online', 'локальная модель активна');
        return;
      }

      var pending = info.llm_status === 'loading' || info.llm_status === 'idle';
      if (pending && rechecks < RECHECK_LIMIT) {
        setState('loading', 'engine.loading', 'модель загружается…');
        rechecks += 1;
        window.setTimeout(check, RECHECK_DELAY_MS);
        return;
      }

      setState('fallback', 'engine.fallback', 'модель не найдена · резервные фразы');
    }

    function check() {
      api.health().then(apply).catch(function () {
        setState('offline', 'engine.offline', 'бэкенд недоступен');
      });
    }

    check();
  }

  // -------------------------------------------------------------------- старт

  function bindEvents() {
    dom.createBtn.addEventListener('click', handleCreate);

    dom.title.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleCreate();
      }
    });

    dom.hours.addEventListener('input', updateRewardPreview);

    dom.prioritySwitch.addEventListener('click', function (event) {
      var button = event.target.closest('[data-priority]');
      if (button) { setPriority(button.dataset.priority); }
    });

    dom.agendaGrid.addEventListener('click', function (event) {
      var day = event.target.closest('[data-day]');
      if (day) { focusDay(parseInt(day.dataset.day, 10)); }
    });

    dom.agendaPrev.addEventListener('click', function () {
      var view = state.agendaMonth || new Date();
      state.agendaMonth = new Date(view.getFullYear(), view.getMonth() - 1, 1);
      renderAgenda();
    });

    dom.editSave.addEventListener('click', saveEdit);
    dom.editHours.addEventListener('input', updateEditReward);
    dom.editTitle.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveEdit();
      }
    });
    dom.editPriority.addEventListener('click', function (event) {
      var button = event.target.closest('[data-priority]');
      if (button) { setEditPriority(button.dataset.priority); }
    });

    dom.agendaNext.addEventListener('click', function () {
      var view = state.agendaMonth || new Date();
      state.agendaMonth = new Date(view.getFullYear(), view.getMonth() + 1, 1);
      renderAgenda();
    });

    // Делегирование: списки перерисовываются целиком, и отдельные слушатели
    // пришлось бы вешать заново после каждого рендера.
    dom.tasksRoot.addEventListener('click', function (event) {
      var complete = event.target.closest('[data-complete]');
      if (complete) {
        handleComplete(parseInt(complete.dataset.complete, 10), complete);
        return;
      }
      var chain = event.target.closest('[data-chain]');
      if (chain) { openChain(parseInt(chain.dataset.chain, 10)); return; }

      var edit = event.target.closest('[data-edit-task]');
      if (edit) { openEditor(parseInt(edit.dataset.editTask, 10)); return; }

      var drop = event.target.closest('[data-drop-task]');
      if (drop) { removeTask(parseInt(drop.dataset.dropTask, 10), drop); return; }

      if (event.target.closest('#toggle-done')) {
        state.showDone = !state.showDone;
        renderTasks();
      }
    });

    // ---- правая колонка: сцена или Оракул ----
    dom.viewTabs.addEventListener('click', function (event) {
      var button = event.target.closest('[data-view]');
      if (button) { switchView(button.dataset.view); }
    });

    // ---- Оракул ----
    dom.oracleSend.addEventListener('click', askOracle);

    dom.oracleTerms.addEventListener('click', function () {
      openModal('terms');
    });
    dom.oracleInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        askOracle();
      }
    });
    dom.oracleClear.addEventListener('click', function () {
      // Второе нажатие подтверждает: беседа удаляется безвозвратно, а
      // диалоги браузера в WebView2 недоступны.
      if (dom.oracleClear.dataset.armed !== '1') {
        dom.oracleClear.dataset.armed = '1';
        dom.oracleClear.textContent = t('oracle.clearConfirm', 'Точно очистить?');
        dom.oracleClear.classList.add('link-btn--armed');
        window.setTimeout(function () {
          dom.oracleClear.dataset.armed = '';
          dom.oracleClear.textContent = t('oracle.clear', 'Очистить беседу');
          dom.oracleClear.classList.remove('link-btn--armed');
        }, 3000);
        return;
      }

      dom.oracleClear.dataset.armed = '';
      dom.oracleClear.textContent = t('oracle.clear', 'Очистить беседу');
      dom.oracleClear.classList.remove('link-btn--armed');

      api.oracleClear().then(function () {
        dom.oracleLog.innerHTML = '';
        appendBubble('oracle', t('oracle.cleared', 'Беседа очищена. Начнём заново.'),
          false, 'oracle.cleared');
      }).catch(function (error) { toast(error.message, 'error'); });
    });

    // ---- цепочка мыслей ----
    dom.thoughtAdd.addEventListener('click', function () {
      addThought(dom.thoughtInput.value, state.chainParent);
    });
    dom.thoughtInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        addThought(dom.thoughtInput.value, state.chainParent);
      }
    });
    dom.thoughtExpand.addEventListener('click', function () {
      // Разворачивается выбранный узел, а не корень цепочки: иначе
      // предложенные шаги оказывались бы на верхнем уровне независимо от
      // того, какую ветвь пользователь детализирует.
      expandChain(state.chainParent, dom.thoughtExpand);
    });
    dom.chainTargetClear.addEventListener('click', function () {
      setChainParent(null, null);
    });

    dom.chainModes.addEventListener('click', function (event) {
      var button = event.target.closest('[data-chain-mode]');
      if (button) { switchChainMode(button.dataset.chainMode); }
    });

    dom.thoughtsRoot.addEventListener('change', function (event) {
      var box = event.target.closest('[data-toggle]');
      if (!box) { return; }
      api.updateThought(parseInt(box.dataset.toggle, 10), { done: box.checked })
        .then(reloadChain)
        .catch(function (error) { toast(error.message, 'error'); });
    });

    dom.thoughtsRoot.addEventListener('click', function (event) {
      var branch = event.target.closest('[data-branch]');
      if (branch) {
        expandChain(parseInt(branch.dataset.branch, 10), branch);
        return;
      }

      var child = event.target.closest('[data-child]');
      if (child) {
        openChildEditor(parseInt(child.dataset.child, 10), child);
        return;
      }

      var edit = event.target.closest('[data-edit]');
      if (edit) {
        openTextEditor(parseInt(edit.dataset.edit, 10), edit);
        return;
      }

      var row = event.target.closest('.chain__node-row');
      if (row) {
        var marker = row.querySelector('[data-edit]');
        if (marker) {
          var id = parseInt(marker.dataset.edit, 10);
          setChainParent(state.chainParent === id ? null : id,
            state.chainParent === id ? null : marker.textContent);
        }
      }

      var drop = event.target.closest('[data-drop]');
      if (drop) {
        // Удаление уносит поддерево, поэтому нужно подтверждение. Диалоги
        // window.confirm() встроенный браузер WebView2 блокирует, и вызов
        // молча возвращал бы отказ — подтверждаем двумя нажатиями.
        if (drop.dataset.armed !== '1') {
          drop.dataset.armed = '1';
          drop.textContent = '✓';
          drop.title = t('chain.dropConfirm', 'Нажми ещё раз, чтобы удалить вместе с подшагами');
          drop.classList.add('chain__act--armed');
          window.setTimeout(function () {
            if (!drop.isConnected) { return; }
            drop.dataset.armed = '';
            drop.textContent = '×';
            drop.title = t('chain.drop', 'Удалить с потомками');
            drop.classList.remove('chain__act--armed');
          }, 3000);
          return;
        }

        api.deleteThought(parseInt(drop.dataset.drop, 10))
          .then(reloadChain)
          .catch(function (error) { toast(error.message, 'error'); });
      }
    });

    // ---- настройки ----
    dom.openSettings.addEventListener('click', function () { openModal('settings'); });

    dom.themeSwitch.addEventListener('click', function (event) {
      var button = event.target.closest('[data-theme-value]');
      if (button) { saveSettings({ theme: button.dataset.themeValue }); }
    });

    dom.notifyToggle.addEventListener('change', function () {
      var wanted = dom.notifyToggle.checked;
      saveSettings({ notifications_enabled: wanted });

      if (!wanted || !window.MobileNotify) {
        if (window.MobileNotify) { window.MobileNotify.clear(); }
        return;
      }

      // Разрешение спрашивается в момент включения, а не при запуске: запрос
      // без понятной причины пользователи отклоняют, а вернуть его потом
      // можно только через настройки системы.
      window.MobileNotify.enable().then(function (allowed) {
        if (!allowed) {
          dom.notifyToggle.checked = false;
          saveSettings({ notifications_enabled: false });
          toast(t('toast.notifyDenied',
            'Уведомления запрещены в настройках устройства.'), 'error');
          return;
        }
        resyncReminders();
      });
    });

    dom.motionToggle.addEventListener('change', function () {
      saveSettings({ reduce_motion: dom.motionToggle.checked });
    });

    dom.hintsToggle.addEventListener('change', function () {
      saveSettings({ show_hints: dom.hintsToggle.checked });
      if (dom.hintsToggle.checked && window.Stage) { window.Stage.showHint(); }
    });

    [dom.keyCcw, dom.keyCw].forEach(function (button) {
      button.addEventListener('click', function () {
        captureKey(button.dataset.bind, button);
      });
    });

    dom.notifyLead.addEventListener('change', function () {
      var minutes = parseInt(dom.notifyLead.value, 10);
      if (isNaN(minutes) || minutes < 5 || minutes > 1440) {
        dom.notifyLead.value = state.settings.notify_lead_minutes;
        toast(t('toast.leadRange', 'Предупреждение возможно от 5 минут до суток.'), 'error');
        return;
      }
      saveSettings({ notify_lead_minutes: minutes });
      resyncReminders();
    });

    // ---- общее закрытие модальных окон ----
    document.addEventListener('click', function (event) {
      var closer = event.target.closest('[data-close]');
      if (closer) { closeModal(closer.dataset.close); }
    });

    dom.sceneTabs.addEventListener('click', function (event) {
      var button = event.target.closest('[data-scene]');
      if (!button) { return; }

      var key = button.dataset.scene;
      var scene = state.scenes.filter(function (item) { return item.key === key; })[0];
      if (scene && !scene.owned) {
        previewScene(key);
      } else {
        exitPreview();
        handleSelect(key);
      }
    });

    dom.previewExit.addEventListener('click', exitPreview);
    dom.previewBuy.addEventListener('click', function () {
      if (dom.previewBuy.dataset.buy) {
        handlePurchase(dom.previewBuy.dataset.buy, dom.previewBuy);
      }
    });

    dom.shopRoot.addEventListener('click', function (event) {
      var preview = event.target.closest('[data-preview]');
      if (preview) { previewScene(preview.dataset.preview); return; }

      var buy = event.target.closest('[data-buy]');
      if (buy) { handlePurchase(buy.dataset.buy, buy); return; }

      var select = event.target.closest('[data-select]');
      if (select) { handleSelect(select.dataset.select); }
    });

    dom.langToggle.addEventListener('click', function () {
      switchLanguage(window.I18n ? window.I18n.other() : 'en');
    });

    dom.languageSwitch.addEventListener('click', function (event) {
      var button = event.target.closest('[data-language]');
      if (button && button.dataset.language !== (window.I18n && window.I18n.current())) {
        switchLanguage(button.dataset.language);
      }
    });

    dom.resetScene.addEventListener('click', function () {
      var scene = state.scenes.filter(function (item) {
        return item.key === (state.previewScene || state.activeScene);
      })[0];

      if (!window.Stage.reset()) {
        toast(t('scene.unavailable', 'Сцена недоступна.'), 'error');
        return;
      }

      // Уровень и режим взаимодействия задаются заново: пересозданная сцена
      // о них не знает, а в предпросмотре она должна остаться недоступной
      // для ввода.
      window.Stage.setLevel(state.treeLevel);
      window.Stage.setInteractive(!state.previewScene);

      toast('«' + (scene ? scene.title : t('scene.tab', 'Сцена')) + '» — ' +
        t('scene.resetDone', 'возвращена в исходное состояние.'), 'info');
    });

    dom.openShop.addEventListener('click', function () {
      renderShop();
      openModal('shop');
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeAllModals(); }
    });
  }

  /**
   * Точка входа приложения.
   *
   * Порядок шагов существен. Экран загрузки показывается первым, чтобы
   * пользователь не видел незаполненный интерфейс. Настройки применяются
   * до отрисовки данных, иначе тема успела бы мигнуть тёмной и
   * перекраситься. Остальные шаги изолированы друг от друга: сбой одного
   * не должен оставлять приложение с пустым экраном.
   */
  /**
   * Готовит локальное хранилище, если сервер недоступен.
   *
   * Признаком мобильной сборки служит наличие модуля: он подключается
   * только в ней. Настольная версия файл не загружает и продолжает
   * работать через сервер.
   *
   * @returns {Promise<void>}
   */
  function prepareStorage() {
    if (!window.LocalAPI) { return Promise.resolve(); }
    return window.LocalAPI.init().then(function () {
      window.LocalAPI.ready = true;
    });
  }

  /**
   * Обрабатывает аппаратную кнопку «назад».
   *
   * Порядок проверок повторяет вложенность интерфейса: сначала закрывается
   * самое верхнее из открытого. Возврат ``false`` означает, что закрывать
   * нечего, и оболочка свернёт приложение.
   *
   * @returns {boolean} было ли нажатие обработано
   */
  function handleBackButton() {
    var openModal = Object.keys(MODALS).filter(function (name) {
      return MODALS[name] && !MODALS[name].hidden;
    })[0];

    if (openModal) {
      closeModal(openModal);
      return true;
    }

    // Предпросмотр сцены — тоже состояние, из которого ожидают выйти назад.
    if (state.previewScene) {
      exitPreview();
      return true;
    }

    // Из беседы с Оракулом возвращаемся к сцене: это переключение вида,
    // а не отдельный экран, но воспринимается именно как вложенность.
    if (state.activeView === 'oracle') {
      switchView('scene');
      return true;
    }

    return false;
  }

  /**
   * Перечитывает данные после длительного отсутствия.
   *
   * За время, пока приложение было свёрнуто, сроки могли пройти, а
   * напоминания — сработать. Состояние приводится в соответствие
   * действительности без перезапуска.
   */
  function handleResume() {
    api.sweepOverdue().then(function (sweep) {
      if (sweep && sweep.failed && sweep.failed.length) {
        renderTokens(sweep.focus_tokens);
        toast(
          t('toast.overdue', 'Просрочено квестов:') + ' ' + sweep.failed.length +
          '. ' + sweep.tokens_lost + ' FT ' + t('toast.overdueTail', 'списано.'),
          'error'
        );
      }
      return api.listTasks();
    }).then(function (tasks) {
      state.tasks = tasks;
      renderTasks();
      return reloadProgress();
    }).catch(function () {
      // Возвращение не должно оборачиваться сообщением об ошибке: данные
      // на экране остаются прежними, и это лучше, чем пустой список.
    });
  }

  function boot() {
    // Запомненное оформление применяется до показа заставки: иначе цитата
    // всегда была бы на языке по умолчанию, а светлая тема мигала бы
    // тёмным фоном, пока не придут настройки.
    if (window.I18n) { window.I18n.restore(); }

    if (window.Splash) { window.Splash.show(); }

    cacheDom();

    MODALS.shop = dom.shopModal;
    MODALS.thoughts = dom.thoughtsModal;
    MODALS.settings = dom.settingsModal;
    MODALS.terms = dom.termsModal;
    MODALS.edit = dom.editModal;

    Object.keys(MODALS).forEach(function (name) {
      var panel = MODALS[name].querySelector('.modal__panel');
      var handle = MODALS[name].querySelector('.modal__head');
      if (panel && handle) { makeDraggable(panel, handle); }
    });

    // Системные виджеты Windows заменяются своими: календарь и стрелки
    // числового поля не поддаются стилизации и выпадают из оформления.
    if (window.Controls) {
      window.Controls.stepper(dom.hours);
      dom.deadlinePicker = window.Controls.dateTimePicker(dom.deadline);
      window.Controls.stepper(dom.notifyLead);
      window.Controls.stepper(dom.editHours);
      dom.editPicker = window.Controls.dateTimePicker(dom.editDeadline);
    }

    // Настройка клавиш поворота скрывается на сенсорных устройствах:
    // клавиатуры там нет, и вместо клавиш работают экранные кнопки в углу
    // сцены. Оставленная на виду, она обещает возможность, которой нет.
    if (dom.settingKeys && window.TouchControls && window.TouchControls.isNeeded()) {
      dom.settingKeys.hidden = true;
    }

    if (window.MobileShell) {
      window.MobileShell.init({
        onBack: handleBackButton,
        onResume: handleResume
      });
    }

    bindEvents();
    updateRewardPreview();

    // Настройки применяются до первой отрисовки данных, иначе интерфейс
    // мигнёт тёмным и перекрасится. Но запрашиваются они уже после
    // подготовки хранилища — см. startSession.

    try {
      window.Stage.init({
        canvas: dom.canvas,
        host: dom.stage,
        hint: dom.stageHint,
        fallback: dom.stageFallback
      });
    } catch (error) {
      console.error('Ядро сцен не запустилось:', error);
      toast('Сцена недоступна: ' + error.message, 'error');
    }

    // Каждый шаг запуска изолирован: исключение в одном не должно оставить
    // приложение с пустым экраном, как это случилось с отсутствующим
    // Stage.resize() — одна ошибка обрывала загрузку задач и сцен.
    try {
      switchView('scene');
    } catch (error) {
      console.error('Не удалось переключить вид:', error);
    }

    // Подготовка хранилища предшествует любому запросу. В мобильной сборке
    // сервера нет, и обращение, отправленное раньше, ушло бы в пустоту:
    // приложение сообщило бы о недоступности при полностью исправной
    // работе.
    prepareStorage().then(startSession);
  }

  /**
   * Загружает данные и снимает экран загрузки.
   *
   * Выделено из запуска: в мобильной сборке этому шагу предшествует
   * подготовка хранилища, и объединение оставило бы вложенные обещания.
   */
  function startSession() {
    // Проверка наличия модели — тоже обращение к данным, поэтому она
    // выполняется здесь, а не в boot: в мобильной сборке запрос, ушедший
    // раньше готовности хранилища, попадает в пустоту.
    refreshEngineStatus();

    api.getSettings().then(applySettings).catch(function () {
      /* значения по умолчанию уже в разметке */
    });

    // Просрочка проверяется до загрузки списка: пока приложение было
    // закрыто, сроки могли пройти, и пользователь должен увидеть это сразу,
    // а не после первого же обновления.
    api.sweepOverdue().then(function (sweep) {
      if (sweep && sweep.failed && sweep.failed.length) {
        renderTokens(sweep.focus_tokens);
        toast(
          t('toast.overdue', 'Просрочено квестов:') + ' ' + sweep.failed.length +
          '. ' + sweep.tokens_lost + ' FT ' + t('toast.overdueTail', 'списано.'),
          'error'
        );
      }
    }).catch(function () {
      /* проверка не критична: список всё равно загрузится */
    });

    Promise.all([api.listTasks(), api.getGarden()])
      .then(function (results) {
        state.tasks = results[0];
        renderTasks();

        var garden = results[1];
        renderTokens(garden.focus_tokens);
        applySceneState(garden);
      })
      .then(function () {
        return reloadProgress();
      })
      .then(function () {
        if (window.Splash) { window.Splash.hide(); }
      })
      .catch(function (error) {
        dom.tasksRoot.setAttribute('aria-busy', 'false');
        dom.tasksRoot.innerHTML =
          '<p class="tasks__placeholder">Не удалось загрузить данные: ' +
          escapeHtml(error.message) + '</p>';
        toast(error.message, 'error');
        // Экран загрузки обязан уйти и при сбое: иначе приложение навсегда
        // остаётся заставкой без единого объяснения.
        if (window.Splash) { window.Splash.hide(); }
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
