/**
 * MyQuestify — экран загрузки.
 *
 * Показывается поверх интерфейса, пока подтягиваются задачи, сцена и
 * настройки. Смысл не в том, чтобы скрыть ожидание: первый кадр после
 * запуска `.exe` — единственный момент, когда пользователь точно смотрит на
 * экран, и это лучшее место для мысли, ради которой он вообще открыл
 * трекер.
 *
 * Цитата выбирается случайно из двадцати. Повтор подряд исключён: две
 * одинаковые фразы кряду читаются как поломка, а не как совпадение.
 *
 * Экспортирует `window.Splash`.
 */
(function (global) {
  'use strict';

  /**
   * Минимальное время показа.
   *
   * Три с половиной секунды — примерно столько нужно, чтобы прочитать
   * фразу в двадцать слов и увидеть имя автора. Меньше — и цитата
   * превращается в мелькнувший декоративный шум.
   */
  var MIN_VISIBLE_MS = 3500;
  var FADE_MS = 460;

  var QUOTES = {
    ru: [
      { text: 'Мы есть то, что мы постоянно делаем. Совершенство — не действие, а привычка.', author: 'Аристотель' },
      { text: 'Не то мало, что мало, а то, чего мало тому, кому мало.', author: 'Эпикур' },
      { text: 'Дорога в тысячу ли начинается с первого шага.', author: 'Лао-цзы' },
      { text: 'Не позволяй будущему тревожить тебя. Ты встретишь его тем же разумом, каким владеешь сегодня.', author: 'Марк Аврелий' },
      { text: 'Пока мы откладываем жизнь, она проходит.', author: 'Сенека' },
      { text: 'Знание есть добродетель, а невежество — единственное зло.', author: 'Сократ' },
      { text: 'Тот, у кого есть «зачем» жить, вынесет почти любое «как».', author: 'Фридрих Ницше' },
      { text: 'Величайшая слава не в том, чтобы никогда не падать, а в том, чтобы подниматься всякий раз.', author: 'Конфуций' },
      { text: 'Человек — это то, что он должен превзойти.', author: 'Фридрих Ницше' },
      { text: 'Спокойствие приходит не от бездействия, а от верного действия.', author: 'Эпиктет' },
      { text: 'Никто не может причинить тебе вреда, кроме тебя самого.', author: 'Ганди' },
      { text: 'Река точит камень не силой, а постоянством.', author: 'Овидий' },
      { text: 'Начало — половина всего.', author: 'Пифагор' },
      { text: 'Свобода — это не отсутствие обязательств, а способность выбирать нужное.', author: 'Симона Вейль' },
      { text: 'Кто хочет — ищет способ, кто не хочет — ищет причину.', author: 'Сократ' },
      { text: 'Жизнь длинна, если уметь ею пользоваться.', author: 'Сенека' },
      { text: 'Ум, однажды расширенный новой идеей, никогда не вернётся к прежним размерам.', author: 'Оливер Холмс' },
      { text: 'Счастье зависит от нас самих в большей мере, чем от чего-либо иного.', author: 'Аристотель' },
      { text: 'Побеждающий других — силён. Побеждающий себя — могуществен.', author: 'Лао-цзы' },
      { text: 'Терпение горько, но плод его сладок.', author: 'Жан-Жак Руссо' }
    ],
    en: [
      { text: 'We are what we repeatedly do. Excellence, then, is not an act but a habit.', author: 'Aristotle' },
      { text: 'Nothing is enough for the man to whom enough is too little.', author: 'Epicurus' },
      { text: 'A journey of a thousand miles begins with a single step.', author: 'Laozi' },
      { text: 'Do not let the future disturb you. You will meet it with the same reason you have today.', author: 'Marcus Aurelius' },
      { text: 'While we postpone, life speeds by.', author: 'Seneca' },
      { text: 'Knowledge is virtue, and ignorance the only evil.', author: 'Socrates' },
      { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche' },
      { text: 'Our greatest glory is not in never falling, but in rising every time we fall.', author: 'Confucius' },
      { text: 'Man is something that shall be overcome.', author: 'Friedrich Nietzsche' },
      { text: 'Peace comes not from inaction, but from right action.', author: 'Epictetus' },
      { text: 'No one can harm you but yourself.', author: 'Gandhi' },
      { text: 'Dripping water hollows out stone, not by force but by persistence.', author: 'Ovid' },
      { text: 'The beginning is half of the whole.', author: 'Pythagoras' },
      { text: 'Freedom is not the absence of obligation, but the ability to choose the right one.', author: 'Simone Weil' },
      { text: 'He who wants to do something finds a way; he who does not finds an excuse.', author: 'Socrates' },
      { text: 'Life is long, if you know how to use it.', author: 'Seneca' },
      { text: 'A mind once stretched by a new idea never returns to its original dimensions.', author: 'Oliver Holmes' },
      { text: 'Happiness depends upon ourselves more than upon anything else.', author: 'Aristotle' },
      { text: 'He who conquers others is strong. He who conquers himself is mighty.', author: 'Laozi' },
      { text: 'Patience is bitter, but its fruit is sweet.', author: 'Jean-Jacques Rousseau' }
    ]
  };

  var lastIndex = -1;

  /**
   * Выбирает цитату, не повторяя предыдущую.
   * @returns {Object}
   */
  function pickQuote() {
    // Язык берётся из уже применённых настроек, если они успели прийти;
    // иначе используется русский — экран показывается до первого запроса.
    var language = (global.I18n && global.I18n.current()) || 'ru';
    var list = QUOTES[language] || QUOTES.ru;

    if (list.length < 2) { return list[0]; }

    var index = lastIndex;
    while (index === lastIndex) {
      index = Math.floor(Math.random() * list.length);
    }
    lastIndex = index;
    return list[index];
  }

  var shownAt = 0;
  var node = null;

  global.Splash = {
    /**
     * Показывает экран загрузки.
     * @returns {Object} самого себя, для цепочки вызовов
     */
    show: function () {
      node = document.getElementById('splash');
      if (!node) { return global.Splash; }

      var quote = pickQuote();
      var textNode = node.querySelector('#splash-quote');
      var authorNode = node.querySelector('#splash-author');
      if (textNode) { textNode.textContent = '«' + quote.text + '»'; }
      if (authorNode) { authorNode.textContent = quote.author; }

      node.hidden = false;
      shownAt = performance.now();

      // Заставка оболочки убирается только теперь, когда своя уже на
      // экране: скрытие по готовности приложения давало бы белую вспышку
      // между двумя заставками.
      if (global.Capacitor && global.Capacitor.Plugins &&
          global.Capacitor.Plugins.SplashScreen) {
        global.Capacitor.Plugins.SplashScreen.hide()
          .catch(function () { /* заставка могла быть скрыта раньше */ });
      }

      return global.Splash;
    },

    /**
     * Прячет экран, выдержав минимальную длительность.
     *
     * Без выдержки на быстрой машине экран мигает на сто миллисекунд —
     * пользователь успевает заметить движение, но не прочитать мысль.
     */
    hide: function () {
      if (!node) { return; }

      var elapsed = performance.now() - shownAt;
      var wait = Math.max(0, MIN_VISIBLE_MS - elapsed);

      global.setTimeout(function () {
        node.classList.add('is-leaving');
        global.setTimeout(function () {
          node.hidden = true;
          node.classList.remove('is-leaving');
        }, FADE_MS);
      }, wait);
    },

    /** Полные списки — используются, если понадобится показать цитату дня. */
    quotes: QUOTES
  };
}(window));
