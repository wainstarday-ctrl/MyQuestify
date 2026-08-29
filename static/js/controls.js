/**
 * MyQuestify — собственные элементы ввода.
 *
 * Заменяют системные виджеты Windows: `input[type=number]` рисует пару
 * микроскопических стрелок, а `input[type=datetime-local]` открывает
 * календарь операционной системы. Оба выпадают из оформления приложения,
 * не поддаются стилизации и на тёмной теме выглядят инородно.
 *
 * Экспортирует `window.Controls` с двумя фабриками. Оба элемента работают
 * поверх скрытого нативного поля: значение остаётся в DOM, и остальной код
 * читает его как раньше.
 */
(function (global) {
  'use strict';

  var MONTHS = {
    ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
         'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
    en: ['January', 'February', 'March', 'April', 'May', 'June',
         'July', 'August', 'September', 'October', 'November', 'December']
  };

  var WEEKDAYS = {
    ru: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    en: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
  };

  /** Текущий язык интерфейса; до загрузки настроек — русский. */
  function lang() {
    return (global.I18n && global.I18n.current()) || 'ru';
  }

  /**
   * Переводит строку календаря.
   *
   * Словарь общий с остальным интерфейсом, поэтому подписи здесь меняются
   * тем же переключателем и в тот же момент, что и всё прочее.
   *
   * @param {string} key ключ словаря
   * @param {string} ru русский вариант
   * @returns {string}
   */
  function t(key, ru) {
    return global.I18n ? global.I18n.t(key, ru) : ru;
  }

  /**
   * Двузначное представление числа.
   * @param {number} value
   * @returns {string}
   */
  function pad(value) {
    return (value < 10 ? '0' : '') + value;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // ------------------------------------------------------------------ степпер

  /**
   * Превращает числовое поле в степпер с крупными кнопками.
   *
   * @param {HTMLInputElement} input исходное поле
   * @returns {HTMLElement} обёртка
   */
  function stepper(input) {
    var min = parseInt(input.min, 10);
    var max = parseInt(input.max, 10);
    var step = parseInt(input.step, 10) || 1;

    if (isNaN(min)) { min = -Infinity; }
    if (isNaN(max)) { max = Infinity; }

    var wrap = document.createElement('div');
    wrap.className = 'stepper';

    var minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'stepper__btn';
    minus.setAttribute('aria-label', t('stepper.less', 'Меньше'));
    minus.textContent = '−';

    var plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'stepper__btn';
    plus.setAttribute('aria-label', t('stepper.more', 'Больше'));
    plus.textContent = '+';

    input.parentNode.insertBefore(wrap, input);
    input.classList.add('stepper__value');
    wrap.appendChild(minus);
    wrap.appendChild(input);
    wrap.appendChild(plus);

    /**
     * Сдвигает значение и уведомляет остальной код.
     * @param {number} delta
     */
    function shift(delta) {
      var current = parseInt(input.value, 10);
      if (isNaN(current)) { current = min === -Infinity ? 0 : min; }

      input.value = clamp(current + delta, min, max);
      // Событие обязательно: снаружи на него подписан пересчёт награды.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    minus.addEventListener('click', function () { shift(-step); });
    plus.addEventListener('click', function () { shift(step); });

    // Долгое нажатие ускоряет перебор: набрать 24 часа по одному клику долго.
    [[minus, -step], [plus, step]].forEach(function (pair) {
      var button = pair[0];
      var delta = pair[1];
      var timer = null;
      var repeat = null;

      function stop() {
        window.clearTimeout(timer);
        window.clearInterval(repeat);
      }

      button.addEventListener('pointerdown', function () {
        timer = window.setTimeout(function () {
          repeat = window.setInterval(function () { shift(delta); }, 70);
        }, 420);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (name) {
        button.addEventListener(name, stop);
      });
    });

    return wrap;
  }

  // ----------------------------------------------------------------- календарь

  /**
   * Заменяет `datetime-local` собственным календарём.
   *
   * Значение хранится в исходном поле в том же формате
   * (`YYYY-MM-DDTHH:mm`), поэтому вызывающий код не меняется.
   *
   * @param {HTMLInputElement} input исходное поле
   * @returns {HTMLElement} обёртка
   */
  function dateTimePicker(input) {
    var view = new Date();
    view.setDate(1);

    var selected = null;
    var hours = 12;
    var minutes = 0;

    /** Трогал ли пользователь время: до этого оно подставляется само. */
    var timeTouched = false;

    var wrap = document.createElement('div');
    wrap.className = 'picker';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'picker__trigger';

    var label = document.createElement('span');
    label.className = 'picker__label';

    var icon = document.createElement('span');
    icon.className = 'picker__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '🗓';

    trigger.appendChild(label);
    trigger.appendChild(icon);

    var panel = document.createElement('div');
    panel.className = 'picker__panel';
    panel.hidden = true;
    // Прокрутка внутри панели нужна вместе с ограничением высоты: при
    // открытой клавиатуре видимой области не хватает на всю сетку месяца.
    panel.style.overflowY = 'auto';

    input.parentNode.insertBefore(wrap, input);
    input.type = 'hidden';
    wrap.appendChild(trigger);
    wrap.appendChild(input);

    // Подпись переводится с поля на кнопку. Поле стало скрытым, а скрытые
    // поля не относятся к тем, которые label вправе описывать: браузер
    // сообщает «Incorrect use of <label for=...>», а экранная читалка
    // остаётся без названия элемента. Кнопка описывается подписью законно,
    // и щелчок по подписи по-прежнему открывает календарь.
    if (input.id) {
      trigger.id = input.id + '-trigger';
      var bound = document.querySelector('label[for="' + input.id + '"]');
      if (bound) { bound.htmlFor = trigger.id; }
    }

    // Панель живёт в body, а не внутри обёртки: родительская карточка имеет
    // overflow: hidden, и календарь обрезался по её краю. Позиция считается
    // при каждом открытии по координатам кнопки.
    document.body.appendChild(panel);
    buildSkeleton();

    /**
     * Проверяет, указывает ли выбранное время в прошлое.
     *
     * Ограничение календаря отсекает лишь прошедшие дни. Если выбран
     * сегодняшний день, срок всё ещё можно было задать на уже прошедший
     * час — квест создавался бы заведомо просроченным.
     *
     * @returns {boolean} ``true``, если момент уже наступил.
     */
    function isPastTime() {
      if (!selected) { return false; }

      var moment = new Date(
        selected.getFullYear(), selected.getMonth(), selected.getDate(),
        hours, minutes, 0, 0
      );
      return moment <= new Date();
    }

    /**
     * Переводит время на ближайший допустимый момент.
     *
     * Вызывается, когда пользователь задал прошедший час: вместо отказа
     * срок переносится на следующий день с сохранением введённого времени.
     * Отказ вынудил бы подбирать значение вслепую.
     */
    function liftToFuture() {
      if (!selected || !isPastTime()) { return; }
      selected.setDate(selected.getDate() + 1);
    }

    /** Обновляет подпись на кнопке. */
    function renderLabel() {
      if (!selected) {
        label.textContent = t('picker.none', 'Без срока');
        label.classList.add('is-empty');
        return;
      }
      label.classList.remove('is-empty');
      label.textContent = pad(selected.getDate()) + ' ' +
        MONTHS[lang()][selected.getMonth()].slice(0, 3).toLowerCase() + ', ' +
        pad(hours) + ':' + pad(minutes);
    }

    /** Записывает значение в скрытое поле. */
    function commit() {
      if (!selected) {
        input.value = '';
      } else {
        input.value = selected.getFullYear() + '-' + pad(selected.getMonth() + 1) +
          '-' + pad(selected.getDate()) + 'T' + pad(hours) + ':' + pad(minutes);
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      renderLabel();
    }

    /**
     * Строит неизменяемый каркас панели.
     *
     * Вызывается один раз при создании элемента. Полная перестройка разметки
     * при каждом переключении месяца приводила к двум дефектам: панель
     * меняла высоту (в месяце бывает пять или шесть недельных строк) и
     * прыгала по экрану, а кнопка под курсором успевала исчезнуть между
     * нажатием и отпусканием, из-за чего быстрое листание срывалось.
     */
    function buildSkeleton() {
      // Имена полей разрядов выводятся из имени исходного поля: на странице
      // два календаря, и одинаковые имена дали бы совпадающие
      // идентификаторы. Без них браузер сообщает, что у поля формы нет ни
      // id, ни name.
      var base = input.id || 'picker';

      panel.innerHTML = '' +
        '<div class="picker__head">' +
          '<button type="button" class="picker__nav" data-move="-12" aria-label="' + t('picker.prevYear', 'Предыдущий год') + '">«</button>' +
          '<button type="button" class="picker__nav" data-move="-1" aria-label="' + t('picker.prevMonth', 'Предыдущий месяц') + '">‹</button>' +
          '<span class="picker__month"></span>' +
          '<button type="button" class="picker__nav" data-move="1" aria-label="' + t('picker.nextMonth', 'Следующий месяц') + '">›</button>' +
          '<button type="button" class="picker__nav" data-move="12" aria-label="' + t('picker.nextYear', 'Следующий год') + '">»</button>' +
        '</div>' +
        '<div class="picker__weekdays">' +
          WEEKDAYS[lang()].map(function (name) { return '<span>' + name + '</span>'; }).join('') +
        '</div>' +
        '<div class="picker__grid"></div>' +
        '<div class="picker__time">' +
          '<span class="picker__time-label">' + t('picker.time', 'Время') + '</span>' +
          '<div class="picker__clock">' +
            '<button type="button" class="picker__spin" data-time="h+">▲</button>' +
            '<input class="picker__digits" data-part="h" type="text" ' +
              'id="' + base + '-hours" name="' + base + '-hours" ' +
              'inputmode="numeric" maxlength="2" value="12" aria-label="' + t('picker.hours', 'Часы') + '">' +
            '<button type="button" class="picker__spin" data-time="h-">▼</button>' +
          '</div>' +
          '<span class="picker__colon">:</span>' +
          '<div class="picker__clock">' +
            '<button type="button" class="picker__spin" data-time="m+">▲</button>' +
            '<input class="picker__digits" data-part="m" type="text" ' +
              'id="' + base + '-minutes" name="' + base + '-minutes" ' +
              'inputmode="numeric" maxlength="2" value="00" aria-label="' + t('picker.minutes', 'Минуты') + '">' +
            '<button type="button" class="picker__spin" data-time="m-">▼</button>' +
          '</div>' +
        '</div>' +
        '<p class="picker__warning" hidden>' + t('picker.past', 'Это время уже прошло') + '</p>' +
        '<div class="picker__foot">' +
          '<button type="button" class="picker__action" data-action="clear">' + t('picker.none', 'Без срока') + '</button>' +
          '<button type="button" class="picker__action" data-action="tonight">' + t('picker.tonight', 'Сегодня 21:00') + '</button>' +
          '<button type="button" class="picker__action picker__action--primary" data-action="done">' + t('picker.done', 'Готово') + '</button>' +
        '</div>';

      // Сетка заполняется постоянным числом ячеек: шесть недель по семь
      // дней. Лишние остаются пустыми, зато высота панели не зависит от
      // месяца, и позиция на экране пересчитывается только при открытии.
      var grid = panel.querySelector('.picker__grid');
      for (var i = 0; i < 42; i += 1) {
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'picker__day picker__day--empty';
        grid.appendChild(cell);
      }
    }

    /**
     * Обновляет содержимое панели под текущий просматриваемый месяц.
     *
     * Меняются только текст ячеек и их состояния — узлы не пересоздаются,
     * поэтому обработчик нажатия не теряет свою цель при быстром листании.
     */
    function renderPanel() {
      var year = view.getFullYear();
      var month = view.getMonth();

      var first = new Date(year, month, 1);
      // В JS неделя начинается с воскресенья, в России — с понедельника.
      var offset = (first.getDay() + 6) % 7;
      var daysInMonth = new Date(year, month + 1, 0).getDate();
      var today = new Date();

      // Граница выбора: начало сегодняшнего дня. Сравнение по дате, а не по
      // моменту времени, иначе сегодняшнее число стало бы недоступно уже
      // через минуту после полуночи.
      var floor = new Date(today.getFullYear(), today.getMonth(), today.getDate());

      panel.querySelector('.picker__month').textContent =
        MONTHS[lang()][month] + ' ' + year;

      // Листать назад дальше текущего месяца незачем: прошедшие дни
      // недоступны, и пустые экраны только сбивают с толку. Шаг в год
      // блокируется по тому же правилу.
      var atFloorMonth = year === today.getFullYear() && month === today.getMonth();
      var beforeFloorYear =
        new Date(year - 1, month, 1) < new Date(today.getFullYear(), today.getMonth(), 1);
      panel.querySelector('[data-move="-1"]').disabled = atFloorMonth;
      panel.querySelector('[data-move="-12"]').disabled = beforeFloorYear;

      var cells = panel.querySelectorAll('.picker__day');
      for (var i = 0; i < cells.length; i += 1) {
        var cell = cells[i];
        var day = i - offset + 1;

        if (day < 1 || day > daysInMonth) {
          cell.className = 'picker__day picker__day--empty';
          cell.textContent = '';
          cell.disabled = true;
          cell.removeAttribute('data-day');
          cell.removeAttribute('title');
          continue;
        }

        var isToday = today.getFullYear() === year &&
          today.getMonth() === month && today.getDate() === day;
        var isSelected = selected && selected.getFullYear() === year &&
          selected.getMonth() === month && selected.getDate() === day;
        var isPast = new Date(year, month, day) < floor;

        cell.className = 'picker__day' +
          (isToday ? ' is-today' : '') +
          (isSelected ? ' is-selected' : '') +
          (isPast ? ' is-past' : '');
        cell.textContent = day;
        cell.disabled = isPast;
        cell.dataset.day = day;
        if (isPast) {
          cell.title = t('picker.pastDay', 'Срок в прошлом');
        } else {
          cell.removeAttribute('title');
        }
      }

      // Поля времени не перезаписываются, пока пользователь их правит:
      // подстановка значения сбрасывала бы позицию курсора на каждом кадре.
      var hourField = panel.querySelector('[data-part="h"]');
      var minuteField = panel.querySelector('[data-part="m"]');
      if (document.activeElement !== hourField) { hourField.value = pad(hours); }
      if (document.activeElement !== minuteField) { minuteField.value = pad(minutes); }

      // Подсветка недопустимого времени: срок в пределах сегодняшнего дня
      // не может указывать в уже прошедший час.
      var pastTime = isPastTime();
      hourField.classList.toggle('is-invalid', pastTime);
      minuteField.classList.toggle('is-invalid', pastTime);
      panel.querySelector('.picker__warning').hidden = !pastTime;
    }

    /**
     * Ставит панель под кнопкой, разворачивая её вверх или влево,
     * если снизу или справа не хватает места.
     */
    /**
     * Возвращает видимую часть экрана.
     *
     * ``window.innerHeight`` описывает окно целиком и не учитывает
     * экранную клавиатуру: при её появлении половина окна оказывается
     * перекрыта, а размеры остаются прежними. ``visualViewport`` сообщает
     * именно ту область, которую пользователь видит.
     *
     * @returns {{left: number, top: number, width: number, height: number}}
     */
    function viewport() {
      var vv = global.visualViewport;
      if (!vv) {
        return {
          left: 0, top: 0,
          width: window.innerWidth, height: window.innerHeight
        };
      }
      return {
        left: vv.offsetLeft, top: vv.offsetTop,
        width: vv.width, height: vv.height
      };
    }

    /**
     * Ставит панель под кнопкой, разворачивая её вверх или влево,
     * если снизу или справа не хватает места.
     */
    function place() {
      var vp = viewport();
      var gap = 8;
      var margin = 12;

      // Высота ограничивается видимой областью до измерения: при открытой
      // клавиатуре панель иначе уходит под неё целиком, и поля разрядов,
      // ради которых клавиатуру и открыли, оказываются вне экрана.
      panel.style.maxHeight = Math.max(180, vp.height - margin * 2) + 'px';

      var rect = trigger.getBoundingClientRect();
      var width = panel.offsetWidth || 296;
      var height = panel.offsetHeight || 380;

      var left = rect.left;
      if (left + width > vp.left + vp.width - margin) {
        left = vp.left + vp.width - width - margin;
      }
      left = Math.max(vp.left + margin, left);

      var top = rect.bottom + gap;
      if (top + height > vp.top + vp.height - margin) {
        // Снизу не помещается — раскрываем вверх от кнопки.
        var above = rect.top - gap - height;
        top = above > vp.top + margin
          ? above
          : vp.top + vp.height - height - margin;
      }
      top = Math.max(vp.top + margin, top);

      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
    }

    function open() {
      // Время по умолчанию — ближайший целый час, а не полдень. Полдень
      // после обеда указывает в прошлое, и выбор сегодняшнего числа сразу
      // давал предупреждение с переносом на завтра: пользователь получал
      // не тот день, который выбрал.
      if (!selected && !timeTouched) {
        var next = new Date();
        next.setMinutes(0, 0, 0);
        next.setHours(next.getHours() + 1);
        hours = next.getHours();
        minutes = 0;
      }

      if (selected) { view = new Date(selected.getFullYear(), selected.getMonth(), 1); }
      renderPanel();
      panel.hidden = false;
      trigger.classList.add('is-open');
      // Позиция считается после показа: у скрытого элемента размеры нулевые.
      place();
    }

    /**
     * Приводит выбранный момент в будущее перед сохранением.
     *
     * Прежде проверка стояла только на кнопке «Готово», и любой другой
     * способ закрыть панель — щелчок мимо, прокрутка страницы — сохранял
     * уже прошедшее время. Квест создавался сразу просроченным, и штраф
     * списывался за срок, которого у пользователя не было.
     */
    function settle() {
      if (!isPastTime()) { return; }
      liftToFuture();
      commit();
    }

    /**
     * Закрывает панель.
     *
     * @param {Object} [options] keepValue — не трогать значение. Нужно при
     *     подстановке извне: у правки просроченного квеста срок в прошлом
     *     законен, и переносить его молча нельзя.
     */
    function close(options) {
      if (!options || !options.keepValue) { settle(); }
      panel.hidden = true;
      trigger.classList.remove('is-open');
    }

    trigger.addEventListener('click', function () {
      if (panel.hidden) { open(); } else { close(); }
    });

    // Листание обрабатывается по нажатию, а не по щелчку. Событие click
    // формируется только если нажатие и отпускание пришлись на один и тот
    // же элемент; при быстром листании кнопка успевает стать недоступной,
    // и щелчок не возникает вовсе.
    panel.addEventListener('pointerdown', function (event) {
      var move = event.target.closest('[data-move]');
      if (!move || move.disabled) { return; }

      event.preventDefault();
      view.setMonth(view.getMonth() + parseInt(move.dataset.move, 10));
      renderPanel();
    });

    /**
     * Считывает значение из поля разряда времени.
     *
     * @param {HTMLInputElement} field поле ввода
     * @param {number} limit верхняя граница разряда (24 или 60)
     * @returns {?number} число в допустимых пределах либо ``null``
     */
    function parseField(field, limit) {
      var digits = (field.value || '').replace(/\D/g, '');
      if (!digits) { return null; }
      var value = parseInt(digits, 10);
      return isNaN(value) || value < 0 || value >= limit ? null : value;
    }

    panel.addEventListener('input', function (event) {
      var field = event.target.closest('[data-part]');
      if (!field) { return; }

      var isHours = field.dataset.part === 'h';
      var value = parseField(field, isHours ? 24 : 60);
      if (value === null) { return; }

      if (isHours) { hours = value; } else { minutes = value; }
      timeTouched = true;
      if (selected) { commit(); } else { renderLabel(); }

      // Поля не перерисовываются целиком, поэтому обновляется только
      // предупреждение о времени в прошлом.
      var pastTime = isPastTime();
      panel.querySelector('.picker__warning').hidden = !pastTime;
      panel.querySelector('[data-part="h"]').classList.toggle('is-invalid', pastTime);
      panel.querySelector('[data-part="m"]').classList.toggle('is-invalid', pastTime);
    });

    panel.addEventListener('focusout', function (event) {
      var field = event.target.closest('[data-part]');
      if (!field) { return; }

      // По уходу из поля значение приводится к двум разрядам, а недопустимый
      // ввод возвращается к последнему верному состоянию.
      var isHours = field.dataset.part === 'h';
      var value = parseField(field, isHours ? 24 : 60);
      if (value !== null) {
        if (isHours) { hours = value; } else { minutes = value; }
      }
      field.value = pad(isHours ? hours : minutes);
      renderPanel();
    });

    panel.addEventListener('click', function (event) {
      var move = event.target.closest('[data-move]');
      if (move) {
        // Переключение уже выполнено обработчиком нажатия; здесь щелчок
        // только поглощается, чтобы месяц не сместился дважды.
        return;
      }

      var day = event.target.closest('[data-day]');
      if (day) {
        selected = new Date(view.getFullYear(), view.getMonth(),
          parseInt(day.dataset.day, 10));
        commit();
        renderPanel();
        return;
      }

      var time = event.target.closest('[data-time]');
      if (time) {
        var code = time.dataset.time;
        if (code === 'h+') { hours = (hours + 1) % 24; }
        if (code === 'h-') { hours = (hours + 23) % 24; }
        if (code === 'm+') { minutes = (minutes + 5) % 60; }
        if (code === 'm-') { minutes = (minutes + 55) % 60; }
        timeTouched = true;
        if (selected) { commit(); } else { renderLabel(); }
        renderPanel();
        return;
      }

      var action = event.target.closest('[data-action]');
      if (!action) { return; }

      if (action.dataset.action === 'clear') {
        selected = null;
        commit();
        close();
      } else if (action.dataset.action === 'tonight') {
        selected = new Date();
        selected.setHours(0, 0, 0, 0);
        // После девяти вечера предложение «сегодня 21:00» указывало бы в
        // прошлое, поэтому срок переносится на завтра.
        if (new Date().getHours() >= 21) {
          selected.setDate(selected.getDate() + 1);
        }
        hours = 21;
        minutes = 0;
        commit();
        close();
      } else {
        // «Готово» с прошедшим временем переносит срок на следующий день:
        // так закрывается лазейка, позволявшая создать заведомо
        // просроченный квест выбором прошедшего часа.
        if (isPastTime()) {
          liftToFuture();
          commit();
          renderPanel();
          return;
        }
        close();
      }
    });

    // Клик мимо закрывает панель — привычное поведение выпадающих окон.
    // Проверяются оба узла: панель вынесена из обёртки в body.
    document.addEventListener('pointerdown', function (event) {
      if (panel.hidden) { return; }
      if (!wrap.contains(event.target) && !panel.contains(event.target)) { close(); }
    });

    // Панель прибита к координатам экрана, поэтому при прокрутке страницы
    // она уехала бы от своей кнопки — в этом случае её проще закрыть.
    // Прокрутка внутри самой панели исключается: иначе колесо мыши над
    // календарём закрывало бы его.
    // Изменение размеров окна раньше закрывало панель безусловно. На
    // телефоне это и есть появление экранной клавиатуры: нажатие на поле
    // разрядов открывало клавиатуру, та меняла размер окна, и панель
    // закрывалась прежде, чем удавалось набрать хоть одну цифру. Ввод
    // времени с клавиатуры был невозможен.
    //
    // Теперь окно закрывается, только если ввод не идёт внутри него;
    // при вводе панель переставляется под изменившуюся видимую область.
    function onViewportChange() {
      if (panel.hidden) { return; }
      if (panel.contains(document.activeElement)) { place(); return; }
      close();
    }

    window.addEventListener('resize', onViewportChange);
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', onViewportChange);
      global.visualViewport.addEventListener('scroll', onViewportChange);
    }

    window.addEventListener('scroll', function (event) {
      if (panel.hidden) { return; }
      if (event.target && panel.contains(event.target)) { return; }
      close();
    }, true);

    /**
     * Пересобирает панель под текущий язык.
     *
     * Каркас строится один раз и содержит переведённые подписи месяцев,
     * дней недели и кнопок, поэтому смена языка требует его пересборки.
     */
    wrap.retranslate = function () {
      close({ keepValue: true });
      buildSkeleton();
      renderLabel();
    };

    /**
     * Подставляет значение извне — используется при открытии окна правки.
     *
     * @param {?string} iso значение в формате ISO 8601 либо null
     */
    wrap.setValue = function (iso) {
      if (!iso) {
        selected = null;
        hours = 12;
        minutes = 0;
        timeTouched = false;
      } else {
        timeTouched = true;
        var date = new Date(iso);
        if (isNaN(date.getTime())) { return; }
        selected = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        hours = date.getHours();
        minutes = date.getMinutes();
      }
      commit();
      close({ keepValue: true });
    };

    /** Внешний сброс: используется после создания квеста. */
    wrap.reset = function () {
      selected = null;
      hours = 12;
      minutes = 0;
      timeTouched = false;
      commit();
      close({ keepValue: true });
    };

    renderLabel();
    return wrap;
  }

  global.Controls = {
    stepper: stepper,
    dateTimePicker: dateTimePicker
  };
}(window));
