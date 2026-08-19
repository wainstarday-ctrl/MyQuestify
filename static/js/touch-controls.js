/**
 * MyQuestify — экранные органы управления сценами.
 *
 * Часть сцен рассчитана на клавиатуру: Лаборатория Идей наклоняет колбу
 * клавишами поворота. На телефоне клавиатуры нет, и без экранной замены
 * сцена оказывается недоступной — не сломанной, а именно недоступной, что
 * заметить труднее и объяснить нечем.
 *
 * Кнопки появляются только тогда, когда выполнены оба условия: устройство
 * сенсорное и активная сцена объявила, что принимает нажатия клавиш. На
 * настольной машине они не показываются, чтобы не занимать место и не
 * дублировать то, для чего есть клавиатура.
 *
 * Модуль подаёт сцене те же события, что и настоящая клавиатура, поэтому
 * сцены о нём не знают и не содержат ветвлений под сенсорный ввод.
 *
 * Экспортирует `window.TouchControls`.
 */
(function (global) {
  'use strict';

  /** Частота повторной подачи события при удержании кнопки. */
  var REPEAT_MS = 30;

  var host = null;
  var panel = null;
  var enabled = false;
  var keys = { ccw: 'KeyQ', cw: 'KeyE' };

  /**
   * Определяет, нужны ли экранные кнопки.
   *
   * Признаком служит грубый указатель: он означает палец, а не мышь.
   * Проверка по ширине окна была бы ненадёжной — узкое окно на настольной
   * машине не отменяет наличия клавиатуры.
   *
   * @returns {boolean}
   */
  function isTouchDevice() {
    if (global.matchMedia && global.matchMedia('(pointer: coarse)').matches) {
      return true;
    }
    return 'ontouchstart' in global;
  }

  /**
   * Создаёт панель кнопок внутри контейнера сцены.
   *
   * @param {HTMLElement} container элемент сцены
   */
  function build(container) {
    if (panel) { return; }

    panel = document.createElement('div');
    panel.className = 'touch-keys';
    panel.hidden = true;

    panel.innerHTML =
      '<button class="touch-keys__btn" type="button" data-turn="ccw" ' +
        'aria-label="Наклонить против часовой">' +
        '<span class="touch-keys__glyph">↺</span>' +
      '</button>' +
      '<button class="touch-keys__btn" type="button" data-turn="cw" ' +
        'aria-label="Наклонить по часовой">' +
        '<span class="touch-keys__glyph">↻</span>' +
      '</button>';

    container.appendChild(panel);
    bind();
  }

  /**
   * Подаёт сцене событие нажатия клавиши.
   *
   * События создаются настоящими объектами KeyboardEvent и рассылаются на
   * документ: ядро сцен слушает именно его, и подмена оказывается
   * неотличимой от работы клавиатуры.
   *
   * @param {string} type keydown или keyup
   * @param {string} code код клавиши
   */
  function emit(type, code) {
    var event;
    try {
      event = new KeyboardEvent(type, { code: code, bubbles: true, cancelable: true });
    } catch (error) {
      // Старые встроенные браузеры не поддерживают конструктор события.
      event = document.createEvent('Event');
      event.initEvent(type, true, true);
      event.code = code;
    }
    global.dispatchEvent(event);
  }

  function bind() {
    var timers = {};

    /**
     * Начинает подачу нажатия и повторяет её, пока кнопку держат.
     * @param {string} which ccw или cw
     */
    function press(which) {
      var code = keys[which];
      emit('keydown', code);

      // Ядро сцен считает удержание по состоянию клавиши, но браузер не
      // повторяет keydown сам, поэтому событие подаётся заново.
      timers[which] = global.setInterval(function () {
        emit('keydown', code);
      }, REPEAT_MS);
    }

    function release(which) {
      global.clearInterval(timers[which]);
      timers[which] = null;
      emit('keyup', keys[which]);
    }

    Array.prototype.forEach.call(panel.querySelectorAll('[data-turn]'), function (button) {
      var which = button.dataset.turn;

      button.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        button.classList.add('is-held');
        // Захват указателя нужен, чтобы отпускание за пределами кнопки тоже
        // прекращало вращение: иначе колба крутилась бы бесконечно.
        try { button.setPointerCapture(event.pointerId); } catch (error) { /* необязательно */ }
        press(which);
      });

      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
        button.addEventListener(name, function () {
          if (!timers[which]) { return; }
          button.classList.remove('is-held');
          release(which);
        });
      });
    });
  }

  global.TouchControls = {
    /**
     * Подключает панель к контейнеру сцены.
     *
     * @param {HTMLElement} container элемент, внутри которого рисуется сцена
     */
    init: function (container) {
      host = container;
      enabled = isTouchDevice();
      if (enabled && host) { build(host); }
    },

    /**
     * Принимает раскладку клавиш из настроек.
     *
     * Экранные кнопки подают те же коды, что назначены в настройках: иначе
     * переназначение клавиш на настольной машине рассогласовало бы поведение
     * сцены между устройствами.
     *
     * @param {Object} settings фрагмент настроек
     */
    configure: function (settings) {
      if (!settings) { return; }
      if (settings.rotate_ccw_key) { keys.ccw = settings.rotate_ccw_key; }
      if (settings.rotate_cw_key) { keys.cw = settings.rotate_cw_key; }
    },

    /**
     * Показывает или скрывает панель.
     *
     * @param {boolean} needed принимает ли текущая сцена нажатия клавиш
     */
    setVisible: function (needed) {
      if (!panel) { return; }
      panel.hidden = !(enabled && needed);
    },

    /** Нужны ли экранные кнопки на этом устройстве. */
    isNeeded: function () { return enabled; }
  };
}(window));
