/**
 * Сборка мобильной версии из общих исходников.
 *
 * Интерфейс не дублируется: файлы копируются из корня проекта, а различия
 * между настольной и мобильной версией сводятся к трём правкам страницы.
 * Копия вместо ручного дублирования выбрана намеренно — любая правка
 * интерфейса иначе требовала бы повторения в двух местах, и версии
 * разошлись бы на первой же неделе.
 *
 * Запуск из каталога mobile:
 *     node build.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'www');

/**
 * Собирать ли выпуск с языковой моделью.
 *
 * Признаком служит переменная окружения, а не отдельный скрипт: обе
 * разновидности собираются из одних исходников, и различие сводится к
 * двум подключаемым файлам и наличию весов.
 */
const WITH_MODEL = process.env.MYQUESTIFY_WITH_MODEL === '1';

/**
 * Откуда взять веса для сборки с моделью.
 *
 * Путь передаётся извне, а сборщик копирует файл сам. Прежде веса
 * требовалось положить в www заранее, но сборка очищает этот каталог
 * целиком — приходилось уносить их во временное место и возвращать после,
 * а проверка внутри сборки срабатывала в промежутке и обрывала её.
 */
const MODEL_SOURCE = process.env.MYQUESTIFY_MODEL_PATH ||
  path.join(ROOT, 'models', 'model-mobile.gguf');

/** Каталоги и файлы, переносимые без изменений. */
const ASSETS = [
  ['static/css', 'static/css'],
  ['static/js', 'static/js'],
  ['static/favicon.svg', 'static/favicon.svg']
];

/**
 * Рекурсивно копирует каталог или файл.
 *
 * @param {string} from источник
 * @param {string} to назначение
 */
function copy(from, to) {
  const stat = fs.statSync(from);

  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      copy(path.join(from, name), path.join(to, name));
    }
    return;
  }

  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/**
 * Готовит страницу для мобильной версии.
 *
 * Три отличия от настольной:
 *   1) подключается локальная реализация серверной части;
 *   2) добавляется мета-тег области просмотра с запретом масштабирования —
 *      двойное касание по сцене иначе увеличивало бы страницу вместо
 *      действия в сцене;
 *   3) снимается ограничение источников, требующее сервера: в мобильной
 *      сборке страница открывается по адресу приложения, а не по http.
 *
 * @param {string} html исходная разметка
 * @returns {string} разметка для мобильной сборки
 */
function prepareHtml(html) {
  let out = html;

  // Локальная реализация подключается перед прикладной логикой: к моменту
  // её запуска модуль должен быть определён.
  // Защитный слой подключается всегда, даже в сборке без модели: он
  // проверяет и реплики пользователя, а не только ответы модели.
  //
  // Модуль выполнения модели добавляется лишь в выпуске с ней: в обычном
  // он обратился бы к отсутствующим файлам и без нужды писал бы в консоль.
  var scripts = '  <script src="/static/js/oracle-safety.js"></script>\n';
  if (WITH_MODEL) {
    scripts += '  <script src="/static/js/local-llm.js"></script>\n';
  }
  scripts += '  <script src="/static/js/local-api.js"></script>\n';
  scripts += '  <script src="/static/js/app.js"></script>';

  out = out.replace('  <script src="/static/js/app.js"></script>', scripts);

  // Мост Capacitor подключается первым: модуль уведомлений проверяет его
  // наличие при загрузке, чтобы выбрать способ доставки сообщений.
  //
  // Файл создаётся оболочкой при сборке и в каталоге www отсутствует,
  // поэтому при проверке через обычный веб-сервер запрос к нему завершается
  // ошибкой. Обработчик onerror гасит сообщение в консоли: отсутствие
  // моста — обычное состояние при проверке в браузере, а не неполадка,
  // и лишняя красная строка отвлекает от настоящих ошибок.
  out = out.replace(
    '  <script src="/static/js/vendor/matter.min.js"></script>',
    '  <script src="capacitor.js" onerror="this.dataset.missing=1"></script>\n' +
    '  <script src="/static/js/vendor/matter.min.js"></script>'
  );

  // Пути делаются относительными: в приложении страница открывается не с
  // корня веб-сервера, и ведущая косая черта увела бы в никуда.
  out = out.replace(/(src|href)="\/static\//g, '$1="static/');

  out = out.replace(
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, ' +
    'maximum-scale=1.0, user-scalable=no, viewport-fit=cover">'
  );

  // Политика источников в мобильной сборке задаётся оболочкой, а не
  // страницей: адрес приложения не совпадает с тем, что означает 'self'
  // в веб-контексте.
  out = out.replace(
    /  <meta http-equiv="Content-Security-Policy"[\s\S]*?>\n/,
    ''
  );

  return out;
}

function main() {
  if (fs.existsSync(OUT)) {
    fs.rmSync(OUT, { recursive: true });
  }
  fs.mkdirSync(OUT, { recursive: true });

  for (const [from, to] of ASSETS) {
    const source = path.join(ROOT, from);
    if (!fs.existsSync(source)) {
      console.warn(`  пропущено (нет файла): ${from}`);
      continue;
    }
    copy(source, path.join(OUT, to));
  }

  const html = fs.readFileSync(path.join(ROOT, 'templates', 'index.html'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'index.html'), prepareHtml(html), 'utf8');

  // Заглушка моста оболочки. Настоящий файл подкладывает Capacitor при
  // сборке, перезаписывая эту версию. Заглушка нужна для проверки в
  // браузере: без неё запрос завершается ошибкой, и в консоли появляется
  // красная строка, за которой теряются настоящие неполадки.
  fs.writeFileSync(path.join(OUT, 'capacitor.js'),
    '/**\n' +
    ' * Заглушка моста оболочки для проверки в браузере.\n' +
    ' *\n' +
    ' * При сборке приложения этот файл заменяется настоящим. Здесь он\n' +
    ' * лишь сообщает модулям, что оболочки нет, и они выбирают запасной\n' +
    ' * способ работы: уведомления показываются средствами браузера,\n' +
    ' * кнопка «назад» и строка состояния не обрабатываются.\n' +
    ' */\n' +
    "console.info('MyQuestify: оболочка не обнаружена, работа в браузере.');\n",
    'utf8');

  // Проверка обязательного вендорного файла: без него сцены не работают,
  // а обнаружилось бы это только на устройстве.
  const matter = path.join(OUT, 'static', 'js', 'vendor', 'matter.min.js');
  if (!fs.existsSync(matter) || fs.statSync(matter).size === 0) {
    console.error('\n  ОШИБКА: static/js/vendor/matter.min.js отсутствует или пуст.');
    console.error('  Без него интерактивные сцены не запустятся.');
    process.exit(1);
  }

  if (WITH_MODEL) {
    if (!fs.existsSync(MODEL_SOURCE)) {
      console.error('\n  ОШИБКА: сборка с моделью запрошена, но весов нет.');
      console.error(`  Ожидается: ${MODEL_SOURCE}`);
      console.error('  Путь задаётся переменной MYQUESTIFY_MODEL_PATH.');
      process.exit(1);
    }

    const target = path.join(OUT, 'static', 'models', 'model.gguf');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(MODEL_SOURCE, target);

    const mb = (fs.statSync(target).size / (1024 * 1024)).toFixed(0);
    console.log(`  веса модели: ${mb} МБ`);
  }

  const files = countFiles(OUT);
  console.log(`  собрано файлов: ${files.count}`);
  console.log(`  общий размер: ${(files.size / 1024).toFixed(0)} КБ`);
  console.log('\n  готово: mobile/www');
}

/**
 * Считает файлы и общий размер каталога.
 * @param {string} dir
 * @returns {{count: number, size: number}}
 */
function countFiles(dir) {
  let count = 0;
  let size = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      const inner = countFiles(full);
      count += inner.count;
      size += inner.size;
    } else {
      count += 1;
      size += stat.size;
    }
  }
  return { count, size };
}

main();
