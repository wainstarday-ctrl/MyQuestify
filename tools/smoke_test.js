/**
 * Проверка запуска интерфейса без браузера.
 *
 * Синтаксическая проверка (node --check) не находит ошибок, возникающих во
 * время выполнения: пропущенное объявление функции, обращение к
 * несуществующему элементу, разорванная цепочка запуска. Между тем именно
 * они приводят к самому неприятному отказу — приложение открывается,
 * показывает экран загрузки и остаётся на нём навсегда, не выводя ничего ни
 * в журнал сервера, ни на страницу.
 *
 * Скрипт поднимает минимальную замену DOM, загружает клиентские файлы в том
 * же порядке, что и страница, и проверяет три условия:
 *   1) каждый модуль объявляет свой глобальный объект;
 *   2) экран загрузки получает цитату и автора;
 *   3) цепочка запуска доходит до скрытия экрана.
 *
 * Запуск из любого каталога:
 *     node tools/smoke_test.js
 *
 * Код возврата отличен от нуля при любом невыполненном условии, поэтому
 * скрипт пригоден для сборочного конвейера.
 */

const ids = new Set();
const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'templates', 'index.html'), 'utf8');
for (const m of html.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);

function makeEl(id){
  const el = {
    id, value:'', textContent:'', innerHTML:'', hidden:false, disabled:false,
    dataset:{}, style:{}, files:[], type:'', min:'', max:'', step:'',
    classList:{ add(){}, remove(){}, toggle(){}, contains(){return false;} },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, remove(){},
    insertBefore(){}, replaceWith(){}, focus(){}, select(){}, click(){},
    setAttribute(){}, removeAttribute(){}, getAttribute(){return null;},
    querySelector(sel){
      const child = makeEl(sel);
      if (sel === '#splash-quote' || sel === '#splash-author') {
        Object.defineProperty(child, 'textContent', {
          set(v){ global.__splash = global.__splash || {}; global.__splash[sel] = v; },
          get(){ return ''; }
        });
      }
      return child;
    },
    querySelectorAll(){ return []; },
    closest(){ return null; },
    getBoundingClientRect(){ return {top:0,left:0,right:100,bottom:100,width:100,height:100}; },
    getContext(){ return new Proxy({}, {get:()=>()=>({addColorStop(){}})}); },
    contains(){ return false; }, isConnected:true, parentNode:null, offsetWidth:296, offsetHeight:380
  };
  el.parentNode = { insertBefore(){}, appendChild(){} };
  return el;
}

global.window = {
  Matter: undefined, devicePixelRatio:1, innerWidth:1200, innerHeight:800,
  addEventListener(){}, setTimeout(f,t){return 0;}, clearTimeout(){}, setInterval(){return 0;},
  clearInterval(){}, requestAnimationFrame(){return 0;}, cancelAnimationFrame(){},
  prompt(){return null;}, confirm(){return true;}, ResizeObserver: undefined
};
global.document = {
  readyState:'complete',
  getElementById(id){ return ids.has(id) ? makeEl(id) : null; },
  querySelector(sel){ return makeEl(sel); },
  createElement(){ return makeEl('new'); },
  addEventListener(){}, body:{ appendChild(){} }, documentElement:{ dataset:{} },
  activeElement:null
};
global.performance = { now(){ return 0; } };
global.fetch = () => Promise.resolve({
  ok:true, headers:{get(){return 'application/json';}}, text(){return Promise.resolve('[]');}
});
global.setTimeout = window.setTimeout; global.clearTimeout = window.clearTimeout;
global.Event = class { constructor(){} };
global.FormData = class { append(){} };

const load = f => {
  try { new Function(require('fs').readFileSync(require('path').join(__dirname, '..', 'static', 'js', f), 'utf8'))(); }
  catch(e){
    global.__loadError = true;
    console.log(`  !!! сбой при загрузке ${f}: ${e.message}`);
  }
};
const origLoad = load;
['stage.js','scenes.js','scenes2.js','scene-lab.js','thoughtweb.js','controls.js','splash.js','app.js'].forEach(f => {
  origLoad(f);
  if (f === 'splash.js' && window.Splash) {
    const realHide = window.Splash.hide;
    window.Splash.hide = function(){ global.__hidden = true; return realHide.apply(this, arguments); };
  }
});

// Промисы разрешаются в микрозадачах, поэтому проверка откладывается.
setImmediate(() => {
  const s = global.__splash || {};
  const checks = [
    ['все модули загружены', !global.__loadError],
    ['Stage объявлен', Boolean(window.Stage)],
    ['ThoughtWeb объявлен', Boolean(window.ThoughtWeb)],
    ['Controls объявлен', Boolean(window.Controls)],
    ['Splash объявлен', Boolean(window.Splash)],
    ['цитата подставлена', Boolean(s['#splash-quote'])],
    ['автор подставлен', Boolean(s['#splash-author'])],
    ['запуск дошёл до скрытия экрана', Boolean(global.__hidden)]
  ];

  let failed = 0;
  checks.forEach(([name, ok]) => {
    if (!ok) { failed += 1; }
    console.log(`  ${ok ? 'OK ' : '!!!'} ${name}`);
  });

  if (s['#splash-quote']) {
    console.log(`\n  цитата: ${s['#splash-quote'].slice(0, 54)}...`);
    console.log(`  автор:  ${s['#splash-author']}`);
  }

  console.log(failed ? `\nНЕ ПРОЙДЕНО: ${failed}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(failed ? 1 : 0);
});
