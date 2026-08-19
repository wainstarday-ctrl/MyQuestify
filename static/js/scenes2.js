/**
 * MyQuestify — сцены второго набора.
 *
 * Контракт тот же, что в scenes.js: фабрика получает окружение от ядра и
 * возвращает объект жизненного цикла. Файл отдельный, потому что первый
 * набор уже занимает больше тысячи строк, а сцены между собой не связаны.
 *
 * Механизм Времени и Плетение Смыслов считают динамику сами (`usesPhysics:
 * false`): зацепление шестерён и упругая сеть выражаются несколькими
 * строками математики, тогда как через тела и связи Matter пришлось бы
 * бороться с дрейфом и проскальзыванием.
 */
(function (global) {
  'use strict';

  if (!global.Stage) { return; }

  var TAU = Math.PI * 2;

  // ======================================================================= //
  // МЕХАНИЗМ ВРЕМЕНИ                                                        //
  // ======================================================================= //

  global.Stage.register('clockwork', function (env) {
    var draw = env.draw;
    var u = env.util;

    /** Затухание: механизм останавливается сам, но не мгновенно. */
    var FRICTION = 0.994;
    var SPIN_SCALE = 0.055;

    var BRASS = {
      light: '#f6d67a',
      mid: '#c9962f',
      dark: '#6d4c12',
      tooth: '#8a6a1c'
    };

    var gears = [];
    var dust = [];
    var pendulum = { x: 0, y: 0, len: 0, angle: 0, speed: 0 };
    var dragged = null;
    var lastAngleToPointer = 0;
    var level = env.level;

    /**
     * Строит цепочку сцепленных шестерён.
     *
     * Радиусы и позиции подобраны так, чтобы соседи касались делительными
     * окружностями: расстояние между центрами равно сумме радиусов. Иначе
     * зубцы визуально проходят сквозь друг друга.
     */
    function build(width, height) {
      gears = [];
      var scale = Math.min(width, height);
      var cx = width / 2;
      var cy = height / 2;

      // Больше уровень — длиннее цепочка передачи.
      var extra = u.clamp(Math.round((level - 1) / 3), 0, 2);

      var plan = [
        { r: scale * 0.20, x: cx - scale * 0.10, y: cy + scale * 0.04, teeth: 22 },
        { r: scale * 0.115, x: 0, y: 0, teeth: 13, angleFromPrev: -0.6 },
        { r: scale * 0.155, x: 0, y: 0, teeth: 17, angleFromPrev: 0.45 },
        { r: scale * 0.085, x: 0, y: 0, teeth: 10, angleFromPrev: -0.35 },
        { r: scale * 0.125, x: 0, y: 0, teeth: 14, angleFromPrev: 0.55 }
      ].slice(0, 3 + extra);

      plan.forEach(function (spec, index) {
        var gear;
        if (index === 0) {
          gear = { x: spec.x, y: spec.y, r: spec.r, teeth: spec.teeth };
        } else {
          var prev = gears[index - 1];
          var distance = prev.r + spec.r;
          var angle = spec.angleFromPrev;
          gear = {
            x: prev.x + Math.cos(angle) * distance,
            y: prev.y + Math.sin(angle) * distance,
            r: spec.r,
            teeth: spec.teeth
          };
        }

        gear.angle = u.rand(0, TAU);
        gear.speed = 0;
        gear.index = index;
        gears.push(gear);
      });

      // Сдвигаем всю цепочку так, чтобы она встала по центру холста.
      var minX = Math.min.apply(null, gears.map(function (g) { return g.x - g.r; }));
      var maxX = Math.max.apply(null, gears.map(function (g) { return g.x + g.r; }));
      var minY = Math.min.apply(null, gears.map(function (g) { return g.y - g.r; }));
      var maxY = Math.max.apply(null, gears.map(function (g) { return g.y + g.r; }));
      var dx = width / 2 - (minX + maxX) / 2;
      var dy = height / 2 - (minY + maxY) / 2;

      dust = env.draw.seedMotes(20, width, height, { speed: 0.35 });
      pendulum = {
        x: width / 2,
        y: height * 0.08,
        len: height * 0.62,
        angle: 0.3,
        speed: 0
      };

      var fit = Math.min(1, (width * 0.92) / (maxX - minX), (height * 0.92) / (maxY - minY));
      gears.forEach(function (gear) {
        gear.x = width / 2 + (gear.x + dx - width / 2) * fit;
        gear.y = height / 2 + (gear.y + dy - height / 2) * fit;
        gear.r *= fit;
      });
    }

    /**
     * Разгоняет всю цепочку от одной шестерни.
     *
     * Передаточное отношение обратно пропорционально радиусам и меняет знак:
     * сцепленные колёса крутятся в разные стороны. Именно поэтому маленькая
     * шестерня еле проворачивает большую, а большая срывает мелкие в вихрь.
     *
     * @param {Object} source шестерня-источник
     * @param {number} speed её угловая скорость
     */
    function propagate(source, speed) {
      source.speed = speed;

      for (var i = source.index - 1; i >= 0; i -= 1) {
        gears[i].speed = -gears[i + 1].speed * (gears[i + 1].r / gears[i].r);
      }
      for (var j = source.index + 1; j < gears.length; j += 1) {
        gears[j].speed = -gears[j - 1].speed * (gears[j - 1].r / gears[j].r);
      }
    }

    /** Рисует одну шестерню с зубцами, спицами и втулкой. */
    function drawGear(ctx, gear) {
      var toothDepth = gear.r * 0.16;
      var inner = gear.r - toothDepth;

      ctx.save();
      ctx.translate(gear.x, gear.y);

      // Тень под колесом: механизм висит над задником, а не наклеен на него.
      ctx.save();
      ctx.globalAlpha = 0.4;
      draw.contactShadow(ctx, 4, 8, gear.r * 1.05, gear.r * 0.95, 0.5);
      ctx.restore();

      ctx.rotate(gear.angle);

      // Зубцы трапецией: прямоугольные выглядят как пила, а не как зубчатое
      // колесо.
      ctx.beginPath();
      for (var i = 0; i < gear.teeth; i += 1) {
        var a0 = (TAU * i) / gear.teeth;
        var step = TAU / gear.teeth;
        ctx.lineTo(Math.cos(a0) * inner, Math.sin(a0) * inner);
        ctx.lineTo(Math.cos(a0 + step * 0.22) * gear.r, Math.sin(a0 + step * 0.22) * gear.r);
        ctx.lineTo(Math.cos(a0 + step * 0.5) * gear.r, Math.sin(a0 + step * 0.5) * gear.r);
        ctx.lineTo(Math.cos(a0 + step * 0.72) * inner, Math.sin(a0 + step * 0.72) * inner);
      }
      ctx.closePath();

      var body = ctx.createLinearGradient(-gear.r, -gear.r, gear.r, gear.r);
      body.addColorStop(0, BRASS.light);
      body.addColorStop(0.45, BRASS.mid);
      body.addColorStop(1, BRASS.dark);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.strokeStyle = BRASS.tooth;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Спицы.
      var spokes = gear.r > 40 ? 6 : 4;
      ctx.strokeStyle = 'rgba(60, 40, 8, 0.55)';
      ctx.lineWidth = Math.max(3, gear.r * 0.09);
      for (var s = 0; s < spokes; s += 1) {
        var angle = (TAU * s) / spokes;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * gear.r * 0.22, Math.sin(angle) * gear.r * 0.22);
        ctx.lineTo(Math.cos(angle) * inner * 0.82, Math.sin(angle) * inner * 0.82);
        ctx.stroke();
      }

      // Втулка.
      draw.sphere(ctx, 0, 0, gear.r * 0.2, BRASS.light, BRASS.dark);

      ctx.restore();
    }

    return {
      usesPhysics: false,
      hint: 'Схвати шестерню и крутани. Маленькая проворачивает большую с трудом, большая срывает мелкие в вихрь.',

      build: build,
      resize: function (w, h) { build(w, h); },
      setLevel: function (next) { level = next; build(env.width, env.height); },

      update: function (dt) {
        // Маятник живёт своей жизнью: башня идёт, даже когда её не трогают.
        pendulum.speed += -0.00022 * Math.sin(pendulum.angle) * dt;
        pendulum.speed *= 0.9995;
        pendulum.angle += pendulum.speed * dt;
        if (Math.abs(pendulum.angle) < 0.05 && Math.abs(pendulum.speed) < 0.0002) {
          pendulum.speed = 0.0016;   // подталкиваем, иначе остановится совсем
        }

        gears.forEach(function (gear) {
          gear.angle = (gear.angle + gear.speed * dt) % TAU;
          if (gear !== dragged) {
            gear.speed *= Math.pow(FRICTION, dt / 16.7);
            if (Math.abs(gear.speed) < 0.000012) { gear.speed = 0; }
          }
        });
      },

      render: function (ctx, width, height, dt) {
        var wall = ctx.createRadialGradient(
          width / 2, height * 0.4, 0, width / 2, height * 0.5, Math.max(width, height) * 0.75
        );
        wall.addColorStop(0, '#241a10');
        wall.addColorStop(0.6, '#150f0a');
        wall.addColorStop(1, '#0b0806');
        ctx.fillStyle = wall;
        ctx.fillRect(0, 0, width, height);

        // Циферблат на дальней стене: механизм получает смысл.
        var faceR = Math.min(width, height) * 0.36;
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, faceR, 0, TAU);
        ctx.strokeStyle = '#d9b46a';
        ctx.lineWidth = 3;
        ctx.stroke();

        for (var h = 0; h < 12; h += 1) {
          var a = (TAU * h) / 12 - Math.PI / 2;
          var major = h % 3 === 0;
          ctx.beginPath();
          ctx.moveTo(width / 2 + Math.cos(a) * faceR * 0.88,
                     height / 2 + Math.sin(a) * faceR * 0.88);
          ctx.lineTo(width / 2 + Math.cos(a) * faceR * (major ? 0.74 : 0.8),
                     height / 2 + Math.sin(a) * faceR * (major ? 0.74 : 0.8));
          ctx.strokeStyle = '#e8c887';
          ctx.lineWidth = major ? 5 : 2.5;
          ctx.stroke();
        }
        ctx.restore();

        // Маятник за шестернями.
        var px = pendulum.x + Math.sin(pendulum.angle) * pendulum.len;
        var py = pendulum.y + Math.cos(pendulum.angle) * pendulum.len;
        ctx.beginPath();
        ctx.moveTo(pendulum.x, pendulum.y);
        ctx.lineTo(px, py);
        ctx.strokeStyle = 'rgba(190, 150, 70, 0.4)';
        ctx.lineWidth = 3;
        ctx.stroke();
        draw.sphere(ctx, px, py, Math.min(width, height) * 0.045,
          BRASS.light, BRASS.dark, 'rgba(255, 230, 160, 0.5)');

        // Тёплый свет сверху — латунь без источника света выглядит грязью.
        draw.glow(ctx, width * 0.5, -height * 0.12, height * 1.1,
          'rgba(255, 200, 110, ALPHA)', 0.11);

        gears.forEach(function (gear) { drawGear(ctx, gear); });

        draw.motes(ctx, dust, width, height, dt || 16, 'rgba(255, 220, 160, ALPHA)');
        draw.vignette(ctx, width, height, 0.52);
      },

      draggables: function () { return []; },

      pointerDown: function (x, y) {
        for (var i = 0; i < gears.length; i += 1) {
          var dx = x - gears[i].x;
          var dy = y - gears[i].y;
          if (Math.sqrt(dx * dx + dy * dy) <= gears[i].r) {
            dragged = gears[i];
            lastAngleToPointer = Math.atan2(dy, dx);
            return;
          }
        }
      },

      pointerMove: function (x, y) {
        if (!dragged) { return; }

        var angle = Math.atan2(y - dragged.y, x - dragged.x);
        var delta = angle - lastAngleToPointer;

        // Нормализация через ±π: без неё переход через 180° давал скачок
        // почти в полный оборот и механизм дёргался.
        while (delta > Math.PI) { delta -= TAU; }
        while (delta < -Math.PI) { delta += TAU; }

        lastAngleToPointer = angle;
        propagate(dragged, u.clamp(delta * SPIN_SCALE, -0.02, 0.02));
        dragged.angle += delta;
      },

      pointerUp: function () { dragged = null; },

      celebrate: function (count) {
        if (!gears.length) { return; }
        propagate(gears[0], 0.006 * u.clamp(count, 1, 6));
      },

      destroy: function () { gears = []; dragged = null; }
    };
  });

  // ======================================================================= //
  // ПРУД БЕЗМОЛВИЯ                                                          //
  // ======================================================================= //

  global.Stage.register('pond', function (env) {
    var M = env.M;
    var draw = env.draw;
    var u = env.util;

    var MAX_LEAVES = 26;
    var WATER_DENSITY = 0.0016;
    var COLUMNS = 96;              // узлов в модели волны

    var scenery = [];
    var leaves = [];
    var wave = [];                 // {height, velocity} по столбцам
    var ripples = [];
    var surfaceY = 0;
    var level = env.level;
    var lastPointer = null;
    var reeds = [];
    var fish = [];
    var fog = [];

    function targetLeaves() {
      return u.clamp(4 + Math.round(u.clamp(level, 1, 10) * 1.2), 5, MAX_LEAVES);
    }

    /**
     * Волна как цепочка связанных пружин.
     *
     * Каждый столбец тянется к нулю и обменивается высотой с соседями —
     * возмущение расходится кругами и затухает само. Синусоида такого не
     * умеет: она не помнит, где её толкнули.
     */
    function stepWave(dt) {
      var tension = 0.021;
      var damping = 0.978;
      var spread = 0.19;
      var frames = u.clamp(dt / 16.7, 0.5, 2);

      for (var pass = 0; pass < frames; pass += 1) {
        for (var i = 0; i < COLUMNS; i += 1) {
          var node = wave[i];
          node.velocity += -tension * node.height;
          node.velocity *= damping;
          node.height += node.velocity;
        }

        var deltas = new Array(COLUMNS);
        for (var j = 0; j < COLUMNS; j += 1) {
          var left = wave[j - 1] ? wave[j - 1].height : wave[j].height;
          var right = wave[j + 1] ? wave[j + 1].height : wave[j].height;
          deltas[j] = spread * ((left - wave[j].height) + (right - wave[j].height));
        }
        for (var k = 0; k < COLUMNS; k += 1) {
          wave[k].height += deltas[k];
          wave[k].velocity += deltas[k] * 0.5;
        }
      }
    }

    /**
     * Возмущает поверхность в точке.
     * @param {number} x координата по холсту
     * @param {number} power сила
     */
    function splash(x, power) {
      var index = Math.round((x / env.width) * (COLUMNS - 1));
      for (var offset = -2; offset <= 2; offset += 1) {
        var node = wave[index + offset];
        if (node) {
          node.velocity -= power * (1 - Math.abs(offset) * 0.3);
        }
      }
      ripples.push({ x: x, r: 4, life: 1 });
    }

    function makeLeaf(x, y) {
      var scale = u.clamp(env.width / 620, 0.7, 1.6);
      var leaf = M.Bodies.circle(x, y, u.rand(14, 22) * scale, {
        frictionAir: 0.04,
        restitution: 0.15,
        density: 0.0007      // легче воды: всплывает
      });
      leaf.plugin = {
        hue: u.rand(120, 165),
        notch: u.rand(0, TAU),
        wobble: u.rand(0, TAU)
      };
      M.Body.setAngularVelocity(leaf, u.rand(-0.02, 0.02));
      return leaf;
    }

    function addLeaves(count, fromAbove) {
      for (var i = 0; i < count; i += 1) {
        var leaf = makeLeaf(
          u.rand(env.width * 0.15, env.width * 0.85),
          fromAbove ? u.rand(-60, 0) : u.rand(surfaceY + 10, env.height * 0.85)
        );
        leaves.push(leaf);
        M.Composite.add(env.world, leaf);
      }
      while (leaves.length > MAX_LEAVES) {
        M.Composite.remove(env.world, leaves.shift());
      }
    }

    function build(width, height) {
      M.Composite.remove(env.world, scenery);
      scenery = [];
      leaves.forEach(function (leaf) { M.Composite.remove(env.world, leaf); });
      leaves = [];

      surfaceY = height * 0.32;

      wave = [];
      for (var i = 0; i < COLUMNS; i += 1) {
        wave.push({ height: 0, velocity: 0 });
      }

      scenery.push(M.Bodies.rectangle(width / 2, height + 30, width * 2, 60, { isStatic: true }));
      scenery.push(M.Bodies.rectangle(-30, height / 2, 60, height * 3, { isStatic: true }));
      scenery.push(M.Bodies.rectangle(width + 30, height / 2, 60, height * 3, { isStatic: true }));
      M.Composite.add(env.world, scenery);

      reeds = [];
      for (var r = 0; r < Math.round(width / 26); r += 1) {
        var side = Math.random() < 0.5;
        reeds.push({
          x: side ? u.rand(0, width * 0.22) : u.rand(width * 0.78, width),
          h: u.rand(height * 0.1, height * 0.26),
          lean: u.rand(-0.25, 0.25),
          phase: u.rand(0, TAU)
        });
      }

      // Тени рыб под поверхностью: пруд обитаем, но никого не видно целиком.
      fish = [];
      for (var f = 0; f < 3; f += 1) {
        fish.push({
          x: u.rand(0, width),
          y: u.rand(surfaceY + height * 0.12, height * 0.85),
          vx: u.rand(0.2, 0.5) * (Math.random() < 0.5 ? -1 : 1),
          size: u.rand(14, 26),
          phase: u.rand(0, TAU)
        });
      }

      fog = env.draw.seedMotes(16, width, surfaceY, { speed: 0.3 });
      addLeaves(targetLeaves(), false);
    }

    /** Высота воды в точке с учётом волны. */
    function waterAt(x) {
      var index = u.clamp(Math.round((x / env.width) * (COLUMNS - 1)), 0, COLUMNS - 1);
      return surfaceY + wave[index].height;
    }

    return {
      usesPhysics: true,
      hint: 'Проведи по воде — разойдутся волны и растолкают кувшинки. Листья можно брать в руки.',

      build: build,
      resize: function (w, h) { build(w, h); },

      setLevel: function (next) {
        level = next;
        var missing = targetLeaves() - leaves.length;
        if (missing > 0) { addLeaves(missing, true); }
      },

      update: function (dt) {
        stepWave(dt);

        leaves.forEach(function (leaf) {
          var level0 = waterAt(leaf.position.x);
          var depth = leaf.position.y + leaf.circleRadius - level0;

          if (depth > 0) {
            // Архимед: сила пропорциональна погружённому объёму. Поэтому лист
            // не проваливается на дно и не выпрыгивает — он покачивается.
            var submerged = Math.min(depth, leaf.circleRadius * 2);
            var lift = WATER_DENSITY * submerged * leaf.circleRadius;
            M.Body.applyForce(leaf, leaf.position, { x: 0, y: -lift });

            // Вязкость: в воде движение гасится сильнее, чем в воздухе.
            M.Body.setVelocity(leaf, {
              x: leaf.velocity.x * 0.94,
              y: leaf.velocity.y * 0.88
            });

            // Наклон волны сносит лист вбок — течение читается глазом.
            var slope = waterAt(leaf.position.x + 12) - waterAt(leaf.position.x - 12);
            M.Body.applyForce(leaf, leaf.position, { x: -slope * 0.00004, y: 0 });
          }
        });

        fish.forEach(function (one) {
          one.x += one.vx * (dt / 16.7);
          one.phase += dt * 0.002;
          one.y += Math.sin(one.phase) * 0.25;
          if (one.x < -60) { one.x = env.width + 50; }
          if (one.x > env.width + 60) { one.x = -50; }
        });

        for (var i = ripples.length - 1; i >= 0; i -= 1) {
          ripples[i].r += dt * 0.14;
          ripples[i].life -= dt / 900;
          if (ripples[i].life <= 0) { ripples.splice(i, 1); }
        }
      },

      render: function (ctx, width, height, dt) {
        var now = performance.now();

        var sky = ctx.createLinearGradient(0, 0, 0, surfaceY);
        sky.addColorStop(0, '#08191f');
        sky.addColorStop(0.6, '#0f2c35');
        sky.addColorStop(1, '#154049');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, width, surfaceY + 4);

        // Дальний берег.
        draw.ridge(ctx, width, surfaceY - height * 0.05, height * 0.035, 1.9, '#0a2229');

        // Толща воды.
        var water = ctx.createLinearGradient(0, surfaceY, 0, height);
        water.addColorStop(0, '#12707a');
        water.addColorStop(0.35, '#0c4d5c');
        water.addColorStop(1, '#04222c');

        ctx.beginPath();
        ctx.moveTo(0, height);
        for (var i = 0; i < COLUMNS; i += 1) {
          ctx.lineTo((i / (COLUMNS - 1)) * width, surfaceY + wave[i].height);
        }
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fillStyle = water;
        ctx.fill();

        // Блик по кромке волны.
        ctx.beginPath();
        for (var j = 0; j < COLUMNS; j += 1) {
          ctx.lineTo((j / (COLUMNS - 1)) * width, surfaceY + wave[j].height);
        }
        ctx.strokeStyle = 'rgba(190, 255, 250, 0.5)';
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // Тени рыб: размытые пятна в толще, читаются только движением.
        fish.forEach(function (one) {
          ctx.save();
          ctx.globalAlpha = 0.22;
          ctx.beginPath();
          ctx.ellipse(one.x, one.y, one.size, one.size * 0.35,
            one.vx > 0 ? 0.1 : -0.1, 0, TAU);
          ctx.fillStyle = '#03181f';
          ctx.fill();
          ctx.restore();
        });

        // Круги на воде.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ripples.forEach(function (ripple) {
          ctx.beginPath();
          ctx.ellipse(ripple.x, surfaceY + 6, ripple.r, ripple.r * 0.22, 0, 0, TAU);
          ctx.strokeStyle = 'rgba(180, 250, 255, ' + (ripple.life * 0.35).toFixed(3) + ')';
          ctx.lineWidth = 1.4;
          ctx.stroke();
        });
        ctx.restore();

        leaves.forEach(function (leaf) {
          var r = leaf.circleRadius;
          var plugin = leaf.plugin;
          var submerged = leaf.position.y > waterAt(leaf.position.x);

          ctx.save();
          ctx.translate(leaf.position.x, leaf.position.y);
          ctx.rotate(leaf.angle);
          ctx.globalAlpha = submerged ? 0.9 : 1;

          // Лист кувшинки — круг с вырезанным клином.
          ctx.beginPath();
          ctx.arc(0, 0, r, plugin.notch + 0.42, plugin.notch - 0.42);
          ctx.lineTo(0, 0);
          ctx.closePath();

          var body = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
          body.addColorStop(0, 'hsl(' + plugin.hue + ', 55%, 52%)');
          body.addColorStop(1, 'hsl(' + plugin.hue + ', 60%, 24%)');
          ctx.fillStyle = body;
          ctx.fill();
          ctx.strokeStyle = 'rgba(220, 255, 230, 0.28)';
          ctx.lineWidth = 1;
          ctx.stroke();

          // Прожилки.
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
          for (var v = 0; v < 5; v += 1) {
            var angle = plugin.notch + 0.6 + (v * (TAU - 1.2)) / 5;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(angle) * r * 0.88, Math.sin(angle) * r * 0.88);
            ctx.stroke();
          }
          ctx.restore();
        });

        // Камыш по берегам, качается медленнее травы — он тяжелее.
        ctx.lineCap = 'round';
        reeds.forEach(function (reed) {
          var sway = Math.sin(now * 0.0006 + reed.phase) * 6;
          ctx.beginPath();
          ctx.moveTo(reed.x, surfaceY + 10);
          ctx.quadraticCurveTo(
            reed.x + reed.lean * 14 + sway * 0.4, surfaceY - reed.h * 0.55,
            reed.x + reed.lean * 26 + sway, surfaceY - reed.h
          );
          ctx.strokeStyle = 'rgba(70, 130, 110, 0.55)';
          ctx.lineWidth = 2.2;
          ctx.stroke();
        });

        // Туман над водой.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        draw.motes(ctx, fog, width, surfaceY + 30, dt || 16, 'rgba(190, 240, 240, ALPHA)');
        ctx.restore();

        draw.vignette(ctx, width, height, 0.4);
      },

      draggables: function () { return leaves; },

      pointerDown: function (x, y) {
        lastPointer = { x: x, y: y };
        if (Math.abs(y - waterAt(x)) < env.height * 0.3) { splash(x, 2.2); }
      },

      pointerMove: function (x, y) {
        if (!lastPointer) { return; }
        var speed = Math.abs(x - lastPointer.x) + Math.abs(y - lastPointer.y);
        lastPointer = { x: x, y: y };
        if (speed > 3 && Math.abs(y - waterAt(x)) < 60) {
          splash(x, u.clamp(speed * 0.06, 0.3, 2.6));
        }
      },

      pointerUp: function () { lastPointer = null; },

      celebrate: function (count) {
        addLeaves(u.clamp(count, 1, 4), true);
        splash(env.width * u.rand(0.3, 0.7), 3.4);
      },

      destroy: function () {
        leaves = []; scenery = []; ripples = []; reeds = []; fish = []; fog = [];
      }
    };
  });

  // ======================================================================= //
  // ПЛЕТЕНИЕ СМЫСЛОВ                                                        //
  // ======================================================================= //

  global.Stage.register('weave', function (env) {
    var draw = env.draw;
    var u = env.util;

    var STIFFNESS = 0.014;
    var DAMPING = 0.972;
    var REPULSION = 900;

    var nodes = [];
    var links = [];
    var dragged = null;
    var level = env.level;
    var tension = 0;
    var motes = [];

    function build(width, height) {
      nodes = [];
      links = [];

      var count = u.clamp(6 + Math.round(u.clamp(level, 1, 10) * 0.9), 7, 16);
      var radius = Math.min(width, height) * 0.3;

      for (var i = 0; i < count; i += 1) {
        var angle = (TAU * i) / count + u.rand(-0.2, 0.2);
        var spread = radius * u.rand(0.55, 1.05);
        nodes.push({
          x: width / 2 + Math.cos(angle) * spread,
          y: height / 2 + Math.sin(angle) * spread * 0.82,
          vx: 0,
          vy: 0,
          r: u.clamp(Math.min(width, height) * u.rand(0.018, 0.032), 7, 20),
          hue: u.rand(160, 290),
          pulse: u.rand(0, TAU)
        });
      }

      // Кольцо плюс хорды: связный граф без изолированных узлов, но и без
      // полного перебора пар — иначе сеть превращается в жёсткий ком.
      for (var j = 0; j < count; j += 1) {
        links.push({ a: j, b: (j + 1) % count });
      }
      for (var k = 0; k < Math.floor(count / 2); k += 1) {
        var a = Math.floor(u.rand(0, count));
        var b = (a + 2 + Math.floor(u.rand(0, count - 3))) % count;
        if (a !== b) { links.push({ a: a, b: b }); }
      }

      links.forEach(function (link) {
        var na = nodes[link.a];
        var nb = nodes[link.b];
        link.rest = Math.sqrt(
          Math.pow(na.x - nb.x, 2) + Math.pow(na.y - nb.y, 2)
        );
      });

      motes = env.draw.seedMotes(30, width, height, { speed: 0.35 });
    }

    return {
      usesPhysics: false,
      hint: 'Потяни любой узел — сеть натянется и воспротивится. Отпусти: она спружинит обратно в равновесие.',

      build: build,
      resize: function (w, h) { build(w, h); },
      setLevel: function (next) { level = next; build(env.width, env.height); },

      update: function (dt) {
        var frames = u.clamp(dt / 16.7, 0.5, 2);
        var stretch = 0;

        // Пружины связей.
        links.forEach(function (link) {
          var a = nodes[link.a];
          var b = nodes[link.b];
          var dx = b.x - a.x;
          var dy = b.y - a.y;
          var distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          var force = (distance - link.rest) * STIFFNESS * frames;

          link.strain = Math.abs(distance - link.rest) / link.rest;
          stretch = Math.max(stretch, link.strain);

          var fx = (dx / distance) * force;
          var fy = (dy / distance) * force;

          if (a !== dragged) { a.vx += fx; a.vy += fy; }
          if (b !== dragged) { b.vx -= fx; b.vy -= fy; }
        });

        // Отталкивание: без него узлы слипаются в точку и сеть исчезает.
        for (var i = 0; i < nodes.length; i += 1) {
          for (var j = i + 1; j < nodes.length; j += 1) {
            var a2 = nodes[i];
            var b2 = nodes[j];
            var dx2 = b2.x - a2.x;
            var dy2 = b2.y - a2.y;
            var d2 = Math.max(24, dx2 * dx2 + dy2 * dy2);
            var push = (REPULSION / d2) * frames;
            var len = Math.sqrt(d2);
            if (a2 !== dragged) { a2.vx -= (dx2 / len) * push; a2.vy -= (dy2 / len) * push; }
            if (b2 !== dragged) { b2.vx += (dx2 / len) * push; b2.vy += (dy2 / len) * push; }
          }
        }

        tension = tension * 0.9 + stretch * 0.1;

        nodes.forEach(function (node) {
          if (node === dragged) { return; }

          // Слабое притяжение к центру заменяет стенки: сеть дрейфует
          // в невесомости, но не уплывает за холст.
          node.vx += (env.width / 2 - node.x) * 0.00035 * frames;
          node.vy += (env.height / 2 - node.y) * 0.00035 * frames;

          node.vx *= Math.pow(DAMPING, frames);
          node.vy *= Math.pow(DAMPING, frames);
          node.x += node.vx * frames;
          node.y += node.vy * frames;
          node.pulse += 0.0012 * dt;
        });
      },

      render: function (ctx, width, height, dt) {
        var space = ctx.createRadialGradient(
          width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7
        );
        space.addColorStop(0, '#0d1224');
        space.addColorStop(1, '#04050c');
        ctx.fillStyle = space;
        ctx.fillRect(0, 0, width, height);

        // Координатная сетка в глубине: сеть висит в пространстве, а не
        // в пустоте. Шаг крупный, чтобы не спорить со связями.
        var cell = Math.max(46, Math.min(width, height) / 9);
        ctx.strokeStyle = 'rgba(90, 130, 200, 0.07)';
        ctx.lineWidth = 1;
        for (var gx = cell; gx < width; gx += cell) {
          ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, height); ctx.stroke();
        }
        for (var gy = cell; gy < height; gy += cell) {
          ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(width, gy); ctx.stroke();
        }

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        draw.motes(ctx, motes, width, height, dt || 16, 'rgba(140, 200, 255, ALPHA)');
        ctx.restore();

        // Натянутые нити светятся ярче и дрожат — сеть «жалуется» на нагрузку.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        links.forEach(function (link) {
          var a = nodes[link.a];
          var b = nodes[link.b];
          var strain = u.clamp(link.strain || 0, 0, 1);
          var jitter = strain > 0.35 ? strain * 2.4 : 0;

          ctx.beginPath();
          ctx.moveTo(a.x + u.rand(-jitter, jitter), a.y + u.rand(-jitter, jitter));
          ctx.lineTo(b.x + u.rand(-jitter, jitter), b.y + u.rand(-jitter, jitter));

          var gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          gradient.addColorStop(0, 'hsla(' + a.hue + ', 90%, 65%, ' + (0.28 + strain * 0.55).toFixed(2) + ')');
          gradient.addColorStop(1, 'hsla(' + b.hue + ', 90%, 65%, ' + (0.28 + strain * 0.55).toFixed(2) + ')');
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 1 + strain * 2.2;
          ctx.stroke();
        });
        ctx.restore();

        nodes.forEach(function (node) {
          var pulse = 1 + Math.sin(node.pulse) * 0.08;
          var color = 'hsla(' + node.hue + ', 92%, 66%, ALPHA)';
          draw.glow(ctx, node.x, node.y, node.r * 4.5, color,
            node === dragged ? 0.5 : 0.28);
          draw.sphere(
            ctx, node.x, node.y, node.r * pulse,
            'hsl(' + node.hue + ', 95%, 80%)',
            'hsl(' + node.hue + ', 80%, 32%)',
            'rgba(255,255,255,0.45)'
          );
        });

        draw.vignette(ctx, width, height, 0.5);

        // Лёгкий глитч при сильном натяжении. Рисуется последним, поверх
        // виньетки: помеха идёт по всему кадру, а не по его содержимому.
        if (tension > 0.3) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = u.clamp((tension - 0.3) * 0.5, 0, 0.22);
          for (var i = 0; i < 3; i += 1) {
            var y = u.rand(0, height);
            ctx.fillStyle = i % 2 ? 'rgba(120, 220, 255, 0.5)' : 'rgba(255, 120, 220, 0.4)';
            ctx.fillRect(0, y, width, u.rand(1, 3));
          }
          ctx.restore();
        }
      },

      draggables: function () { return []; },

      pointerDown: function (x, y) {
        for (var i = nodes.length - 1; i >= 0; i -= 1) {
          var dx = nodes[i].x - x;
          var dy = nodes[i].y - y;
          if (Math.sqrt(dx * dx + dy * dy) <= nodes[i].r + 10) {
            dragged = nodes[i];
            return;
          }
        }
      },

      pointerMove: function (x, y) {
        if (!dragged) { return; }
        dragged.vx = (x - dragged.x) * 0.2;
        dragged.vy = (y - dragged.y) * 0.2;
        dragged.x = x;
        dragged.y = y;
      },

      pointerUp: function () { dragged = null; },

      celebrate: function (count) {
        // Импульс расходится по сети волной — видно, как связи передают удар.
        var index = Math.floor(u.rand(0, nodes.length));
        var force = u.clamp(count, 1, 6) * 2.2;
        nodes[index].vx += u.rand(-force, force);
        nodes[index].vy += u.rand(-force, force);
      },

      destroy: function () { nodes = []; links = []; dragged = null; motes = []; }
    };
  });

  // ======================================================================= //
  // ЛАГЕРЬ УЕДИНЕНИЯ                                                        //
  // ======================================================================= //

  /**
   * Костёр в ночном лагере.
   *
   * Сцена сочетает три независимые модели. Поленья — тела Matter с обычной
   * гравитацией: их бросают, они сталкиваются и складываются в кучу.
   * Пламя и искры считаются отдельно, потому что для них гравитация
   * обратная — тёплый воздух несёт частицы вверх, — а движок работает с
   * единым для мира вектором силы тяжести.
   *
   * Топливо связывает обе модели: каждое полено несёт запас, который
   * расходуется, пока полено лежит в очаге. От суммарного запаса зависят
   * высота пламени, плотность потока искр и яркость освещения сцены.
   * Костёр, оставленный без внимания, прогорает и гаснет.
   */
  global.Stage.register('campfire', function (env) {
    var M = env.M;
    var draw = env.draw;
    var u = env.util;

    var MAX_SPARKS = 320;
    var MAX_LOGS = 16;
    var MAX_EMBERS = 90;

    /**
     * Скорость расхода топлива, доли запаса за миллисекунду.
     *
     * Подобрана так, чтобы одно полено прогорало примерно за три минуты, а
     * начальные три — за девять. Более быстрое горение превращало бы сцену
     * в бесконечное подбрасывание дров, более медленное сделало бы запас
     * незаметным, и вся модель топлива потеряла бы смысл.
     */
    var BURN_RATE = 0.0000055;

    /** Радиус, в пределах которого полено считается лежащим в огне. */
    var HEARTH_FACTOR = 1.9;

    var scenery = [];
    var logs = [];
    var sparks = [];
    var embers = [];
    var flames = [];
    var smoke = [];
    var stars = [];
    var stones = [];
    var shooting = [];
    var kettle = null;

    var fire = { x: 0, y: 0, r: 0 };
    var groundY = 0;
    var level = env.level;
    var pointer = null;
    var lastPointer = null;
    var wind = 0;
    var breath = 0;
    var emitAccumulator = 0;
    var flare = 0;

    /**
     * Суммарный запас топлива в очаге.
     *
     * Учитываются только поленья, лежащие достаточно близко к центру:
     * отброшенное в сторону полено не должно поддерживать огонь.
     *
     * @returns {number} запас в условных единицах
     */
    function fuel() {
      var total = 0;
      for (var i = 0; i < logs.length; i += 1) {
        var log = logs[i];
        var dx = log.position.x - fire.x;
        var dy = log.position.y - fire.y;
        if (Math.sqrt(dx * dx + dy * dy) < fire.r * HEARTH_FACTOR) {
          total += log.plugin.fuel;
        }
      }
      return total;
    }

    /**
     * Текущая сила огня.
     *
     * Складывается из запаса топлива, уровня сцены и раздувания курсором.
     * Нижняя граница не равна нулю: полностью потухший костёр превратил бы
     * сцену в чёрный прямоугольник, из которого нет выхода без нового
     * полена, — вместо этого остаются тлеющие угли.
     *
     * @returns {number} множитель интенсивности
     */
    function intensity() {
      var base = 0.25 + Math.min(2.2, fuel() * 0.55);
      return u.clamp(base + level * 0.04 + breath * 0.9 + flare, 0.25, 3.4);
    }

    /**
     * Создаёт языки пламени.
     *
     * Каждый язык — независимый осциллятор со своей фазой и частотой.
     * Их наложение даёт нерегулярное движение, тогда как один общий
     * источник колебания читался бы как машинная пульсация.
     *
     * @param {number} count количество языков
     */
    function seedFlames(count) {
      flames = [];
      for (var i = 0; i < count; i += 1) {
        flames.push({
          offset: u.rand(-0.9, 0.9),
          height: u.rand(0.55, 1.25),
          width: u.rand(0.35, 0.75),
          phase: u.rand(0, TAU),
          speed: u.rand(0.0016, 0.0042),
          sway: u.rand(0.3, 1.1)
        });
      }
    }

    /** Насыпает угли в основании очага. */
    function seedEmbers() {
      embers = [];
      for (var i = 0; i < MAX_EMBERS; i += 1) {
        var angle = u.rand(0, TAU);
        var radius = Math.sqrt(Math.random()) * fire.r * 1.15;
        embers.push({
          x: fire.x + Math.cos(angle) * radius,
          y: groundY - 2 + Math.sin(angle) * fire.r * 0.22,
          r: u.rand(1.6, 4.2),
          heat: u.rand(0.35, 1),
          pulse: u.rand(0, TAU),
          rate: u.rand(0.0012, 0.0035)
        });
      }
    }

    /**
     * Подвешивает котелок на треногу.
     *
     * Котелок — единственный объект сцены на связи Matter: маятник
     * достоверно передаётся именно связью, тогда как ручной расчёт
     * потребовал бы отдельного интегратора ради одного предмета.
     */
    function hangKettle(width, height) {
      if (kettle) {
        M.Composite.remove(env.world, [kettle.body, kettle.rope]);
        kettle = null;
      }

      var scale = u.clamp(Math.min(width, height) / 460, 0.6, 1.4);
      var barY = groundY - height * 0.3;
      var body = M.Bodies.rectangle(
        fire.x, barY + height * 0.14, 34 * scale, 26 * scale,
        { chamfer: { radius: 6 }, friction: 0.4, restitution: 0.15, density: 0.004 }
      );
      var rope = M.Constraint.create({
        pointA: { x: fire.x, y: barY },
        bodyB: body,
        pointB: { x: 0, y: -13 * scale },
        length: height * 0.14,
        stiffness: 0.9,
        damping: 0.06
      });

      kettle = { body: body, rope: rope, anchor: { x: fire.x, y: barY }, scale: scale };
      M.Composite.add(env.world, [body, rope]);
    }

    function build(width, height) {
      M.Composite.remove(env.world, scenery);
      scenery = [];
      logs.forEach(function (log) { M.Composite.remove(env.world, log); });
      logs = [];
      sparks = [];
      smoke = [];
      shooting = [];

      groundY = height * 0.82;
      fire = { x: width / 2, y: groundY - height * 0.03, r: Math.min(width, height) * 0.09 };

      scenery.push(M.Bodies.rectangle(
        width / 2, groundY + (height - groundY) / 2, width * 2, height - groundY,
        { isStatic: true, friction: 0.85 }
      ));
      scenery.push(M.Bodies.rectangle(-40, height / 2, 80, height * 3, { isStatic: true }));
      scenery.push(M.Bodies.rectangle(width + 40, height / 2, 80, height * 3, { isStatic: true }));
      M.Composite.add(env.world, scenery);

      stars = [];
      for (var s = 0; s < Math.round(width / 11); s += 1) {
        stars.push({
          x: u.rand(0, width),
          y: u.rand(0, groundY * 0.75),
          r: u.rand(0.4, 1.4),
          a: u.rand(0.2, 0.85),
          twinkle: u.rand(0.0006, 0.0028)
        });
      }

      stones = [];
      for (var k = 0; k < 9; k += 1) {
        var angle = (TAU * k) / 9 + u.rand(-0.1, 0.1);
        stones.push({
          x: fire.x + Math.cos(angle) * fire.r * 1.8,
          y: groundY + 4 + Math.sin(angle) * fire.r * 0.5,
          rx: u.rand(8, 15),
          ry: u.rand(5, 9),
          tone: u.rand(0.3, 1)
        });
      }

      seedFlames(9);
      seedEmbers();
      hangKettle(width, height);
      addLogs(3, false);
    }

    /**
     * Подбрасывает поленья.
     *
     * @param {number} count сколько добавить
     * @param {boolean} fromAbove падать сверху с разлётом
     */
    function addLogs(count, fromAbove) {
      var scale = u.clamp(env.width / 620, 0.7, 1.5);

      for (var i = 0; i < count; i += 1) {
        var log = M.Bodies.rectangle(
          fire.x + u.rand(-fire.r, fire.r),
          fromAbove ? u.rand(-80, -10) : groundY - 12 - i * 9,
          u.rand(70, 105) * scale, 15 * scale,
          { chamfer: { radius: 5 }, friction: 0.7, restitution: 0.08, density: 0.0022 }
        );
        M.Body.setAngle(log, u.rand(-0.9, 0.9));
        // char — доля обугливания от 0 до 1, fuel — оставшийся запас.
        log.plugin = { char: u.rand(0.05, 0.2), fuel: 1 };
        logs.push(log);
        M.Composite.add(env.world, log);
      }

      while (logs.length > MAX_LOGS) {
        M.Composite.remove(env.world, logs.shift());
      }
      flare = Math.min(1.2, flare + 0.5);
    }

    /**
     * Рождает искру над очагом.
     * @param {number} power множитель начальной скорости
     */
    function emitSpark(power) {
      sparks.push({
        x: fire.x + u.rand(-fire.r * 0.6, fire.r * 0.6),
        y: fire.y + u.rand(-4, 10),
        vx: u.rand(-0.4, 0.4),
        vy: -u.rand(0.9, 2.6) * (power || 1),
        r: u.rand(1.1, 3.4),
        life: 1,
        decay: u.rand(0.0032, 0.0088),
        seed: u.rand(0, TAU)
      });

      if (sparks.length > MAX_SPARKS) { sparks.shift(); }
    }

    /** Выпускает клуб дыма над пламенем. */
    function emitSmoke(power) {
      smoke.push({
        x: fire.x + u.rand(-fire.r * 0.4, fire.r * 0.4),
        y: fire.y - fire.r * 1.6,
        r: u.rand(10, 20),
        vx: u.rand(-0.12, 0.12),
        vy: -u.rand(0.28, 0.62) * (power || 1),
        life: 1,
        decay: u.rand(0.0007, 0.0016)
      });
      if (smoke.length > 60) { smoke.shift(); }
    }

    /**
     * Рисует один язык пламени.
     *
     * Форма строится тремя кривыми Безье от основания к вершине. Смещение
     * вершины складывается из собственного колебания языка и общего ветра,
     * поэтому при движении курсора всё пламя наклоняется согласованно.
     */
    function drawFlame(ctx, flame, now, power, palette) {
      var baseX = fire.x + flame.offset * fire.r * 0.7;
      var baseY = fire.y + fire.r * 0.3;
      var height = fire.r * 2.5 * flame.height * power;
      var halfWidth = fire.r * flame.width * (0.7 + 0.3 * power);

      var wave = Math.sin(now * flame.speed + flame.phase) * flame.sway;
      var tipX = baseX + wave * fire.r * 0.35 + wind * height * 0.5;
      var tipY = baseY - height;

      ctx.beginPath();
      ctx.moveTo(baseX - halfWidth, baseY);
      ctx.bezierCurveTo(
        baseX - halfWidth * 0.9, baseY - height * 0.45,
        tipX - halfWidth * 0.35, tipY + height * 0.3,
        tipX, tipY
      );
      ctx.bezierCurveTo(
        tipX + halfWidth * 0.35, tipY + height * 0.3,
        baseX + halfWidth * 0.9, baseY - height * 0.45,
        baseX + halfWidth, baseY
      );
      ctx.closePath();

      var gradient = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
      gradient.addColorStop(0, palette[0]);
      gradient.addColorStop(0.45, palette[1]);
      gradient.addColorStop(1, palette[2]);
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    return {
      usesPhysics: true,
      hint: 'Нажми вверху — подбросишь полено. Проведи рукой у огня — раздуешь пламя и закрутишь искры.',

      build: build,
      resize: function (w, h) { build(w, h); },

      setLevel: function (next) {
        level = next;
        addLogs(1, true);
      },

      update: function (dt) {
        var frames = u.clamp(dt / 16.7, 0.5, 2);
        var power = intensity();

        flare = Math.max(0, flare - dt / 900);
        breath = Math.max(0, breath - dt / 700);
        wind *= Math.pow(0.94, frames);

        // Расход топлива. Раздувание ускоряет горение: пламя вырастает
        // сразу, но и запас тратится быстрее — это делает раздувание
        // осмысленным выбором, а не бесплатным улучшением.
        var burn = BURN_RATE * dt * (1 + breath * 2.5);
        logs.forEach(function (log) {
          var dx = log.position.x - fire.x;
          var dy = log.position.y - fire.y;
          if (Math.sqrt(dx * dx + dy * dy) < fire.r * HEARTH_FACTOR && log.plugin.fuel > 0) {
            log.plugin.fuel = Math.max(0, log.plugin.fuel - burn);
            log.plugin.char = Math.min(1, log.plugin.char + burn * 1.4);
          }
        });

        // Прогоревшее полено убирается: обугленный обрубок, лежащий вечно,
        // накапливался бы и мешал новым.
        for (var b = logs.length - 1; b >= 0; b -= 1) {
          if (logs[b].plugin.fuel <= 0 && logs[b].plugin.char >= 1) {
            M.Composite.remove(env.world, logs[b]);
            logs.splice(b, 1);
          }
        }

        emitAccumulator += frames * 2.2 * power;
        while (emitAccumulator >= 1) {
          emitAccumulator -= 1;
          emitSpark(1 + breath);
          if (Math.random() < 0.22) { emitSmoke(1 + breath * 0.5); }
        }

        embers.forEach(function (ember) {
          ember.pulse += ember.rate * dt;
        });

        for (var i = sparks.length - 1; i >= 0; i -= 1) {
          var spark = sparks[i];

          // Обратная гравитация: подъёмная сила слабеет по мере остывания.
          spark.vy -= 0.014 * spark.life * frames;
          spark.vx += Math.sin(spark.y * 0.02 + spark.seed) * 0.02 * frames;
          spark.vx += wind * 0.16 * frames;

          if (pointer) {
            var dx = spark.x - pointer.x;
            var dy = spark.y - pointer.y;
            var distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < 150 && distance > 1) {
              // Тангенциальная составляющая закручивает поток в вихрь,
              // радиальная слегка отталкивает — как от движения руки.
              var swirl = (1 - distance / 150) * 0.55 * frames;
              spark.vx += (-dy / distance) * swirl + (dx / distance) * swirl * 0.35;
              spark.vy += (dx / distance) * swirl + (dy / distance) * swirl * 0.35;
            }
          }

          spark.x += spark.vx * frames;
          spark.y += spark.vy * frames;
          spark.vx *= Math.pow(0.985, frames);
          spark.life -= spark.decay * dt;

          if (spark.life <= 0 || spark.y < -40) { sparks.splice(i, 1); }
        }

        for (var s = smoke.length - 1; s >= 0; s -= 1) {
          var puff = smoke[s];
          puff.x += (puff.vx + wind * 0.5) * frames;
          puff.y += puff.vy * frames;
          puff.r += 0.24 * frames;
          puff.life -= puff.decay * dt;
          if (puff.life <= 0) { smoke.splice(s, 1); }
        }

        // Падающие звёзды: редкое событие, за которым приятно застать себя.
        if (Math.random() < 0.0016 * frames) {
          shooting.push({
            x: u.rand(0, env.width * 0.7),
            y: u.rand(0, groundY * 0.4),
            vx: u.rand(2.4, 4.6),
            vy: u.rand(0.9, 1.8),
            life: 1
          });
        }
        for (var t = shooting.length - 1; t >= 0; t -= 1) {
          shooting[t].x += shooting[t].vx * frames;
          shooting[t].y += shooting[t].vy * frames;
          shooting[t].life -= dt / 1100;
          if (shooting[t].life <= 0) { shooting.splice(t, 1); }
        }

        var limit = env.height * 2.5;
        for (var j = logs.length - 1; j >= 0; j -= 1) {
          if (logs[j].position.y > limit) {
            M.Composite.remove(env.world, logs[j]);
            logs.splice(j, 1);
          }
        }
      },

      render: function (ctx, width, height) {
        var now = performance.now();
        var power = intensity();

        var night = ctx.createRadialGradient(
          fire.x, fire.y, 0, fire.x, fire.y, Math.max(width, height) * 0.85
        );
        night.addColorStop(0, '#2a1508');
        night.addColorStop(0.35, '#150c07');
        night.addColorStop(1, '#060505');
        ctx.fillStyle = night;
        ctx.fillRect(0, 0, width, height);

        stars.forEach(function (star) {
          var alpha = star.a * (0.6 + 0.4 * Math.sin(now * star.twinkle + star.x));
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, TAU);
          ctx.fillStyle = 'rgba(226, 232, 250, ' + alpha.toFixed(3) + ')';
          ctx.fill();
        });

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        shooting.forEach(function (star) {
          var tail = ctx.createLinearGradient(
            star.x, star.y, star.x - star.vx * 26, star.y - star.vy * 26
          );
          tail.addColorStop(0, 'rgba(220, 236, 255, ' + star.life.toFixed(2) + ')');
          tail.addColorStop(1, 'rgba(220, 236, 255, 0)');
          ctx.strokeStyle = tail;
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(star.x, star.y);
          ctx.lineTo(star.x - star.vx * 26, star.y - star.vy * 26);
          ctx.stroke();
        });
        ctx.restore();

        draw.ridge(ctx, width, groundY - height * 0.16, height * 0.07, 2.4, '#0b0d0c');
        draw.ridge(ctx, width, groundY - height * 0.08, height * 0.05, 5.2, '#110f0c');

        // Палатка. Освещённость зависит от силы огня, поэтому при угасании
        // лагерь погружается в темноту вместе с пламенем.
        var tentX = width * 0.19;
        var tentW = Math.min(width, height) * 0.17;
        var tentH = Math.min(width, height) * 0.13;
        var litness = u.clamp(power / 2.4, 0.15, 1);
        ctx.beginPath();
        ctx.moveTo(tentX - tentW, groundY);
        ctx.lineTo(tentX, groundY - tentH);
        ctx.lineTo(tentX + tentW, groundY);
        ctx.closePath();
        var canvasTone = ctx.createLinearGradient(
          tentX - tentW, groundY - tentH, tentX + tentW, groundY
        );
        canvasTone.addColorStop(0, 'rgb(' + Math.round(28 + litness * 40) + ', ' +
          Math.round(20 + litness * 24) + ', 14)');
        canvasTone.addColorStop(1, '#150e09');
        ctx.fillStyle = canvasTone;
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(tentX, groundY - tentH);
        ctx.lineTo(tentX, groundY);
        ctx.strokeStyle = 'rgba(255, 170, 90, ' + (0.12 + litness * 0.2).toFixed(2) + ')';
        ctx.lineWidth = 2;
        ctx.stroke();

        draw.glow(ctx, fire.x, fire.y, fire.r * 11,
          'rgba(255, 150, 50, ALPHA)', 0.04 + power * 0.05);

        var soil = ctx.createLinearGradient(0, groundY, 0, height);
        soil.addColorStop(0, 'rgb(' + Math.round(24 + litness * 30) + ', ' +
          Math.round(18 + litness * 16) + ', 12)');
        soil.addColorStop(1, '#100b07');
        ctx.fillStyle = soil;
        ctx.fillRect(0, groundY, width, height - groundY);

        stones.forEach(function (stone) {
          ctx.beginPath();
          ctx.ellipse(stone.x, stone.y, stone.rx, stone.ry, 0, 0, TAU);
          var tone = Math.round((45 + stone.tone * 45) * (0.5 + litness * 0.7));
          ctx.fillStyle = 'rgb(' + tone + ', ' + Math.round(tone * 0.88) + ', ' +
            Math.round(tone * 0.78) + ')';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 170, 90, ' + (0.08 + litness * 0.14).toFixed(2) + ')';
          ctx.lineWidth = 1;
          ctx.stroke();
        });

        // Тренога и котелок за пламенем.
        if (kettle) {
          var scale = kettle.scale;
          ctx.strokeStyle = 'rgba(90, 70, 52, 0.9)';
          ctx.lineWidth = 3 * scale;
          ctx.lineCap = 'round';
          [-1, 1].forEach(function (side) {
            ctx.beginPath();
            ctx.moveTo(kettle.anchor.x + side * fire.r * 1.7, groundY + 2);
            ctx.lineTo(kettle.anchor.x + side * 3, kettle.anchor.y);
            ctx.stroke();
          });

          ctx.beginPath();
          ctx.moveTo(kettle.anchor.x, kettle.anchor.y);
          ctx.lineTo(kettle.body.position.x, kettle.body.position.y - 13 * scale);
          ctx.strokeStyle = 'rgba(70, 60, 50, 0.9)';
          ctx.lineWidth = 1.6;
          ctx.stroke();

          draw.bodyFill(ctx, kettle.body, '#4a4a52', '#1c1c22',
            'rgba(255, 180, 100, ' + (0.2 + litness * 0.35).toFixed(2) + ')');
        }

        // Поленья. Обугливание видно по цвету: свежее дерево светлое,
        // прогоревшее почти чёрное с тлеющей кромкой.
        logs.forEach(function (log) {
          draw.contactShadow(ctx, log.position.x, groundY + 3, 40, 10, 0.4);
          var char = log.plugin.char;
          var glowing = log.plugin.fuel > 0 && log.plugin.fuel < 0.6;

          draw.bodyFill(
            ctx, log,
            'rgb(' + Math.round(120 - char * 80) + ', ' +
              Math.round(78 - char * 54) + ', ' + Math.round(44 - char * 30) + ')',
            '#150d07',
            glowing
              ? 'rgba(255, 140, 50, ' + (0.35 + Math.sin(now * 0.004) * 0.15).toFixed(2) + ')'
              : 'rgba(255, 170, 90, 0.18)'
          );
        });

        // Угли под пламенем.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        embers.forEach(function (ember) {
          var heat = ember.heat * (0.55 + 0.45 * Math.sin(ember.pulse)) * u.clamp(power / 1.6, 0.2, 1.4);
          var gradient = ctx.createRadialGradient(
            ember.x, ember.y, 0, ember.x, ember.y, ember.r * 3
          );
          gradient.addColorStop(0, 'rgba(255, 140, 40, ' + (heat * 0.75).toFixed(3) + ')');
          gradient.addColorStop(1, 'rgba(180, 40, 10, 0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(ember.x, ember.y, ember.r * 3, 0, TAU);
          ctx.fill();
        });

        // Пламя тремя слоями: внешний тёмно-оранжевый, средний золотой и
        // белое ядро. Один слой давал бы плоское пятно без глубины.
        var scaleP = u.clamp(power / 1.6, 0.35, 1.6);
        flames.forEach(function (flame) {
          drawFlame(ctx, flame, now, scaleP, [
            'rgba(255, 90, 20, 0.5)',
            'rgba(255, 150, 40, 0.34)',
            'rgba(255, 210, 120, 0)'
          ]);
        });
        flames.forEach(function (flame, index) {
          if (index % 2) { return; }
          drawFlame(ctx, flame, now + 400, scaleP * 0.62, [
            'rgba(255, 220, 120, 0.6)',
            'rgba(255, 240, 190, 0.4)',
            'rgba(255, 255, 230, 0)'
          ]);
        });

        var core = ctx.createRadialGradient(
          fire.x, fire.y, 0, fire.x, fire.y, fire.r * scaleP
        );
        core.addColorStop(0, 'rgba(255, 252, 226, ' + (0.5 + scaleP * 0.3).toFixed(2) + ')');
        core.addColorStop(0.5, 'rgba(255, 180, 60, 0.42)');
        core.addColorStop(1, 'rgba(180, 60, 10, 0)');
        ctx.beginPath();
        ctx.ellipse(fire.x, fire.y, fire.r * 0.85 * scaleP, fire.r * 1.15 * scaleP, 0, 0, TAU);
        ctx.fillStyle = core;
        ctx.fill();

        sparks.forEach(function (spark) {
          var alpha = u.clamp(spark.life, 0, 1);
          var color = u.mix([255, 240, 190], [220, 70, 20], 1 - alpha);
          var gradient = ctx.createRadialGradient(
            spark.x, spark.y, 0, spark.x, spark.y, spark.r * 4
          );
          gradient.addColorStop(0, u.rgba(color, alpha * 0.95));
          gradient.addColorStop(1, u.rgba(color, 0));
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(spark.x, spark.y, spark.r * 4, 0, TAU);
          ctx.fill();
        });
        ctx.restore();

        // Дым рисуется обычным наложением: в режиме сложения он бы светился,
        // тогда как дым должен заслонять звёзды, а не подсвечивать их.
        smoke.forEach(function (puff) {
          var gradient = ctx.createRadialGradient(
            puff.x, puff.y, 0, puff.x, puff.y, puff.r
          );
          gradient.addColorStop(0, 'rgba(70, 62, 58, ' + (puff.life * 0.3).toFixed(3) + ')');
          gradient.addColorStop(1, 'rgba(60, 54, 50, 0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(puff.x, puff.y, puff.r, 0, TAU);
          ctx.fill();
        });

        // Указатель силы огня: без него угасание костра остаётся незамеченным,
        // пока сцена не потемнеет полностью.
        var barWidth = Math.min(width * 0.22, 150);
        var barX = width - barWidth - 16;
        var barY = 16;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        draw.roundRect(ctx, barX, barY, barWidth, 6, 3);
        ctx.fill();
        var fill = u.clamp(fuel() / 3, 0.02, 1);
        var heatBar = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
        heatBar.addColorStop(0, '#ff6a1a');
        heatBar.addColorStop(1, '#ffd77a');
        ctx.fillStyle = heatBar;
        draw.roundRect(ctx, barX, barY, Math.max(4, barWidth * fill), 6, 3);
        ctx.fill();

        ctx.font = '600 9px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255, 210, 150, 0.6)';
        ctx.fillText('ТОПЛИВО', barX + barWidth, barY - 4);

        draw.vignette(ctx, width, height, 0.58);
      },

      draggables: function () {
        // Котелок тоже можно поймать и раскачать.
        return kettle ? logs.concat([kettle.body]) : logs;
      },

      pointerDown: function (x, y) {
        pointer = { x: x, y: y };
        lastPointer = { x: x, y: y };

        // Верхняя треть — бросок полена, у самого огня — раздувание.
        if (y < groundY - env.height * 0.32) {
          addLogs(1, true);
        } else {
          var dx = x - fire.x;
          var dy = y - fire.y;
          if (Math.sqrt(dx * dx + dy * dy) < fire.r * 3.4) {
            breath = 1;
            for (var i = 0; i < 14; i += 1) { emitSpark(1.8); }
          }
        }
      },

      pointerMove: function (x, y) {
        if (lastPointer) {
          // Ветер задаётся горизонтальной составляющей движения руки:
          // пламя и дым отклоняются в ту же сторону.
          wind = u.clamp(wind + (x - lastPointer.x) * 0.006, -1.2, 1.2);
        }
        pointer = { x: x, y: y };
        lastPointer = { x: x, y: y };
      },

      pointerUp: function () {
        pointer = null;
        lastPointer = null;
      },

      celebrate: function (count) {
        addLogs(u.clamp(Math.round(count / 2), 1, 3), true);
        flare = 1.2;
        for (var i = 0; i < u.clamp(count * 9, 9, 70); i += 1) { emitSpark(1.6); }
        for (var s = 0; s < 6; s += 1) { emitSmoke(1.4); }
      },

      destroy: function () {
        logs = []; sparks = []; scenery = []; embers = []; flames = [];
        smoke = []; stars = []; stones = []; shooting = [];
        kettle = null; pointer = null; lastPointer = null;
        wind = 0; breath = 0; flare = 0;
      }
    };
  });
}(window));
