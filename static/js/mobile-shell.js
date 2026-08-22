/**
 * MyQuestify — согласование с оболочкой Android.
 *
 * Настольная версия живёт в окне, у которого есть заголовок, кнопка закрытия
 * и предсказуемое поведение при сворачивании. На телефоне ничего этого нет,
 * зато есть три особенности, которые приложение обязано учитывать, иначе оно
 * ощущается чужеродным.
 *
 * **Аппаратная кнопка «назад».** По умолчанию она закрывает приложение. Если
 * пользователь открыл окно настроек и нажал «назад», ожидая закрыть окно, а
 * вместо этого вышел из приложения, — это воспринимается как поломка.
 *
 * **Строка состояния.** Её цвет задаётся приложением. Светлые значки на
 * светлом фоне становятся невидимыми, поэтому при смене темы цвет строки
 * меняется вместе с оформлением.
 *
 * **Возврат из фона.** Android выгружает приложение из памяти, но страница
 * при этом сохраняется. Сроки за время отсутствия могли пройти, а данные —
 * устареть, поэтому при возвращении состояние перечитывается.
 *
 * Модуль ничего не делает, если оболочка отсутствует: в браузере и на
 * настольной версии перечисленных понятий просто нет.
 *
 * Экспортирует `window.MobileShell`.
 */
(function (global) {
  'use strict';

  /** Цвета строки состояния под каждую тему. Совпадают с фоном шапки. */
  var STATUS_COLORS = {
    dark: '#12121a',
    light: '#eef0f6'
  };

  /**
   * Промежуток, после которого возвращение считается длительным.
   *
   * Переключение на другое приложение и обратно за несколько секунд не
   * требует перечитывания данных: за это время ничего не изменилось, а
   * лишний запрос заметен паузой в интерфейсе.
   */
  var STALE_AFTER_MS = 60000;

  var plugins = null;
  var leftAt = 0;
  var handlers = { back: null, resume: null };

  /** Возвращает набор подключённых плагинов оболочки. */
  function shell() {
    if (plugins) { return plugins; }
    if (!global.Capacitor || !global.Capacitor.Plugins) { return null; }
    plugins = global.Capacitor.Plugins;
    return plugins;
  }

  /**
   * Настраивает поведение аппаратной кнопки «назад».
   *
   * Обработчик спрашивает приложение, есть ли что закрыть. Если есть —
   * закрывает и остаётся; если нет — сворачивает приложение вместо
   * завершения. Свёртывание выбрано намеренно: напоминания о сроках
   * работают, пока приложение не закрыто окончательно.
   */
  function bindBack() {
    var api = shell();
    if (!api || !api.App) { return; }

    api.App.addListener('backButton', function () {
      var handled = false;
      if (typeof handlers.back === 'function') {
        handled = Boolean(handlers.back());
      }
      if (!handled) {
        api.App.minimizeApp();
      }
    });
  }

  /**
   * Отслеживает уход в фон и возвращение.
   *
   * Перечитывание запрашивается только после длительного отсутствия:
   * короткое переключение между приложениями не меняет данных, а лишний
   * запрос виден паузой.
   */
  function bindLifecycle() {
    var api = shell();
    if (!api || !api.App) { return; }

    api.App.addListener('appStateChange', function (state) {
      if (!state.isActive) {
        leftAt = Date.now();
        return;
      }

      var away = Date.now() - leftAt;
      if (leftAt && away > STALE_AFTER_MS && typeof handlers.resume === 'function') {
        handlers.resume(away);
      }
      leftAt = 0;
    });
  }

  global.MobileShell = {
    /**
     * Подключает обработчики оболочки.
     *
     * @param {Object} callbacks обработчики приложения
     * @param {Function} callbacks.onBack вызывается при нажатии «назад»;
     *     должен вернуть ``true``, если нажатие обработано
     * @param {Function} callbacks.onResume вызывается при возвращении после
     *     длительного отсутствия
     */
    init: function (callbacks) {
      if (!shell()) { return; }

      handlers.back = callbacks && callbacks.onBack;
      handlers.resume = callbacks && callbacks.onResume;

      bindBack();
      bindLifecycle();
    },

    /**
     * Приводит строку состояния в соответствие теме.
     *
     * @param {string} theme dark или light
     */
    applyTheme: function (theme) {
      var api = shell();
      if (!api || !api.StatusBar) { return; }

      var light = theme === 'light';
      // Стиль задаёт цвет значков: на светлом фоне нужны тёмные, и наоборот.
      api.StatusBar.setStyle({ style: light ? 'LIGHT' : 'DARK' })
        .catch(function () { /* часть устройств не позволяет менять стиль */ });
      api.StatusBar.setBackgroundColor({ color: STATUS_COLORS[theme] || STATUS_COLORS.dark })
        .catch(function () { /* на прозрачной строке цвет не задаётся */ });
    },

    /** Работает ли приложение внутри мобильной оболочки. */
    isNative: function () {
      return Boolean(shell());
    }
  };
}(window));
