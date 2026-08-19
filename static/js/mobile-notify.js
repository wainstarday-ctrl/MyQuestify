/**
 * MyQuestify — напоминания о сроках в мобильной версии.
 *
 * В настольной версии напоминания рассылает планировщик внутри серверного
 * процесса, а показывает значок в области уведомлений. На телефоне ни того,
 * ни другого нет: приложение засыпает, как только его свернули, и никакой
 * его код в это время не выполняется.
 *
 * Поэтому подход обратный. Вместо того чтобы просыпаться и проверять сроки,
 * приложение заранее передаёт системе список моментов, в которые нужно
 * показать сообщение. Дальше их доставляет операционная система — она делает
 * это надёжнее любого фонового процесса и не расходует заряд.
 *
 * Следствие: напоминания перепланируются при каждом изменении списка
 * квестов, потому что заранее отданное системе расписание уже не зависит от
 * приложения и само не обновится.
 *
 * Модуль работает в трёх режимах и выбирает доступный:
 *   1) плагин Capacitor — в собранном приложении;
 *   2) Notification API браузера — при проверке в браузере телефона;
 *   3) без уведомлений — если ни то, ни другое не разрешено.
 *
 * Экспортирует `window.MobileNotify`.
 */
(function (global) {
  'use strict';

  /** Верхняя граница числа заранее назначенных сообщений. */
  var MAX_SCHEDULED = 32;

  /**
   * Смещение идентификаторов.
   *
   * Идентификатор складывается из этого числа и номера квеста: так
   * приложение может отменить именно свои сообщения, не задев чужие, и
   * повторная запись одного квеста заменяет прежнюю, а не добавляет вторую.
   */
  var ID_BASE = 41000;

  var mode = 'none';
  var granted = false;

  /** Плагин Capacitor, если приложение собрано с ним. */
  function plugin() {
    return global.Capacitor && global.Capacitor.Plugins &&
      global.Capacitor.Plugins.LocalNotifications;
  }

  /**
   * Запрашивает разрешение на показ сообщений.
   *
   * Разрешение спрашивается не при запуске, а при первом включении
   * напоминаний в настройках: запрос без объяснения причины пользователи
   * отклоняют, и вернуть его потом можно только через настройки системы.
   *
   * @returns {Promise<boolean>}
   */
  function request() {
    var api = plugin();

    if (api) {
      mode = 'capacitor';
      return api.requestPermissions()
        .then(function (result) {
          granted = result && result.display === 'granted';
          return granted;
        })
        .catch(function () { granted = false; return false; });
    }

    if (global.Notification) {
      mode = 'web';
      if (global.Notification.permission === 'granted') {
        granted = true;
        return Promise.resolve(true);
      }
      if (global.Notification.permission === 'denied') {
        granted = false;
        return Promise.resolve(false);
      }
      return global.Notification.requestPermission().then(function (result) {
        granted = result === 'granted';
        return granted;
      });
    }

    mode = 'none';
    return Promise.resolve(false);
  }

  /**
   * Составляет текст сообщения.
   *
   * @param {Object} task квест
   * @param {number} minutes за сколько минут предупреждаем
   * @param {string} language язык интерфейса
   * @returns {{title: string, body: string}}
   */
  function compose(task, minutes, language) {
    var hours = Math.max(1, Math.round(minutes / 60));

    if (language === 'en') {
      return {
        title: 'Deadline near: ' + task.title.slice(0, 48),
        body: 'About ' + hours + ' h left. One honest step is still enough.'
      };
    }
    return {
      title: 'Срок близко: ' + task.title.slice(0, 48),
      body: 'Осталось около ' + hours + ' ч. Одного честного шага ещё хватит.'
    };
  }

  global.MobileNotify = {
    /**
     * Включает напоминания, спросив разрешение.
     * @returns {Promise<boolean>} получено ли разрешение
     */
    enable: function () {
      return request();
    },

    /** Способ доставки, выбранный на этом устройстве. */
    mode: function () { return mode; },

    /**
     * Перепланирует напоминания по текущему списку квестов.
     *
     * Прежние сообщения снимаются целиком, затем назначаются заново. Точечное
     * обновление потребовало бы хранить, что именно уже отдано системе, и
     * рассинхронизация проявлялась бы как пропущенное или лишнее
     * напоминание — ошибка, которую пользователь заметит, а разработчик нет.
     *
     * @param {Object[]} tasks список квестов
     * @param {Object} settings настройки: включённость, запас, язык
     * @returns {Promise<number>} сколько сообщений назначено
     */
    schedule: function (tasks, settings) {
      var api = plugin();
      if (!granted || mode === 'none') { return Promise.resolve(0); }

      var lead = (settings && settings.notify_lead_minutes) || 60;
      var language = (settings && settings.language) || 'ru';
      var active = settings ? settings.notifications_enabled !== false : true;

      var pending = (tasks || [])
        .filter(function (task) {
          if (!active || task.status !== 'pending' || !task.deadline) { return false; }
          var moment = new Date(task.deadline).getTime() - lead * 60000;
          // Прошедшие моменты система отвергает, поэтому отсеиваются здесь:
          // иначе плагин вернул бы ошибку на весь пакет целиком.
          return moment > Date.now();
        })
        .sort(function (a, b) { return a.deadline < b.deadline ? -1 : 1; })
        .slice(0, MAX_SCHEDULED);

      if (!api) {
        // В браузере заранее назначить сообщение нельзя: страница должна
        // выполняться в нужный момент. Уведомления показываются только
        // пока приложение открыто.
        return Promise.resolve(pending.length);
      }

      return api.getPending()
        .then(function (result) {
          var mine = (result.notifications || []).filter(function (item) {
            return item.id >= ID_BASE && item.id < ID_BASE + 100000;
          });
          return mine.length ? api.cancel({ notifications: mine }) : null;
        })
        .then(function () {
          if (!pending.length) { return 0; }

          var list = pending.map(function (task) {
            var moment = new Date(new Date(task.deadline).getTime() - lead * 60000);
            var text = compose(task, lead, language);
            return {
              id: ID_BASE + task.id,
              title: text.title,
              body: text.body,
              schedule: { at: moment, allowWhileIdle: true },
              smallIcon: 'ic_stat_icon',
              iconColor: '#10b981'
            };
          });

          return api.schedule({ notifications: list }).then(function () {
            return list.length;
          });
        })
        .catch(function () { return 0; });
    },

    /**
     * Показывает сообщение немедленно.
     *
     * Используется для событий, происходящих при открытом приложении:
     * например, для сообщения о списании за просрочку при запуске.
     *
     * @param {string} title заголовок
     * @param {string} body текст
     */
    notifyNow: function (title, body) {
      if (!granted) { return; }

      var api = plugin();
      if (api) {
        api.schedule({
          notifications: [{
            id: ID_BASE + 99999,
            title: title,
            body: body,
            smallIcon: 'ic_stat_icon',
            iconColor: '#10b981'
          }]
        }).catch(function () { /* показ сообщения не критичен */ });
        return;
      }

      if (mode === 'web' && global.Notification) {
        try {
          new global.Notification(title, { body: body, icon: 'static/favicon.svg' });
        } catch (error) { /* браузер может запретить показ вне обработчика */ }
      }
    },

    /** Снимает все назначенные приложением сообщения. */
    clear: function () {
      var api = plugin();
      if (!api) { return Promise.resolve(); }

      return api.getPending()
        .then(function (result) {
          var mine = (result.notifications || []).filter(function (item) {
            return item.id >= ID_BASE && item.id < ID_BASE + 100000;
          });
          return mine.length ? api.cancel({ notifications: mine }) : null;
        })
        .catch(function () { /* нечего снимать */ });
    }
  };
}(window));
