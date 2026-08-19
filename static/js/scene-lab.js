/**
 * MyQuestify — Лаборатория Идей.
 *
 * Колбы с реактивами. Колбу берут мышью и наклоняют клавишами; за порогом
 * наклона жидкость льётся каплями. Капля, попавшая в другую колбу, вступает
 * в реакцию: смесь меняет цвет и даёт видимый эффект — пену, дым, вспышку
 * или кристаллы.
 *
 * Жидкость — не набор тел, а объём с уровнем, цветом и типом реагента.
 * Через частицы Matter пришлось бы держать сотни кругов ради эффекта,
 * который честно рисуется одним многоугольником с волнистой кромкой.
 *
 * Отрисовка построена на явных сплошных цветах без наложений: прежняя
 * версия смешивала полупрозрачные слои поверх стекла, и все растворы
 * сходились к одному мутному оттенку.
 */
(function (global) {
  'use strict';

  if (!global.Stage) { return; }

  var TAU = Math.PI * 2;

  global.Stage.register('lab', function (env) {
    var draw = env.draw;
    var u = env.util;

    /** Угол, после которого жидкость переливается через край. */
    var POUR_ANGLE = 0.55;
    var ROTATE_STEP = 0.05;
    var MAX_TILT = 2.2;
    var MAX_DROPS = 200;

    /**
     * Реактивы. `kind` — ключ реакции, `rgb` — цвет в чистом виде.
     */
    var REAGENTS = {
      azure:   { rgb: [70, 190, 255], name: 'лазурь' },
      crimson: { rgb: [255, 80, 130], name: 'багрец' },
      verdant: { rgb: [120, 240, 130], name: 'зелень' },
      amber:   { rgb: [255, 185, 50], name: 'янтарь' },
      violet:  { rgb: [175, 120, 255], name: 'фиалка' },
      ash:     { rgb: [150, 160, 175], name: 'пепел' },
      pearl:   { rgb: [235, 240, 250], name: 'жемчуг' }
    };

    /**
     * Таблица реакций: пара реагентов → результат и эффект.
     *
     * Ключ строится из отсортированной пары, поэтому порядок смешивания не
     * важен: лить лазурь в янтарь и наоборот должно давать одно и то же,
     * иначе пользователь решит, что результат случаен.
     */
    var REACTIONS = {
      'amber|azure':     { kind: 'verdant', effect: 'foam',    label: 'Пена!' },
      'crimson|verdant': { kind: 'ash',     effect: 'smoke',   label: 'Дым!' },
      'amber|violet':    { kind: 'crimson', effect: 'flash',   label: 'Вспышка!' },
      'azure|verdant':   { kind: 'pearl',   effect: 'crystal', label: 'Кристаллы!' },
      'crimson|violet':  { kind: 'violet',  effect: 'bubble',  label: 'Кипение!' },
      'amber|crimson':   { kind: 'amber',   effect: 'flash',   label: 'Вспышка!' },
      'azure|violet':    { kind: 'azure',   effect: 'bubble',  label: 'Кипение!' },
      'ash|verdant':     { kind: 'verdant', effect: 'smoke',   label: 'Дым!' }
    };

    var ORDER = ['azure', 'crimson', 'verdant', 'amber', 'violet'];

    var flasks = [];
    var drops = [];
    var effects = [];
    var shelfBottles = [];
    var labels = [];
    var dragged = null;
    var grabOffset = { x: 0, y: 0 };
    var benchY = 0;
    var level = env.level;
    var keys = { ccw: 'KeyQ', cw: 'KeyE' };
    var held = { ccw: false, cw: false };
    var glow = 0;
    var shake = 0;

    /**
     * Находит реакцию для пары реагентов.
     * @param {string} a
     * @param {string} b
     * @returns {?Object}
     */
    function reactionFor(a, b) {
      if (a === b) { return null; }
      return REACTIONS[[a, b].sort().join('|')] || null;
    }

    function makeFlask(shape, x, scale, kind, fill) {
      var sizes = {
        conical: { w: 66, h: 88, neck: 22 },
        round:   { w: 72, h: 82, neck: 20 },
        tube:    { w: 34, h: 100, neck: 28 },
        beaker:  { w: 62, h: 74, neck: 54 }
      };
      var size = sizes[shape] || sizes.conical;

      return {
        shape: shape,
        x: x, y: 0,
        w: size.w * scale,
        h: size.h * scale,
        neck: size.neck * scale,
        angle: 0,
        fill: fill,
        kind: kind,
        rgb: REAGENTS[kind].rgb.slice(),
        wobble: 0,
        wobbleSpeed: 0,
        foam: 0,
        boil: 0,
        home: { x: x, y: 0 }
      };
    }

    function build(width, height) {
      benchY = height * 0.76;
      var scale = u.clamp(Math.min(width, height) / 460, 0.6, 1.45);
      var count = u.clamp(4 + Math.round(u.clamp(level, 1, 10) / 3), 4, 6);
      var shapes = ['conical', 'round', 'tube', 'beaker', 'conical', 'round'];

      flasks = [];
      for (var i = 0; i < count; i += 1) {
        var x = width * (0.15 + (0.7 * i) / Math.max(1, count - 1));
        var flask = makeFlask(
          shapes[i % shapes.length], x, scale,
          ORDER[i % ORDER.length],
          i % 2 === 0 ? 0.62 : 0.4
        );
        flask.y = benchY - flask.h / 2;
        flask.home = { x: flask.x, y: flask.y };
        flasks.push(flask);
      }

      drops = [];
      effects = [];
      labels = [];

      shelfBottles = [];
      for (var s = 0; s < Math.round(width / 70); s += 1) {
        var kind = ORDER[Math.floor(u.rand(0, ORDER.length))];
        shelfBottles.push({
          x: u.rand(width * 0.06, width * 0.94),
          w: u.rand(16, 26) * scale,
          h: u.rand(30, 54) * scale,
          rgb: REAGENTS[kind].rgb,
          fill: u.rand(0.35, 0.85)
        });
      }
    }

    /** Точка носика колбы с учётом наклона. */
    function spout(flask) {
      var direction = flask.angle > 0 ? 1 : -1;
      var localX = (direction * flask.neck) / 2;
      var localY = -flask.h / 2;
      return {
        x: flask.x + localX * Math.cos(flask.angle) - localY * Math.sin(flask.angle),
        y: flask.y + localX * Math.sin(flask.angle) + localY * Math.cos(flask.angle),
        direction: direction
      };
    }

    function mouthRect(flask) {
      return {
        left: flask.x - flask.neck * 0.75,
        right: flask.x + flask.neck * 0.75,
        top: flask.y - flask.h / 2 - 6,
        bottom: flask.y - flask.h / 2 + flask.h * 0.3
      };
    }

    /**
     * Порождает видимый эффект реакции.
     * @param {string} type foam | smoke | flash | crystal | bubble
     * @param {Object} flask колба-приёмник
     * @param {string} label подпись
     */
    function spawnEffect(type, flask, label) {
      var top = flask.y - flask.h / 2;

      // Ударная волна сопровождает любую реакцию: расходящееся кольцо —
      // самый заметный способ показать, что произошло событие, при том что
      // рисуется одной дугой.
      effects.push({
        type: 'wave',
        x: flask.x,
        y: flask.y,
        r: flask.w * 0.4,
        life: 1,
        decay: 0.0022,
        rgb: flask.rgb.slice()
      });

      // Сосуд вздрагивает, сцена — слегка: реакция ощущается телесно.
      flask.jolt = 1;
      shake = Math.min(1, shake + 0.5);

      if (type === 'flash') {
        glow = 1;
        shake = 1;
        // Сноп искр разлетается из горла. Скорость задаётся по кругу с
        // перекосом вверх — брызги летят преимущественно наружу.
        for (var f = 0; f < 26; f += 1) {
          var angle = u.rand(-Math.PI * 0.95, -Math.PI * 0.05);
          var speed = u.rand(1.6, 5.2);
          effects.push({
            type: 'spark',
            x: flask.x + u.rand(-6, 6),
            y: top,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            r: u.rand(1.4, 3.4),
            life: 1,
            decay: u.rand(0.0018, 0.004),
            rgb: u.mix(flask.rgb, [255, 245, 200], 0.55)
          });
        }
      }

      if (type === 'foam') {
        flask.foam = 1;
        // Пена переливается через край: несколько капель сползают по стеклу.
        for (var d = 0; d < 10; d += 1) {
          effects.push({
            type: 'spark',
            x: flask.x + u.rand(-flask.w * 0.4, flask.w * 0.4),
            y: top + u.rand(0, 10),
            vx: u.rand(-0.7, 0.7),
            vy: u.rand(-1.4, -0.2),
            r: u.rand(2, 4),
            life: 1,
            decay: 0.0016,
            rgb: [245, 250, 252]
          });
        }
      }

      if (type === 'bubble') { flask.boil = 1; }

      if (type === 'smoke') {
        for (var s = 0; s < 26; s += 1) {
          effects.push({
            type: 'smoke',
            x: flask.x + u.rand(-flask.neck * 0.6, flask.neck * 0.6),
            y: top + u.rand(-8, 8),
            r: u.rand(8, 20),
            vx: u.rand(-0.35, 0.35),
            vy: -u.rand(0.3, 0.95),
            life: 1,
            decay: u.rand(0.0009, 0.0021),
            rgb: u.mix(flask.rgb, [190, 200, 210], 0.7)
          });
        }
      }

      if (type === 'crystal') {
        for (var c = 0; c < 9; c += 1) {
          effects.push({
            type: 'crystal',
            x: flask.x + u.rand(-flask.w * 0.35, flask.w * 0.35),
            y: top + u.rand(4, flask.h * 0.5),
            r: u.rand(3, 7),
            angle: u.rand(0, TAU),
            // grow — доля от полного размера: кристалл прорастает за
            // полсекунды, а не возникает готовым.
            grow: 0,
            life: 1,
            decay: 0.0011
          });
        }
      }

      if (label) {
        labels.push({ text: label, x: flask.x, y: top - 16, life: 1, pop: 0 });
      }
    }

    /**
     * Принимает каплю: считает реакцию, смешивает цвет и уровень.
     *
     * Цвет взвешен по объёму — капля в почти полную колбу едва меняет
     * оттенок, в пустую задаёт его целиком. Простое усреднение давало бы
     * скачок цвета от одной капли и читалось бы как сбой.
     */
    function receive(flask, drop) {
      var reaction = reactionFor(flask.kind, drop.kind);
      var amount = drop.amount;
      var total = flask.fill + amount;

      if (reaction) {
        flask.kind = reaction.kind;
        // Продукт реакции имеет собственный цвет, а не смесь исходных:
        // иначе «дым» и «пена» выглядели бы одинаково грязным оттенком.
        flask.rgb = REAGENTS[reaction.kind].rgb.slice();
        spawnEffect(reaction.effect, flask, reaction.label);
      } else if (total > 0) {
        flask.rgb = u.mix(flask.rgb, drop.rgb, amount / total);
      }

      flask.fill = u.clamp(total, 0, 1);
      flask.wobbleSpeed += 0.4;
    }

    /** Рождает каплю у носика. */
    function pour(flask, dt) {
      if (flask.fill <= 0) { return; }

      var point = spout(flask);
      var rate = Math.min(1, (Math.abs(flask.angle) - POUR_ANGLE) / 0.6);
      var amount = Math.min(0.0005 * rate * dt, flask.fill);

      flask.fill -= amount;

      if (drops.length < MAX_DROPS) {
        drops.push({
          x: point.x,
          y: point.y,
          vx: point.direction * u.rand(0.5, 1.5) * rate,
          vy: u.rand(0.3, 1),
          r: u.rand(2.4, 4.4),
          rgb: flask.rgb.slice(),
          kind: flask.kind,
          amount: amount * 3,
          life: 1
        });
      }
    }

    /**
     * Строит контур сосуда в его локальных координатах.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} flask
     */
    function flaskPath(ctx, flask) {
      var halfW = flask.w / 2;
      var halfH = flask.h / 2;
      var neck = flask.neck / 2;

      ctx.beginPath();
      if (flask.shape === 'conical') {
        ctx.moveTo(-neck, -halfH);
        ctx.lineTo(-neck, -halfH + flask.h * 0.24);
        ctx.lineTo(-halfW, halfH - 6);
        ctx.quadraticCurveTo(-halfW, halfH, -halfW + 6, halfH);
        ctx.lineTo(halfW - 6, halfH);
        ctx.quadraticCurveTo(halfW, halfH, halfW, halfH - 6);
        ctx.lineTo(neck, -halfH + flask.h * 0.24);
        ctx.lineTo(neck, -halfH);
        ctx.closePath();
      } else if (flask.shape === 'round') {
        var bulbR = halfW;
        var bulbY = halfH - bulbR;
        ctx.moveTo(-neck, -halfH);
        ctx.lineTo(-neck, bulbY - bulbR * 0.55);
        ctx.arc(0, bulbY, bulbR, Math.PI * 1.24, Math.PI * 1.76, true);
        ctx.lineTo(neck, -halfH);
        ctx.closePath();
      } else if (flask.shape === 'tube') {
        ctx.moveTo(-halfW, -halfH);
        ctx.lineTo(-halfW, halfH - halfW);
        ctx.arc(0, halfH - halfW, halfW, Math.PI, 0, true);
        ctx.lineTo(halfW, -halfH);
        ctx.closePath();
      } else {
        ctx.moveTo(-halfW, -halfH);
        ctx.lineTo(-halfW, halfH - 6);
        ctx.quadraticCurveTo(-halfW, halfH, -halfW + 6, halfH);
        ctx.lineTo(halfW - 6, halfH);
        ctx.quadraticCurveTo(halfW, halfH, halfW, halfH - 6);
        ctx.lineTo(halfW, -halfH);
        ctx.closePath();
      }
    }

    /**
     * Рисует жидкость внутри сосуда.
     *
     * Ключевой момент: поверхность остаётся горизонтальной в мире, поэтому
     * внутри повёрнутой колбы её приходится повернуть обратно. Без этого
     * раствор кренился бы вместе со стеклом, чего в природе не бывает.
     */
    function drawLiquid(ctx, flask, now) {
      if (flask.fill <= 0.005) { return; }

      var halfH = flask.h / 2;
      var span = flask.w + flask.h;
      var surface = halfH - flask.h * flask.fill + flask.wobble * 3;

      ctx.save();
      flaskPath(ctx, flask);
      ctx.clip();
      ctx.rotate(-flask.angle);

      var top = u.mix(flask.rgb, [255, 255, 255], 0.22);
      var bottom = u.mix(flask.rgb, [15, 20, 30], 0.42);

      var gradient = ctx.createLinearGradient(0, surface, 0, surface + flask.h);
      gradient.addColorStop(0, u.rgba(top, 1));
      gradient.addColorStop(0.45, u.rgba(flask.rgb, 1));
      gradient.addColorStop(1, u.rgba(bottom, 1));

      // Волнистая кромка вместо прямой линии: ровный срез выглядит заливкой,
      // а не жидкостью.
      ctx.beginPath();
      ctx.moveTo(-span, surface + 40);
      for (var x = -span; x <= span; x += 6) {
        var wave = Math.sin(x * 0.07 + now * 0.003 + flask.x) * (1.2 + flask.boil * 2.5);
        ctx.lineTo(x, surface + wave);
      }
      ctx.lineTo(span, surface + span);
      ctx.lineTo(-span, surface + span);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // Светлая линия по кромке — блик поверхности.
      ctx.beginPath();
      for (var lx = -span; lx <= span; lx += 6) {
        var lw = Math.sin(lx * 0.07 + now * 0.003 + flask.x) * (1.2 + flask.boil * 2.5);
        ctx.lineTo(lx, surface + lw);
      }
      ctx.strokeStyle = u.rgba(u.mix(flask.rgb, [255, 255, 255], 0.75), 0.85);
      ctx.lineWidth = 2;
      ctx.stroke();

      // Пузырьки кипения.
      if (flask.boil > 0.02) {
        for (var b = 0; b < 12; b += 1) {
          var phase = (now * 0.0012 + b * 0.37) % 1;
          var by = surface + flask.h * (1 - phase) * flask.fill;
          ctx.beginPath();
          ctx.arc(
            Math.sin(b * 2.3 + flask.x) * flask.w * 0.3, by,
            1.5 + phase * 2, 0, TAU
          );
          ctx.fillStyle = 'rgba(255,255,255,' + (0.5 * flask.boil * (1 - phase)).toFixed(3) + ')';
          ctx.fill();
        }
      }

      // Пена поверх жидкости.
      if (flask.foam > 0.02) {
        for (var f = 0; f < 22; f += 1) {
          var fx = -flask.w * 0.45 + (flask.w * 0.9 * f) / 22;
          var fy = surface - Math.abs(Math.sin(f * 1.7 + now * 0.001)) * 8 * flask.foam;
          ctx.beginPath();
          ctx.arc(fx, fy, (2.5 + (f % 3)) * flask.foam, 0, TAU);
          ctx.fillStyle = 'rgba(255,255,255,' + (0.5 * flask.foam).toFixed(3) + ')';
          ctx.fill();
        }
      }

      ctx.restore();
    }

    return {
      usesPhysics: false,
      hint: 'Возьми колбу мышью и наклоняй клавишами. Перелей в соседнюю — реагенты вступят в реакцию.',

      build: build,
      resize: function (w, h) { build(w, h); },
      setLevel: function (next) { level = next; build(env.width, env.height); },

      configure: function (config) {
        if (config && config.rotate_ccw_key) { keys.ccw = config.rotate_ccw_key; }
        if (config && config.rotate_cw_key) { keys.cw = config.rotate_cw_key; }
      },

      keyDown: function (code) {
        if (code === keys.ccw) { held.ccw = true; return true; }
        if (code === keys.cw) { held.cw = true; return true; }
        return false;
      },

      keyUp: function (code) {
        if (code === keys.ccw) { held.ccw = false; }
        if (code === keys.cw) { held.cw = false; }
      },

      update: function (dt) {
        var frames = u.clamp(dt / 16.7, 0.5, 2);
        glow = Math.max(0, glow - dt / 700);
        shake = Math.max(0, shake - dt / 380);

        if (dragged) {
          if (held.ccw) {
            dragged.angle = u.clamp(dragged.angle - ROTATE_STEP * frames, -MAX_TILT, MAX_TILT);
          }
          if (held.cw) {
            dragged.angle = u.clamp(dragged.angle + ROTATE_STEP * frames, -MAX_TILT, MAX_TILT);
          }
        }

        flasks.forEach(function (flask) {
          if (flask !== dragged) {
            flask.angle += (0 - flask.angle) * 0.09 * frames;
            flask.x += (flask.home.x - flask.x) * 0.07 * frames;
            flask.y += (flask.home.y - flask.y) * 0.07 * frames;
          }

          if (Math.abs(flask.angle) > POUR_ANGLE && flask.fill > 0.002) {
            pour(flask, dt);
          }

          flask.wobbleSpeed += -flask.wobble * 0.025 * frames;
          flask.wobbleSpeed *= Math.pow(0.93, frames);
          flask.wobble += flask.wobbleSpeed * frames;

          flask.foam = Math.max(0, flask.foam - dt / 5200);
          flask.boil = Math.max(0, flask.boil - dt / 6400);
          flask.jolt = Math.max(0, (flask.jolt || 0) - dt / 420);
        });

        for (var i = drops.length - 1; i >= 0; i -= 1) {
          var drop = drops[i];
          drop.vy += 0.06 * frames;
          drop.x += drop.vx * frames;
          drop.y += drop.vy * frames;

          var caught = false;
          for (var f = 0; f < flasks.length; f += 1) {
            var target = flasks[f];
            if (Math.abs(target.angle) > POUR_ANGLE) { continue; }

            var mouth = mouthRect(target);
            if (drop.x > mouth.left && drop.x < mouth.right &&
                drop.y > mouth.top && drop.y < mouth.bottom) {
              receive(target, drop);
              drops.splice(i, 1);
              caught = true;
              break;
            }
          }
          if (caught) { continue; }

          if (drop.y > benchY) {
            drop.life -= dt / 500;
            drop.vy = 0;
            drop.vx *= 0.85;
            if (drop.life <= 0) { drops.splice(i, 1); }
          } else if (drop.y > env.height + 40) {
            drops.splice(i, 1);
          }
        }

        for (var e = effects.length - 1; e >= 0; e -= 1) {
          var effect = effects[e];

          if (effect.type === 'smoke') {
            effect.x += effect.vx * frames;
            effect.y += effect.vy * frames;
            effect.r += 0.2 * frames;
          } else if (effect.type === 'crystal') {
            effect.angle += 0.0006 * dt;
            effect.grow = Math.min(1, effect.grow + dt / 500);
          } else if (effect.type === 'wave') {
            // Кольцо расширяется с замедлением: равномерный рост читается
            // как техническая анимация, затухающий — как отдача от события.
            effect.r += (2.6 * frames) * effect.life;
          } else if (effect.type === 'spark') {
            effect.vy += 0.09 * frames;
            effect.x += effect.vx * frames;
            effect.y += effect.vy * frames;
            effect.vx *= Math.pow(0.985, frames);
          }

          effect.life -= effect.decay * dt;
          if (effect.life <= 0) { effects.splice(e, 1); }
        }

        for (var l = labels.length - 1; l >= 0; l -= 1) {
          labels[l].y -= 0.026 * dt;
          labels[l].pop = Math.min(1, labels[l].pop + dt / 180);
          labels[l].life -= dt / 1900;
          if (labels[l].life <= 0) { labels.splice(l, 1); }
        }
      },

      render: function (ctx, width, height) {
        var now = performance.now();

        // Тряска кадра при реакции. Смещение всей сцены на несколько
        // пикселей воспринимается как удар, тогда как та же анимация,
        // применённая к одному сосуду, теряется среди прочих.
        ctx.save();
        if (shake > 0.02) {
          var amp = shake * 5;
          ctx.translate(u.rand(-amp, amp), u.rand(-amp, amp));
        }

        // Стена лаборатории.
        var wall = ctx.createLinearGradient(0, 0, 0, benchY);
        wall.addColorStop(0, '#0c1a22');
        wall.addColorStop(0.6, '#122a34');
        wall.addColorStop(1, '#0e2028');
        ctx.fillStyle = wall;
        ctx.fillRect(0, 0, width, benchY);

        var tile = Math.max(40, Math.min(width, height) / 9);
        ctx.strokeStyle = 'rgba(150, 210, 230, 0.05)';
        ctx.lineWidth = 1;
        for (var tx = tile; tx < width; tx += tile) {
          ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, benchY); ctx.stroke();
        }
        for (var ty = tile; ty < benchY; ty += tile) {
          ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(width, ty); ctx.stroke();
        }

        // Полка с реактивами.
        var shelfY = benchY * 0.4;
        shelfBottles.forEach(function (bottle) {
          var by = shelfY - bottle.h;
          ctx.fillStyle = 'rgba(200, 230, 240, 0.1)';
          draw.roundRect(ctx, bottle.x - bottle.w / 2, by, bottle.w, bottle.h, 3);
          ctx.fill();

          var liquidH = bottle.h * bottle.fill;
          ctx.fillStyle = u.rgba(bottle.rgb, 0.62);
          draw.roundRect(ctx, bottle.x - bottle.w / 2 + 1.5,
            by + bottle.h - liquidH, bottle.w - 3, liquidH - 1, 2);
          ctx.fill();
        });

        ctx.fillStyle = 'rgba(110, 145, 155, 0.55)';
        ctx.fillRect(0, shelfY, width, 5);

        // Вспышка реакции освещает всю лабораторию.
        if (glow > 0.02) {
          draw.glow(ctx, width / 2, benchY * 0.6, Math.max(width, height),
            'rgba(255, 240, 190, ALPHA)', glow * 0.35);
        }

        // Столешница.
        var bench = ctx.createLinearGradient(0, benchY, 0, height);
        bench.addColorStop(0, '#33404b');
        bench.addColorStop(0.08, '#212c35');
        bench.addColorStop(1, '#0e151b');
        ctx.fillStyle = bench;
        ctx.fillRect(0, benchY, width, height - benchY);

        ctx.strokeStyle = 'rgba(190, 235, 250, 0.28)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, benchY + 0.5);
        ctx.lineTo(width, benchY + 0.5);
        ctx.stroke();

        // Лужицы пролитого.
        drops.forEach(function (drop) {
          if (drop.y < benchY) { return; }
          ctx.beginPath();
          ctx.ellipse(drop.x, benchY + 3, drop.r * 3.6, drop.r * 1.2, 0, 0, TAU);
          ctx.fillStyle = u.rgba(drop.rgb, 0.4 * drop.life);
          ctx.fill();
        });

        // Кристаллы у горла — рисуются под колбами, будто наросли на стекле.
        effects.forEach(function (effect) {
          if (effect.type !== 'crystal') { return; }
          ctx.save();
          ctx.translate(effect.x, effect.y);
          ctx.rotate(effect.angle);
          var size = effect.r * (0.2 + 0.8 * effect.grow);
          ctx.beginPath();
          for (var v = 0; v < 6; v += 1) {
            var a = (TAU * v) / 6;
            ctx.lineTo(Math.cos(a) * size, Math.sin(a) * size * 1.5);
          }
          ctx.closePath();
          ctx.fillStyle = 'rgba(220, 245, 255, ' + (0.7 * effect.life).toFixed(3) + ')';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * effect.life).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        });

        // Колбы.
        flasks.forEach(function (flask) {
          draw.contactShadow(ctx, flask.x, benchY + 3,
            flask.w * 0.85, flask.h * 0.13, 0.5);

          ctx.save();
          var jolt = flask.jolt || 0;
          ctx.translate(
            flask.x + (jolt > 0.02 ? u.rand(-jolt * 3, jolt * 3) : 0),
            flask.y + (jolt > 0.02 ? u.rand(-jolt * 2, jolt * 2) : 0)
          );
          ctx.rotate(flask.angle + (jolt > 0.02 ? u.rand(-jolt, jolt) * 0.06 : 0));

          // Тёмная подложка внутри стекла: без неё жидкость сливается со
          // стеной, а пустая колба вообще не читается.
          flaskPath(ctx, flask);
          ctx.fillStyle = 'rgba(10, 22, 30, 0.72)';
          ctx.fill();

          drawLiquid(ctx, flask, now);

          // Стекло: контур, блик и мерные риски.
          flaskPath(ctx, flask);
          ctx.strokeStyle = flask === dragged
            ? 'rgba(200, 250, 255, 0.98)'
            : 'rgba(185, 230, 245, 0.7)';
          ctx.lineWidth = flask === dragged ? 2.6 : 1.8;
          ctx.stroke();

          // Блик и мерные риски обрезаются контуром сосуда. Коническая колба
          // сужается кверху, поэтому отрисовка по габаритному прямоугольнику
          // выводила штрихи за пределы стекла — что и было видно у крайних
          // сосудов в ряду.
          ctx.save();
          flaskPath(ctx, flask);
          ctx.clip();

          ctx.fillStyle = 'rgba(255,255,255,0.22)';
          ctx.fillRect(-flask.w * 0.28, -flask.h * 0.2, 3, flask.h * 0.45);

          ctx.strokeStyle = 'rgba(225, 248, 255, 0.4)';
          ctx.lineWidth = 1;
          for (var mark = 1; mark <= 4; mark += 1) {
            var my = flask.h / 2 - (flask.h * mark) / 5.5;
            ctx.beginPath();
            ctx.moveTo(flask.w * 0.16, my);
            ctx.lineTo(flask.w * (mark % 2 === 0 ? 0.34 : 0.26), my);
            ctx.stroke();
          }

          ctx.restore();
          ctx.restore();

          // Название реагента под колбой: без него реакция выглядит
          // случайной сменой цвета.
          ctx.font = '600 9px "Cascadia Mono", Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.fillStyle = u.rgba(flask.rgb, 0.85);
          ctx.fillText(
            REAGENTS[flask.kind].name + ' · ' + Math.round(flask.fill * 100) + '%',
            flask.x, benchY + 18
          );

          if (flask === dragged && Math.abs(flask.angle) < 0.06) {
            ctx.fillStyle = 'rgba(210, 245, 255, 0.8)';
            ctx.fillText(
              keys.ccw.replace('Key', '') + ' / ' + keys.cw.replace('Key', '') + ' — наклон',
              flask.x, flask.y - flask.h / 2 - 14
            );
          }
        });

        // Ударные волны: рисуются в режиме сложения, поэтому пересечение
        // нескольких колец даёт яркую вспышку, а не мутное наложение.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        effects.forEach(function (effect) {
          if (effect.type !== 'wave') { return; }
          ctx.beginPath();
          ctx.arc(effect.x, effect.y, effect.r, 0, TAU);
          ctx.strokeStyle = u.rgba(effect.rgb, (effect.life * 0.55).toFixed(3));
          ctx.lineWidth = 1 + effect.life * 3.5;
          ctx.stroke();
        });

        effects.forEach(function (effect) {
          if (effect.type !== 'spark') { return; }
          var gradient = ctx.createRadialGradient(
            effect.x, effect.y, 0, effect.x, effect.y, effect.r * 3.5
          );
          gradient.addColorStop(0, u.rgba(effect.rgb, effect.life * 0.95));
          gradient.addColorStop(1, u.rgba(effect.rgb, 0));
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(effect.x, effect.y, effect.r * 3.5, 0, TAU);
          ctx.fill();
        });
        ctx.restore();

        // Дым поверх всего.
        ctx.save();
        effects.forEach(function (effect) {
          if (effect.type !== 'smoke') { return; }
          var gradient = ctx.createRadialGradient(
            effect.x, effect.y, 0, effect.x, effect.y, effect.r
          );
          var tone = effect.rgb || [190, 200, 210];
          gradient.addColorStop(0, u.rgba(tone, (effect.life * 0.45).toFixed(3)));
          gradient.addColorStop(1, u.rgba(tone, 0));
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(effect.x, effect.y, effect.r, 0, TAU);
          ctx.fill();
        });
        ctx.restore();

        // Капли в полёте.
        drops.forEach(function (drop) {
          if (drop.y >= benchY) { return; }
          ctx.beginPath();
          ctx.ellipse(drop.x, drop.y, drop.r * 0.7, drop.r * 1.4, 0, 0, TAU);
          ctx.fillStyle = u.rgba(drop.rgb, 0.95);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(drop.x - drop.r * 0.25, drop.y - drop.r * 0.4, drop.r * 0.3, 0, TAU);
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.fill();
        });

        // Подписи реакций.
        labels.forEach(function (label) {
          // Всплеск размера в начале: подпись «выстреливает» и лишь затем
          // всплывает, что и создаёт ощущение события.
          var scale = 0.6 + 0.7 * Math.min(1, label.pop * 1.8);
          ctx.save();
          ctx.translate(label.x, label.y);
          ctx.scale(scale, scale);
          ctx.font = '700 17px "Segoe UI", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.shadowColor = 'rgba(255, 220, 120, 0.9)';
          ctx.shadowBlur = 14;
          ctx.fillStyle = 'rgba(255, 248, 214, ' + label.life.toFixed(2) + ')';
          ctx.fillText(label.text, 0, 0);
          ctx.restore();
        });

        ctx.restore();
        draw.vignette(ctx, width, height, 0.42);
      },

      draggables: function () { return []; },

      pointerDown: function (x, y) {
        for (var i = flasks.length - 1; i >= 0; i -= 1) {
          var flask = flasks[i];
          if (Math.abs(x - flask.x) < flask.w * 0.8 &&
              Math.abs(y - flask.y) < flask.h * 0.8) {
            dragged = flask;
            grabOffset = { x: flask.x - x, y: flask.y - y };
            flasks.splice(i, 1);
            flasks.push(flask);
            return;
          }
        }
      },

      pointerMove: function (x, y) {
        if (!dragged) { return; }
        var previous = dragged.x;
        dragged.x = u.clamp(x + grabOffset.x, dragged.w, env.width - dragged.w);
        dragged.y = u.clamp(y + grabOffset.y, dragged.h, benchY - dragged.h * 0.2);
        dragged.wobbleSpeed += (dragged.x - previous) * 0.01;
      },

      pointerUp: function () {
        if (dragged) {
          dragged.home.x = u.clamp(dragged.x, env.width * 0.1, env.width * 0.9);
          dragged.home.y = benchY - dragged.h / 2;
        }
        dragged = null;
        held.ccw = false;
        held.cw = false;
      },

      celebrate: function (count) {
        var lowest = flasks[0];
        flasks.forEach(function (flask) {
          if (flask.fill < lowest.fill) { lowest = flask; }
        });
        if (lowest) {
          lowest.fill = u.clamp(lowest.fill + 0.12 * u.clamp(count, 1, 5), 0, 1);
          lowest.wobbleSpeed += 0.9;
          spawnEffect('bubble', lowest, '+' + count);
        }
        glow = 0.8;
      },

      destroy: function () {
        flasks = []; drops = []; effects = []; labels = []; shelfBottles = [];
        dragged = null; held.ccw = false; held.cw = false;
        glow = 0; shake = 0;
      }
    };
  });
}(window));
