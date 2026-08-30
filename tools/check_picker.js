/**
 * Проверка трёх исправлений календаря без браузера и телефона.
 *
 * Каждая из трёх неполадок проявлялась только на устройстве и не роняла
 * приложение: срок молча уходил в прошлое, панель молча закрывалась,
 * подписи молча теряли связь с полями. Такое не находится ни запуском,
 * ни чтением кода.
 */

'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');

let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ок    ${name}`);
  } else {
    console.log(`  СБОЙ  ${name}${detail ? ' — ' + detail : ''}`);
    failed += 1;
  }
}

/** Готовит документ с полем срока и подписью к нему. */
function setup() {
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <label class="field__label" for="task-deadline">Срок</label>
    <input class="field__input" id="task-deadline" type="datetime-local">
  </body>`, { pretendToBeVisual: true });

  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.Event = window.Event;

  // Панель позиционируется по размерам, которых у jsdom нет; для проверки
  // поведения важны не координаты, а факт вызова.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 10, top: 100, right: 300, bottom: 140, width: 290, height: 40 };
  };

  const code = fs.readFileSync('controls.js', 'utf8');
  window.eval(code);

  const input = window.document.getElementById('task-deadline');
  const wrap = window.Controls.dateTimePicker(input);
  return { window, input, wrap, panel: window.document.querySelector('.picker__panel') };
}

// --------------------------------------------------------------- подписи

console.log('Подписи и имена полей:');
{
  const { window, panel } = setup();
  const doc = window.document;

  const label = doc.querySelector('label[for]');
  const target = doc.getElementById(label.htmlFor);

  check('подпись указывает на существующий элемент', Boolean(target),
    `for="${label.htmlFor}"`);
  check('подпись указывает на кнопку, а не на скрытое поле',
    target && target.tagName === 'BUTTON', target && target.tagName);

  const digits = panel.querySelectorAll('.picker__digits');
  check('полей разрядов два', digits.length === 2, String(digits.length));

  let named = 0;
  digits.forEach(function (field) {
    if (field.id && field.name) { named += 1; }
  });
  check('у обоих полей есть id и name', named === 2, `${named} из 2`);

  const ids = new Set([...digits].map(function (f) { return f.id; }));
  check('идентификаторы различаются', ids.size === 2);
}

// ------------------------------------------------------- время в прошлом

console.log('\nВремя в прошлом:');
{
  const { window, input, panel } = setup();

  const now = new Date();
  const today = now.getDate();

  // Панель открывается первой: ячейки получают номер дня только при
  // отрисовке, до этого сетка состоит из пустых кнопок.
  window.document.querySelector('.picker__trigger')
    .dispatchEvent(new window.Event('click', { bubbles: true }));

  const cell = [...panel.querySelectorAll('[data-day]')].find(function (c) {
    return parseInt(c.dataset.day, 10) === today;
  });

  cell.dispatchEvent(new window.Event('click', { bubbles: true }));

  const hourField = panel.querySelector('[data-part="h"]');
  hourField.value = '00';
  hourField.dispatchEvent(new window.Event('input', { bubbles: true }));

  const before = input.value;
  check('прошедшее время попадает в поле до закрытия',
    before !== '' && new Date(before) <= new Date(), before);

  // Закрытие щелчком мимо панели — путь, который раньше сохранял прошлое.
  window.document.body.dispatchEvent(
    new window.Event('pointerdown', { bubbles: true }));

  const after = input.value;
  check('после закрытия щелчком мимо срок в будущем',
    new Date(after) > new Date(), after);
  check('панель закрыта', panel.hidden === true);
}

// ------------------------------------------- подстановка извне не сдвигается

console.log('\nПравка просроченного квеста:');
{
  const { window, input, wrap } = setup();

  const past = new Date();
  past.setDate(past.getDate() - 3);
  past.setHours(9, 30, 0, 0);

  const iso = past.getFullYear() + '-' +
    String(past.getMonth() + 1).padStart(2, '0') + '-' +
    String(past.getDate()).padStart(2, '0') + 'T09:30';

  wrap.setValue(iso);

  check('срок в прошлом сохраняется как есть', input.value === iso,
    `${input.value} вместо ${iso}`);
}

// ------------------------------------------------- клавиатура и размеры

console.log('\nЭкранная клавиатура:');
{
  const { window, panel } = setup();

  window.document.querySelector('.picker__trigger')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  check('панель открыта', panel.hidden === false);

  // Ввод идёт внутри панели: изменение размеров окна вызвано клавиатурой.
  const hourField = panel.querySelector('[data-part="h"]');
  hourField.focus();
  check('поле разрядов получило фокус',
    window.document.activeElement === hourField);

  window.dispatchEvent(new window.Event('resize'));
  check('панель не закрылась при появлении клавиатуры', panel.hidden === false);

  // Ввод не идёт: изменение размеров вызвано поворотом устройства.
  hourField.blur();
  window.dispatchEvent(new window.Event('resize'));
  check('панель закрылась при повороте устройства', panel.hidden === true);
}

console.log();
if (failed) {
  console.log(`Не пройдено проверок: ${failed}`);
  process.exit(1);
}
console.log('Все проверки пройдены');
