/**
 * MyQuestify — интерактивные сцены.
 *
 * Каждая сцена — фабрика, получающая окружение от ядра (`stage.js`) и
 * возвращающая объект с жизненным циклом: build → update/render → destroy.
 * Ядро отвечает за холст, кадры и перетаскивание; сцена — только за свою
 * геометрию и вид.
 *
 * Контракт сцены:
 *   usesPhysics  — нужен ли движок Matter (false у «Космоса»)
 *   hint         — подсказка под холстом
 *   build(w, h)  — построить содержимое
 *   resize(w, h) — пересобрать под новый размер
 *   setLevel(n)  — отреагировать на рост уровня
 *   update(dt)   — своя логика кадра (физику считает ядро)
 *   render(ctx)  — нарисовать кадр
 *   draggables() — тела, которые разрешено таскать мышью
 *   pointerDown/Move/Up — ввод, если тело под курсором не найдено
 *   celebrate(n) — отклик на завершённый квест
 */
(function (global) {
  'use strict';

  if (!global.Stage) { return; }

  var TAU = Math.PI * 2;

  // ======================================================================= //
  // САД ВДОХНОВЕНИЯ                                                         //
  // ======================================================================= //

  global.Stage.register('garden', function (env) {
    var M = env.M;
    var draw = env.draw;
    var u = env.util;

    var MAX_FRUIT = 64;

    var FRUIT_PALETTE = [
      { light: '#ffd166', dark: '#e07b1f', rim: 'rgba(255,220,150,0.5)' },
      { light: '#ff8f6b', dark: '#c0341a', rim: 'rgba(255,180,150,0.45)' },
      { light: '#7ef0c0', dark: '#0d8f63', rim: 'rgba(160,255,220,0.4)' }
    ];

    var CANOPY_TONES = [
      ['#2f9c6a', '#0f4d35'],
      ['#3bb37c', '#12583c'],
      ['#27855a', '#0c4230']
    ];

    var scenery = [];
    var fruits = [];
    var blobs = [];
    var motes = [];        // светлячки
    var grass = [];        // травинки у земли
    var stars = [];
    var trunk = null;
    var branches = [];
    var canopy = { x: 0, y: 0, r: 0 };
    var groundY = 0;
    var level = env.level;

    /**
     * Собирает дерево, землю и стены под текущий размер сцены.
     *
     * Крона строится и как набор статичных тел (чтобы плоды по ней скатывались),
     * и как список кругов для рисования — форма одна, но физике нужны тела,
     * а глазу градиенты.
     */
    function build(width, height) {
      M.Composite.remove(env.world, scenery);
      scenery = [];
      blobs = [];
      branches = [];

      var growth = 0.62 + u.clamp(level, 1, 10) * 0.038;
      var groundHeight = Math.max(20, height * 0.06);
      groundY = height - groundHeight;
      var centerX = width / 2;

      scenery.push(M.Bodies.rectangle(
        centerX, height - groundHeight / 2, width * 2, groundHeight,
        { isStatic: true, friction: 0.7, restitution: 0.05 }
      ));
      scenery.push(M.Bodies.rectangle(-60, height / 2, 120, height * 3, { isStatic: true }));
      scenery.push(M.Bodies.rectangle(width + 60, height / 2, 120, height * 3, { isStatic: true }));

      var trunkWidth = Math.max(16, width * 0.038);
      var trunkHeight = height * 0.34 * growth;
      var trunkTop = groundY - trunkHeight;

      trunk = {
        x: centerX,
        top: trunkTop,
        bottom: groundY,
        width: trunkWidth
      };
      scenery.push(M.Bodies.rectangle(
        centerX, groundY - trunkHeight / 2, trunkWidth, trunkHeight,
        { isStatic: true }
      ));

      var branchLength = trunkHeight * 0.5;
      var branchY = trunkTop + trunkHeight * 0.3;
      [-1, 1].forEach(function (side) {
        branches.push({
          x1: centerX,
          y1: branchY + trunkHeight * 0.12,
          x2: centerX + side * branchLength * 0.62,
          y2: branchY - trunkHeight * 0.16,
          width: trunkWidth * 0.45
        });
      });

      var canopyRadius = Math.min(width, height) * 0.15 * growth;
      var canopyY = trunkTop - canopyRadius * 0.3;
      var blobCount = 4 + Math.round(u.clamp(level, 1, 10) / 2);

      blobs.push({ x: centerX, y: canopyY, r: canopyRadius, tone: CANOPY_TONES[0] });
      for (var i = 0; i < blobCount; i += 1) {
        var angle = (TAU * i) / blobCount - Math.PI / 2;
        var spread = canopyRadius * 0.82;
        blobs.push({
          x: centerX + Math.cos(angle) * spread,
          y: canopyY + Math.sin(angle) * spread * 0.6,
          r: canopyRadius * u.rand(0.58, 0.8),
          tone: CANOPY_TONES[i % CANOPY_TONES.length]
        });
      }

      blobs.forEach(function (blob) {
        scenery.push(M.Bodies.circle(blob.x, blob.y, blob.r * 0.92, { isStatic: true }));
      });

      // Зона сбора шире визуальной кроны: попадать должно быть легко.
      canopy = { x: centerX, y: canopyY, r: canopyRadius * 1.9 };

      motes = env.draw.seedMotes(26, width, groundY, { rise: true, speed: 0.7 });

      grass = [];
      for (var g = 0; g < Math.round(width / 9); g += 1) {
        grass.push({
          x: u.rand(0, width),
          h: u.rand(6, 20),
          lean: u.rand(-0.4, 0.4),
          phase: u.rand(0, TAU),
          tone: u.rand(0.35, 1)
        });
      }

      stars = [];
      for (var s = 0; s < Math.round(width / 14); s += 1) {
        stars.push({
          x: u.rand(0, width),
          y: u.rand(0, trunkTop * 0.8),
          r: u.rand(0.4, 1.3),
          a: u.rand(0.15, 0.7),
          twinkle: u.rand(0.0006, 0.0026)
        });
      }

      M.Composite.add(env.world, scenery);
    }

    /**
     * Роняет плоды из кроны.
     * @param {number} count количество
     * @param {boolean} burst разлёт в стороны вместо мягкого падения
     */
    function dropFruit(count, burst) {
      var total = u.clamp(count || 1, 1, 12);
      var radius = u.clamp(env.width * 0.019, 8, 17);

      for (var i = 0; i < total; i += 1) {
        var fruit = M.Bodies.circle(
          canopy.x + u.rand(-canopy.r * 0.42, canopy.r * 0.42),
          canopy.y + u.rand(-canopy.r * 0.18, canopy.r * 0.22),
          radius * u.rand(0.82, 1.18),
          {
            restitution: 0.42,
            friction: 0.08,
            frictionAir: 0.006,
            density: 0.0013
          }
        );
        fruit.plugin = {
          palette: u.pick(FRUIT_PALETTE),
          leaf: Math.random() < 0.45
        };

        M.Body.setVelocity(fruit, {
          x: burst ? u.rand(-5.5, 5.5) : u.rand(-1.4, 1.4),
          y: burst ? u.rand(-7.5, -3) : u.rand(0, 1)
        });
        M.Body.setAngularVelocity(fruit, u.rand(-0.3, 0.3));

        fruits.push(fruit);
        M.Composite.add(env.world, fruit);
      }

      while (fruits.length > MAX_FRUIT) {
        M.Composite.remove(env.world, fruits.shift());
      }
    }

    return {
      usesPhysics: true,
      hint: 'Нажми на крону — посыплются плоды. Их можно ловить и бросать.',

      build: build,

      resize: function (width, height) {
        build(width, height);
      },

      setLevel: function (next) {
        level = next;
        build(env.width, env.height);
      },

      update: function () {
        var limit = env.height * 3;
        for (var i = fruits.length - 1; i >= 0; i -= 1) {
          if (fruits[i].position.y > limit) {
            M.Composite.remove(env.world, fruits[i]);
            fruits.splice(i, 1);
          }
        }
      },

      render: function (ctx, width, height, dt) {
        var now = performance.now();

        // Небо: ночь у зенита переходит в предрассветную зелень у горизонта.
        var sky = ctx.createLinearGradient(0, 0, 0, height);
        sky.addColorStop(0, '#081020');
        sky.addColorStop(0.42, '#0c1a24');
        sky.addColorStop(0.7, '#0e2019');
        sky.addColorStop(1, '#0a1210');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, width, height);

        stars.forEach(function (star) {
          var alpha = star.a * (0.6 + 0.4 * Math.sin(now * star.twinkle + star.x));
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, TAU);
          ctx.fillStyle = 'rgba(214, 234, 255, ' + alpha.toFixed(3) + ')';
          ctx.fill();
        });

        // Луна: единственный источник холодного света, объясняет синие блики.
        var moonX = width * 0.82;
        var moonY = height * 0.16;
        draw.glow(ctx, moonX, moonY, Math.min(width, height) * 0.3,
          'rgba(190, 220, 255, ALPHA)', 0.14);
        draw.sphere(ctx, moonX, moonY, Math.min(width, height) * 0.035,
          '#f2f6ff', '#8ea4c4');

        // Три слоя холмов: разная светлота даёт глубину без перспективы.
        draw.ridge(ctx, width, groundY - height * 0.14, height * 0.05, 1.4, '#0b1f1c');
        draw.ridge(ctx, width, groundY - height * 0.07, height * 0.04, 3.1, '#0d2622');
        draw.ridge(ctx, width, groundY - height * 0.02, height * 0.03, 5.7, '#102e26');

        // Тёплый свет над кроной — источник, объясняющий все блики ниже.
        draw.glow(ctx, canopy.x, canopy.y - canopy.r * 0.4,
          canopy.r * 2.1, 'rgba(120,255,200,ALPHA)', 0.09);

        // Земля.
        var soil = ctx.createLinearGradient(0, groundY, 0, height);
        soil.addColorStop(0, '#1f3b2c');
        soil.addColorStop(1, '#0e1c15');
        ctx.fillStyle = soil;
        ctx.fillRect(0, groundY, width, height - groundY);

        ctx.strokeStyle = 'rgba(120, 220, 170, 0.18)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, groundY + 0.5);
        ctx.lineTo(width, groundY + 0.5);
        ctx.stroke();

        // Трава качается: статичная бахрома выглядит нарисованной наклейкой.
        ctx.lineCap = 'round';
        grass.forEach(function (blade) {
          var sway = Math.sin(now * 0.0009 + blade.phase) * 3.2;
          ctx.beginPath();
          ctx.moveTo(blade.x, groundY + 2);
          ctx.quadraticCurveTo(
            blade.x + blade.lean * 6 + sway * 0.5, groundY - blade.h * 0.6,
            blade.x + blade.lean * 12 + sway, groundY - blade.h
          );
          ctx.strokeStyle = 'rgba(' + Math.round(60 + blade.tone * 60) + ', ' +
            Math.round(130 + blade.tone * 70) + ', 100, ' + (0.3 + blade.tone * 0.35).toFixed(2) + ')';
          ctx.lineWidth = 1.4;
          ctx.stroke();
        });

        // Ветви.
        ctx.lineCap = 'round';
        branches.forEach(function (branch) {
          ctx.beginPath();
          ctx.moveTo(branch.x1, branch.y1);
          ctx.quadraticCurveTo(
            (branch.x1 + branch.x2) / 2, branch.y1 - branch.width,
            branch.x2, branch.y2
          );
          ctx.strokeStyle = '#4a3527';
          ctx.lineWidth = branch.width;
          ctx.stroke();
        });

        // Ствол с боковым освещением и фактурой коры.
        if (trunk) {
          var bark = ctx.createLinearGradient(
            trunk.x - trunk.width / 2, 0, trunk.x + trunk.width / 2, 0
          );
          bark.addColorStop(0, '#2a1d15');
          bark.addColorStop(0.35, '#5b4130');
          bark.addColorStop(1, '#231810');
          ctx.fillStyle = bark;
          ctx.fillRect(trunk.x - trunk.width / 2, trunk.top, trunk.width, trunk.bottom - trunk.top);

          ctx.strokeStyle = 'rgba(0,0,0,0.28)';
          ctx.lineWidth = 1;
          for (var s = 1; s < 4; s += 1) {
            var lineX = trunk.x - trunk.width / 2 + (trunk.width * s) / 4;
            ctx.beginPath();
            ctx.moveTo(lineX, trunk.top + 4);
            ctx.lineTo(lineX + u.rand(-1, 1), trunk.bottom);
            ctx.stroke();
          }
        }

        // Крона: сначала тёмные объёмы, поверх — освещённые.
        blobs.forEach(function (blob) {
          draw.sphere(ctx, blob.x, blob.y, blob.r, blob.tone[0], blob.tone[1],
            'rgba(150, 255, 205, 0.22)');
        });

        // Плоды: контактная тень, затем шар.
        fruits.forEach(function (fruit) {
          var radius = fruit.circleRadius;
          var distanceToGround = Math.max(0, groundY - fruit.position.y);
          var shadowAlpha = u.clamp(0.34 - distanceToGround / (env.height * 1.4), 0.04, 0.34);
          draw.contactShadow(ctx, fruit.position.x, groundY + 2,
            radius * 1.5, radius * 0.45, shadowAlpha);

          var palette = fruit.plugin.palette;
          draw.sphere(ctx, fruit.position.x, fruit.position.y, radius,
            palette.light, palette.dark, palette.rim);

          if (fruit.plugin.leaf) {
            ctx.save();
            ctx.translate(fruit.position.x, fruit.position.y);
            ctx.rotate(fruit.angle);
            ctx.beginPath();
            ctx.ellipse(radius * 0.25, -radius * 0.85, radius * 0.42, radius * 0.18,
              -0.7, 0, TAU);
            ctx.fillStyle = '#3ea172';
            ctx.fill();
            ctx.restore();
          }
        });

        // Светлячки поверх всего: они между зрителем и садом.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        draw.motes(ctx, motes, width, groundY, dt || 16, 'rgba(180, 255, 190, ALPHA)');
        ctx.restore();

        draw.vignette(ctx, width, height, 0.42);
      },

      draggables: function () {
        return fruits;
      },

      pointerDown: function (x, y) {
        var dx = x - canopy.x;
        var dy = y - canopy.y;
        if (Math.sqrt(dx * dx + dy * dy) <= canopy.r) {
          dropFruit(Math.round(u.rand(1, 3)), false);
        }
      },

      celebrate: function (count) {
        dropFruit(u.clamp(count, 1, 6), true);
      },

      destroy: function () {
        fruits = [];
        scenery = [];
      }
    };
  });

  // ======================================================================= //
  // ВУЛКАН ВДОХНОВЕНИЯ                                                      //
  // ======================================================================= //

  global.Stage.register('volcano', function (env) {
    var M = env.M;
    var draw = env.draw;
    var u = env.util;

    var MAX_LAVA = 220;
    var HOLD_DELAY_MS = 180;      // порог, после которого нажатие считается долгим
    var LAVA_LIFETIME_MS = 14000;

    // Остывание: белое каление → золото → раскалённый оранжевый → тёмная корка.
    var COOLING = [
      [255, 248, 214],
      [255, 196, 76],
      [236, 94, 30],
      [96, 26, 16],
      [42, 20, 20]
    ];

    var scenery = [];
    var lava = [];
    var smoke = [];
    var ash = [];
    var mountain = { left: 0, right: 0, peakLeft: 0, peakRight: 0, base: 0, peak: 0 };
    var crater = { x: 0, y: 0, r: 0 };
    var emitting = false;
    var holdStart = 0;
    var emitAccumulator = 0;
    var level = env.level;
    var shake = 0;

    function build(width, height) {
      M.Composite.remove(env.world, scenery);
      scenery = [];
      lava.forEach(function (drop) { M.Composite.remove(env.world, drop); });
      lava = [];

      var growth = 0.72 + u.clamp(level, 1, 10) * 0.028;
      var baseY = height * 0.93;
      var peakY = height * (0.42 - 0.12 * growth);
      var halfBase = width * 0.36 * growth;
      var halfPeak = width * 0.085;
      var centerX = width / 2;

      mountain = {
        base: baseY,
        peak: peakY,
        left: centerX - halfBase,
        right: centerX + halfBase,
        peakLeft: centerX - halfPeak,
        peakRight: centerX + halfPeak
      };
      crater = { x: centerX, y: peakY, r: halfPeak };

      scenery.push(M.Bodies.rectangle(
        centerX, height - (height - baseY) / 2 + 4, width * 2, (height - baseY) + 8,
        { isStatic: true, friction: 0.9 }
      ));
      scenery.push(M.Bodies.rectangle(-60, height / 2, 120, height * 3, { isStatic: true }));
      scenery.push(M.Bodies.rectangle(width + 60, height / 2, 120, height * 3, { isStatic: true }));

      // Склоны — повёрнутые прямоугольники: лава стекает по ним, а не проваливается.
      [[-1, mountain.left, mountain.peakLeft], [1, mountain.right, mountain.peakRight]]
        .forEach(function (side) {
          var x1 = side[1];
          var x2 = side[2];
          var dx = x2 - x1;
          var dy = peakY - baseY;
          var length = Math.sqrt(dx * dx + dy * dy);
          var slope = M.Bodies.rectangle(
            (x1 + x2) / 2, (baseY + peakY) / 2, length, 26,
            { isStatic: true, friction: 0.35, restitution: 0.02 }
          );
          M.Body.setAngle(slope, Math.atan2(dy, dx));
          scenery.push(slope);
        });

      M.Composite.add(env.world, scenery);
      ash = env.draw.seedMotes(34, width, height, { rise: true, speed: 0.5 });
      smoke = [];
    }

    /** Клуб дыма над жерлом: поднимается, расширяется и тает. */
    function puff() {
      smoke.push({
        x: crater.x + u.rand(-crater.r * 0.4, crater.r * 0.4),
        y: crater.y - 4,
        r: u.rand(10, 22),
        vy: -u.rand(0.25, 0.6),
        vx: u.rand(-0.12, 0.12),
        life: 1
      });
      if (smoke.length > 40) { smoke.shift(); }
    }

    /**
     * Выбрасывает каплю лавы из кратера.
     * @param {number} power множитель скорости 0…1
     */
    function erupt(power) {
      var radius = u.clamp(env.width * 0.011, 4.5, 10);
      var drop = M.Bodies.circle(
        crater.x + u.rand(-crater.r * 0.55, crater.r * 0.55),
        crater.y + u.rand(-4, 8),
        radius * u.rand(0.7, 1.25),
        {
          restitution: 0.05,
          friction: 0.5,
          frictionAir: 0.014,
          density: 0.0022
        }
      );
      drop.plugin = { born: performance.now(), seed: Math.random() };

      M.Body.setVelocity(drop, {
        x: u.rand(-2.6, 2.6) * (0.5 + power),
        y: -u.rand(4, 11) * (0.45 + power)
      });

      lava.push(drop);
      M.Composite.add(env.world, drop);

      while (lava.length > MAX_LAVA) {
        M.Composite.remove(env.world, lava.shift());
      }
    }

    /**
     * Цвет капли по возрасту.
     * @param {number} age миллисекунды с рождения
     * @returns {number[]} RGB
     */
    function lavaColor(age) {
      var t = u.clamp(age / LAVA_LIFETIME_MS, 0, 1) * (COOLING.length - 1);
      var index = Math.min(COOLING.length - 2, Math.floor(t));
      return u.mix(COOLING[index], COOLING[index + 1], t - index);
    }

    return {
      usesPhysics: true,
      hint: 'Нажми на кратер и удерживай — пойдёт поток лавы. Капли остывают на склоне.',

      build: build,

      resize: function (width, height) {
        build(width, height);
      },

      setLevel: function (next) {
        level = next;
        build(env.width, env.height);
      },

      update: function (dt, now) {
        if (emitting && now - holdStart > HOLD_DELAY_MS) {
          // Поток нарастает первые полторы секунды: мгновенный фонтан
          // выглядит как глюк, разгон — как давление в жерле.
          var ramp = u.clamp((now - holdStart - HOLD_DELAY_MS) / 1500, 0, 1);
          var rate = (0.9 + ramp * 2.4) * (0.7 + u.clamp(level, 1, 10) * 0.06);
          emitAccumulator += (dt / 16.7) * rate;
          shake = Math.min(3.2, shake + ramp * 0.35);

          while (emitAccumulator >= 1) {
            emitAccumulator -= 1;
            erupt(ramp);
            if (Math.random() < 0.4) { puff(); }
          }
        } else {
          emitAccumulator = 0;
        }

        shake *= 0.92;

        // Дым идёт и в покое: вулкан дремлет, а не выключен.
        if (Math.random() < 0.035) { puff(); }

        for (var s = smoke.length - 1; s >= 0; s -= 1) {
          var puffing = smoke[s];
          puffing.y += puffing.vy * (dt / 16.7);
          puffing.x += puffing.vx * (dt / 16.7);
          puffing.r += 0.22 * (dt / 16.7);
          puffing.life -= dt / 5200;
          if (puffing.life <= 0) { smoke.splice(s, 1); }
        }

        var limit = env.height * 2.5;
        for (var i = lava.length - 1; i >= 0; i -= 1) {
          var drop = lava[i];
          if (drop.position.y > limit || now - drop.plugin.born > LAVA_LIFETIME_MS * 1.6) {
            M.Composite.remove(env.world, drop);
            lava.splice(i, 1);
          }
        }
      },

      render: function (ctx, width, height, dt) {
        var now = performance.now();

        var sky = ctx.createLinearGradient(0, 0, 0, height);
        sky.addColorStop(0, '#0d0713');
        sky.addColorStop(0.34, '#1c0a12');
        sky.addColorStop(0.62, '#2a0f0d');
        sky.addColorStop(1, '#0b0708');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, width, height);

        // Дальние хребты: вулкан стоит в гряде, а не в пустоте.
        draw.ridge(ctx, width, mountain.base - height * 0.06, height * 0.055, 2.2, '#170d10');
        draw.ridge(ctx, width, mountain.base - height * 0.02, height * 0.04, 4.8, '#1e1113');

        // Дым позади конуса: клубы уходят за гору, а не поверх неё.
        ctx.save();
        smoke.forEach(function (puffing) {
          var gradient = ctx.createRadialGradient(
            puffing.x, puffing.y, 0, puffing.x, puffing.y, puffing.r
          );
          gradient.addColorStop(0, 'rgba(86, 66, 62, ' + (puffing.life * 0.34).toFixed(3) + ')');
          gradient.addColorStop(1, 'rgba(60, 44, 44, 0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(puffing.x, puffing.y, puffing.r, 0, TAU);
          ctx.fill();
        });
        ctx.restore();

        // Зарево над кратером: тем ярче, чем сильнее идёт поток.
        draw.glow(ctx, crater.x, crater.y, Math.max(width, height) * 0.55,
          'rgba(255,120,40,ALPHA)', 0.05 + Math.min(0.16, lava.length / 900));

        ctx.save();
        if (shake > 0.05) {
          ctx.translate(u.rand(-shake, shake), u.rand(-shake, shake));
        }

        // Конус вулкана.
        var rock = ctx.createLinearGradient(0, mountain.peak, 0, mountain.base);
        rock.addColorStop(0, '#4a2d28');
        rock.addColorStop(0.4, '#2e1c1a');
        rock.addColorStop(1, '#170e0e');

        ctx.beginPath();
        ctx.moveTo(mountain.left, mountain.base);
        ctx.lineTo(mountain.peakLeft, mountain.peak);
        ctx.lineTo(mountain.peakRight, mountain.peak);
        ctx.lineTo(mountain.right, mountain.base);
        ctx.closePath();
        ctx.fillStyle = rock;
        ctx.fill();

        // Освещённый правый склон — источник света в кратере.
        ctx.save();
        ctx.clip();
        var lit = ctx.createLinearGradient(crater.x, mountain.peak, mountain.right, mountain.base);
        lit.addColorStop(0, 'rgba(255,140,60,0.22)');
        lit.addColorStop(1, 'rgba(255,140,60,0)');
        ctx.fillStyle = lit;
        ctx.fillRect(mountain.left, mountain.peak, mountain.right - mountain.left,
          mountain.base - mountain.peak);
        ctx.restore();

        // Жерло.
        ctx.beginPath();
        ctx.ellipse(crater.x, crater.y, crater.r, crater.r * 0.34, 0, 0, TAU);
        var throat = ctx.createRadialGradient(
          crater.x, crater.y, 1, crater.x, crater.y, crater.r
        );
        throat.addColorStop(0, '#ffd98a');
        throat.addColorStop(0.5, '#f0691f');
        throat.addColorStop(1, '#2a1010');
        ctx.fillStyle = throat;
        ctx.fill();

        // Капли: свечение раздельным проходом, чтобы яркости складывались.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        lava.forEach(function (drop) {
          var age = now - drop.plugin.born;
          if (age > LAVA_LIFETIME_MS * 0.55) { return; }
          var heat = 1 - age / (LAVA_LIFETIME_MS * 0.55);
          var color = lavaColor(age);
          var g = ctx.createRadialGradient(
            drop.position.x, drop.position.y, 0,
            drop.position.x, drop.position.y, drop.circleRadius * 4.5
          );
          g.addColorStop(0, u.rgba(color, 0.30 * heat));
          g.addColorStop(1, u.rgba(color, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(drop.position.x, drop.position.y, drop.circleRadius * 4.5, 0, TAU);
          ctx.fill();
        });
        ctx.restore();

        lava.forEach(function (drop) {
          var color = lavaColor(now - drop.plugin.born);
          var bright = u.mix(color, [255, 255, 235], 0.45);
          draw.sphere(ctx, drop.position.x, drop.position.y, drop.circleRadius,
            u.rgba(bright, 1), u.rgba(color, 1));
        });

        ctx.restore();

        // Пепел висит в воздухе перед сценой.
        draw.motes(ctx, ash, width, height, dt || 16, 'rgba(255, 190, 150, ALPHA)');
        draw.vignette(ctx, width, height, 0.5);
      },

      draggables: function () {
        // Лаву не таскают: она должна течь, а не летать за курсором.
        return [];
      },

      pointerDown: function (x, y) {
        var dx = x - crater.x;
        var dy = (y - crater.y) / 0.6;
        if (Math.sqrt(dx * dx + dy * dy) <= crater.r * 2.2) {
          emitting = true;
          holdStart = performance.now();
          erupt(0.2);
        }
      },

      pointerUp: function () {
        emitting = false;
      },

      celebrate: function (count) {
        for (var i = 0; i < u.clamp(count * 4, 4, 26); i += 1) {
          erupt(1);
        }
        shake = 3.2;
      },

      destroy: function () {
        emitting = false;
        lava = [];
        scenery = [];
        smoke = [];
        ash = [];
      }
    };
  });

  // ======================================================================= //
  // КОСМОС ВДОХНОВЕНИЯ                                                      //
  // ======================================================================= //

  global.Stage.register('cosmos', function (env) {
    var draw = env.draw;
    var u = env.util;

    /** Сжатие орбиты по вертикали: круг в перспективе читается как эллипс. */
    var TILT = 0.42;
    var RETURN_MS = 620;

    /**
     * Солнечная система: восемь планет в реальном порядке от Солнца.
     *
     * Радиусы не в масштабе — Юпитер в 28 раз шире Меркурия, и при честной
     * пропорции внутренние планеты стали бы точками. Взят сжатый ряд,
     * сохраняющий узнаваемый порядок «мелкие каменные — газовые гиганты —
     * ледяные».
     */
    var SOLAR = [
      { name: 'Меркурий', light: '#c9c2b8', dark: '#5a5049', size: 0.42,
        texture: 'craters', ring: null, moons: 0, tilt: 0.02 },
      { name: 'Венера', light: '#f5d9a0', dark: '#a8763a', size: 0.62,
        texture: 'clouds', ring: null, moons: 0, tilt: 0.05 },
      { name: 'Земля', light: '#7ec4f0', dark: '#12467a', size: 0.66,
        texture: 'earth', ring: null, moons: 1, tilt: 0.41 },
      { name: 'Марс', light: '#e8865a', dark: '#8a3315', size: 0.52,
        texture: 'craters', ring: null, moons: 2, tilt: 0.44 },
      { name: 'Юпитер', light: '#f0d3a8', dark: '#9a6534', size: 1.0,
        texture: 'bands', ring: null, moons: 3, tilt: 0.05 },
      { name: 'Сатурн', light: '#f3dfb0', dark: '#a3803f', size: 0.9,
        texture: 'bands', ring: 'rgba(240, 222, 180, 0.75)', moons: 2, tilt: 0.47 },
      { name: 'Уран', light: '#b8ecef', dark: '#2c7f8c', size: 0.74,
        texture: 'smooth', ring: 'rgba(190, 235, 240, 0.35)', moons: 1, tilt: 1.7 },
      { name: 'Нептун', light: '#7ea6f5', dark: '#1c357f', size: 0.72,
        texture: 'storm', ring: null, moons: 1, tilt: 0.49 }
    ];

    var center = { x: 0, y: 0 };
    var orbits = [];
    var planets = [];
    var stars = [];
    var comets = [];
    var belt = [];
    var nebula = [];
    var dragged = null;
    var level = env.level;

    function planetCount() {
      // Система всегда полная: убрать Нептун ради «прогрессии» значило бы
      // сломать узнаваемость — зритель считает планеты и замечает нехватку.
      return SOLAR.length;
    }

    /**
     * Точка на орбите по углу.
     * @param {number} index индекс орбиты
     * @param {number} angle угол в радианах
     */
    function orbitPoint(index, angle) {
      var radius = orbits[index];
      return {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius * TILT
      };
    }

    function build(width, height) {
      center = { x: width / 2, y: height * 0.52 };

      var count = planetCount();
      var minRadius = Math.min(width, height) * 0.16;
      var maxRadius = Math.min(width * 0.44, height * 0.86);
      orbits = [];
      for (var i = 0; i < count; i += 1) {
        orbits.push(minRadius + ((maxRadius - minRadius) * i) / Math.max(1, count - 1));
      }

      // Планеты пересоздаются только при смене их количества: иначе при
      // каждом resize они прыгали бы на случайные углы.
      if (planets.length !== count) {
        planets = [];
        for (var p = 0; p < count; p += 1) {
          var preset = SOLAR[p];
          planets.push({
            orbit: p,
            angle: u.rand(0, TAU),
            // Дальние планеты идут медленнее — третий закон Кеплера в грубом
            // приближении: период растёт вместе с радиусом орбиты.
            speed: 0.00055 / Math.pow(1 + p * 0.42, 0.9),
            radius: 0,
            style: preset,
            name: preset.name,
            free: null,
            returnFrom: null,
            returnT: 1,
            spin: u.rand(0, TAU),
            tilt: preset.tilt,
            seed: p * 13.7
          });
        }
      }

      var unit = Math.min(width, height) * 0.036;
      planets.forEach(function (planet) {
        planet.radius = u.clamp(unit * planet.style.size, 6, 30);
      });

      // Пояс астероидов стоит там же, где в настоящей системе — между
      // Марсом (индекс 3) и Юпитером (4).
      belt = [];
      if (orbits.length > 4) {
        var beltRadius = (orbits[3] + orbits[4]) / 2;
        for (var b = 0; b < 130; b += 1) {
          belt.push({
            angle: u.rand(0, TAU),
            radius: beltRadius * u.rand(0.93, 1.07),
            speed: 0.00028 * u.rand(0.8, 1.2),
            size: u.rand(0.6, 1.9),
            alpha: u.rand(0.2, 0.65)
          });
        }
      }

      // Туманность: пара цветных пятен, чтобы фон не был чёрной дырой.
      nebula = [
        { x: width * 0.22, y: height * 0.24, r: Math.min(width, height) * 0.42,
          color: 'rgba(120, 80, 220, ALPHA)', a: 0.1 },
        { x: width * 0.8, y: height * 0.72, r: Math.min(width, height) * 0.38,
          color: 'rgba(40, 160, 190, ALPHA)', a: 0.08 }
      ];

      stars = [];
      var starCount = Math.round((width * height) / 5200);
      for (var s = 0; s < starCount; s += 1) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: u.rand(0.4, 1.5),
          a: u.rand(0.18, 0.85),
          twinkle: u.rand(0.0008, 0.003),
          phase: u.rand(0, TAU)
        });
      }
    }

    /**
     * Возвращает планету на орбиту с плавным перелётом.
     * @param {Object} planet
     */
    function scheduleReturn(planet) {
      planet.returnFrom = { x: planet.free.x, y: planet.free.y };
      planet.returnT = 0;
      planet.free = null;
    }

    /**
     * Текущая экранная позиция планеты с учётом перелёта.
     */
    function planetPosition(planet) {
      if (planet.free) { return planet.free; }

      var target = orbitPoint(planet.orbit, planet.angle);
      if (planet.returnT < 1 && planet.returnFrom) {
        var k = u.easeInOut(planet.returnT);
        return {
          x: planet.returnFrom.x + (target.x - planet.returnFrom.x) * k,
          y: planet.returnFrom.y + (target.y - planet.returnFrom.y) * k
        };
      }
      return target;
    }

    /**
     * Определяет ближайшую орбиту к точке.
     *
     * Сравнивается не расстояние в пикселях, а отклонение от единицы в
     * нормированных координатах эллипса — иначе внешние орбиты, будучи
     * длиннее, всегда выигрывали бы у внутренних.
     */
    function nearestOrbit(x, y) {
      var best = 0;
      var bestError = Infinity;
      for (var i = 0; i < orbits.length; i += 1) {
        var nx = (x - center.x) / orbits[i];
        var ny = (y - center.y) / (orbits[i] * TILT);
        var error = Math.abs(Math.sqrt(nx * nx + ny * ny) - 1);
        if (error < bestError) {
          bestError = error;
          best = i;
        }
      }
      return best;
    }

    return {
      usesPhysics: false,
      hint: 'Перетащи планету на чужую орбиту — они поменяются местами. Отпустишь мимо — вернётся на свою.',

      build: build,

      resize: function (width, height) {
        build(width, height);
      },

      setLevel: function (next) {
        level = next;
        build(env.width, env.height);
      },

      update: function (dt) {
        belt.forEach(function (rock) {
          rock.angle = (rock.angle + rock.speed * dt) % TAU;
        });

        planets.forEach(function (planet) {
          // Угол растёт всегда: планета «догоняет» своё место на орбите,
          // даже пока её держат, поэтому возврат не выглядит откатом назад.
          planet.angle = (planet.angle + planet.speed * dt) % TAU;
          planet.spin += dt * 0.0006;
          if (planet.returnT < 1) {
            planet.returnT = Math.min(1, planet.returnT + dt / RETURN_MS);
          }
        });

        for (var i = comets.length - 1; i >= 0; i -= 1) {
          var comet = comets[i];
          comet.x += comet.vx * dt;
          comet.y += comet.vy * dt;
          comet.life -= dt;
          if (comet.life <= 0) { comets.splice(i, 1); }
        }
      },

      render: function (ctx, width, height) {
        var now = performance.now();

        var space = ctx.createRadialGradient(
          center.x, center.y, 0, center.x, center.y, Math.max(width, height) * 0.85
        );
        space.addColorStop(0, '#141a33');
        space.addColorStop(0.55, '#0b0f1f');
        space.addColorStop(1, '#05070f');
        ctx.fillStyle = space;
        ctx.fillRect(0, 0, width, height);

        // Туманность рисуется до звёзд: звёзды должны быть перед ней.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        nebula.forEach(function (cloud) {
          draw.glow(ctx, cloud.x, cloud.y, cloud.r, cloud.color, cloud.a);
        });
        ctx.restore();

        stars.forEach(function (star) {
          var alpha = star.a * (0.65 + 0.35 * Math.sin(now * star.twinkle + star.phase));
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, TAU);
          ctx.fillStyle = 'rgba(226, 236, 255, ' + alpha.toFixed(3) + ')';
          ctx.fill();
        });

        // Пояс обломков.
        belt.forEach(function (rock) {
          var x = center.x + Math.cos(rock.angle) * rock.radius;
          var y = center.y + Math.sin(rock.angle) * rock.radius * TILT;
          ctx.beginPath();
          ctx.arc(x, y, rock.size, 0, TAU);
          ctx.fillStyle = 'rgba(200, 190, 175, ' + rock.alpha.toFixed(2) + ')';
          ctx.fill();
        });

        // Орбиты.
        orbits.forEach(function (radius) {
          ctx.beginPath();
          ctx.ellipse(center.x, center.y, radius, radius * TILT, 0, 0, TAU);
          ctx.strokeStyle = 'rgba(150, 180, 255, 0.13)';
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 7]);
          ctx.stroke();
          ctx.setLineDash([]);
        });

        // Светило.
        var starRadius = Math.min(width, height) * 0.075;

        // Корона: несколько слоёв свечения разной ширины дают ощущение
        // раскалённого тела, а не жёлтого круга.
        draw.glow(ctx, center.x, center.y, starRadius * 9, 'rgba(255, 180, 60, ALPHA)', 0.16);
        draw.glow(ctx, center.x, center.y, starRadius * 4.5, 'rgba(255, 230, 150, ALPHA)', 0.3);

        // Протуберанцы по кромке.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (var flare = 0; flare < 9; flare += 1) {
          var fa = (TAU * flare) / 9 + now * 0.00012;
          var reach = starRadius * (1.05 + 0.14 * Math.abs(Math.sin(now * 0.0009 + flare)));
          ctx.beginPath();
          ctx.moveTo(center.x + Math.cos(fa) * starRadius * 0.95,
                     center.y + Math.sin(fa) * starRadius * 0.95);
          ctx.lineTo(center.x + Math.cos(fa) * reach, center.y + Math.sin(fa) * reach);
          ctx.strokeStyle = 'rgba(255, 190, 90, 0.5)';
          ctx.lineWidth = starRadius * 0.16;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
        ctx.restore();

        draw.sphere(ctx, center.x, center.y, starRadius, '#fffbe8', '#e87a12');

        comets.forEach(function (comet) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          var tail = ctx.createLinearGradient(
            comet.x, comet.y, comet.x - comet.vx * 90, comet.y - comet.vy * 90
          );
          tail.addColorStop(0, 'rgba(190, 225, 255, 0.85)');
          tail.addColorStop(1, 'rgba(190, 225, 255, 0)');
          ctx.strokeStyle = tail;
          ctx.lineWidth = 2.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(comet.x, comet.y);
          ctx.lineTo(comet.x - comet.vx * 90, comet.y - comet.vy * 90);
          ctx.stroke();
          ctx.restore();
        });

        // Планеты за светилом рисуются раньше — так читается глубина сцены.
        var ordered = planets.slice().sort(function (a, b) {
          return planetPosition(a).y - planetPosition(b).y;
        });

        ordered.forEach(function (planet) {
          var pos = planetPosition(planet);
          var radius = planet.radius;

          if (planet.style.ring) {
            // Три кольца разной плотности вместо одного контура: у Сатурна
            // видно щель Кассини, и без неё кольцо выглядит обручем.
            ctx.save();
            ctx.translate(pos.x, pos.y);
            ctx.rotate(planet.name === 'Уран' ? 1.35 : -0.42);
            [[2.15, 0.09, 0.85], [1.86, 0.16, 1], [1.58, 0.07, 0.55]]
              .forEach(function (band) {
                ctx.beginPath();
                ctx.ellipse(0, 0, radius * band[0], radius * band[0] * 0.3, 0, 0, TAU);
                ctx.strokeStyle = planet.style.ring.replace(
                  /[\d.]+\)$/, (0.75 * band[2]).toFixed(2) + ')'
                );
                ctx.lineWidth = Math.max(1.5, radius * band[1]);
                ctx.stroke();
              });
            ctx.restore();
          }

          draw.sphere(ctx, pos.x, pos.y, radius, planet.style.light, planet.style.dark);

          // Фактура рисуется внутри круга планеты: без обрезки полосы и
          // кратеры вылезали бы за силуэт.
          ctx.save();
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, radius, 0, TAU);
          ctx.clip();
          ctx.translate(pos.x, pos.y);
          ctx.rotate(planet.tilt);

          if (planet.style.texture === 'bands') {
            // Полосы газового гиганта: неравная толщина и лёгкий сдвиг делают
            // их похожими на течения, а не на зебру.
            for (var band = -4; band <= 4; band += 1) {
              var bandY = (band * radius) / 4.2;
              var thickness = radius * (0.1 + ((band + 4) % 3) * 0.045);
              ctx.fillStyle = band % 2 === 0
                ? 'rgba(255,245,220,0.18)' : 'rgba(90,50,20,0.22)';
              ctx.fillRect(-radius, bandY - thickness / 2, radius * 2, thickness);
            }
            // Большое красное пятно у Юпитера.
            if (planet.name === 'Юпитер') {
              ctx.beginPath();
              ctx.ellipse(radius * 0.3, radius * 0.22, radius * 0.28, radius * 0.15,
                0, 0, TAU);
              ctx.fillStyle = 'rgba(200, 90, 60, 0.75)';
              ctx.fill();
            }
          } else if (planet.style.texture === 'earth') {
            // Материки и облачный слой поверх них.
            [[-0.35, -0.2, 0.5, 0.3], [0.3, 0.15, 0.42, 0.34], [0.05, -0.5, 0.3, 0.2]]
              .forEach(function (spot) {
                ctx.beginPath();
                ctx.ellipse(spot[0] * radius, spot[1] * radius,
                  spot[2] * radius, spot[3] * radius, spot[0], 0, TAU);
                ctx.fillStyle = 'rgba(90, 170, 90, 0.8)';
                ctx.fill();
              });
            ctx.beginPath();
            ctx.ellipse(-radius * 0.1, radius * 0.3, radius * 0.6, radius * 0.18,
              0.3, 0, TAU);
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fill();
            // Полярные шапки.
            ctx.beginPath();
            ctx.ellipse(0, -radius * 0.9, radius * 0.5, radius * 0.18, 0, 0, TAU);
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fill();
          } else if (planet.style.texture === 'clouds') {
            for (var cl = 0; cl < 4; cl += 1) {
              ctx.beginPath();
              ctx.ellipse(0, (cl - 1.5) * radius * 0.45,
                radius * 0.95, radius * 0.13, 0.2, 0, TAU);
              ctx.fillStyle = 'rgba(255, 240, 200, 0.22)';
              ctx.fill();
            }
          } else if (planet.style.texture === 'smooth') {
            ctx.beginPath();
            ctx.ellipse(0, 0, radius * 0.9, radius * 0.3, 0, 0, TAU);
            ctx.fillStyle = 'rgba(255,255,255,0.1)';
            ctx.fill();
          } else if (planet.style.texture === 'craters') {
            for (var c = 0; c < 5; c += 1) {
              var ca = planet.seed + c * 1.7;
              var cx = Math.cos(ca) * radius * 0.5;
              var cy = Math.sin(ca * 1.4) * radius * 0.5;
              var cr = radius * (0.1 + ((c * 7) % 10) / 60);
              ctx.beginPath();
              ctx.arc(cx, cy, cr, 0, TAU);
              ctx.fillStyle = 'rgba(0,0,0,0.2)';
              ctx.fill();
              ctx.beginPath();
              ctx.arc(cx - cr * 0.2, cy - cr * 0.2, cr * 0.8, 0, TAU);
              ctx.fillStyle = 'rgba(255,255,255,0.08)';
              ctx.fill();
            }
          } else if (planet.style.texture === 'storm') {
            ctx.beginPath();
            ctx.ellipse(radius * 0.24, -radius * 0.16, radius * 0.34, radius * 0.2,
              planet.spin * 0.4, 0, TAU);
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.fill();
          } else {
            // ocean: материковые пятна
            for (var m = 0; m < 3; m += 1) {
              var ma = planet.seed * 0.7 + m * 2.1;
              ctx.beginPath();
              ctx.ellipse(Math.cos(ma) * radius * 0.4, Math.sin(ma) * radius * 0.35,
                radius * 0.4, radius * 0.24, ma, 0, TAU);
              ctx.fillStyle = 'rgba(255,255,255,0.14)';
              ctx.fill();
            }
          }
          ctx.restore();

          // Терминатор: затемнение стороны, отвёрнутой от светила.
          var toStar = Math.atan2(center.y - pos.y, center.x - pos.x);
          var shade = ctx.createRadialGradient(
            pos.x - Math.cos(toStar) * radius * 0.7,
            pos.y - Math.sin(toStar) * radius * 0.7,
            radius * 0.15,
            pos.x, pos.y, radius
          );
          shade.addColorStop(0, 'rgba(2, 4, 12, 0.62)');
          shade.addColorStop(1, 'rgba(2, 4, 12, 0)');
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, radius, 0, TAU);
          ctx.fillStyle = shade;
          ctx.fill();

          if (planet === dragged) {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, radius * 1.28, 0, TAU);
            ctx.strokeStyle = 'rgba(160, 200, 255, 0.55)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }

          // Название под планетой: система перестаёт быть абстракцией и
          // становится узнаваемой картой.
          if (planet.name) {
            ctx.font = '600 9.5px "Cascadia Mono", Consolas, monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = planet === dragged
              ? 'rgba(220, 240, 255, 0.95)'
              : 'rgba(200, 216, 240, 0.42)';
            ctx.fillText(planet.name, pos.x, pos.y + radius + 13);
          }

          // Спутники: их число задано стилем планеты, а не размером — так
          // система выглядит собранной, а не случайной.
          for (var moon = 0; moon < (planet.style.moons || 0); moon += 1) {
            var moonAngle = now * (0.0009 + moon * 0.0004) + planet.spin + moon * 2.2;
            var moonDist = radius * (1.8 + moon * 0.6);
            var moonX = pos.x + Math.cos(moonAngle) * moonDist;
            var moonY = pos.y + Math.sin(moonAngle) * moonDist * 0.42;
            draw.sphere(ctx, moonX, moonY, Math.max(2.5, radius * 0.2),
              '#e8eef8', '#5b6474');
          }
        });

        draw.vignette(ctx, width, height, 0.5);
      },

      draggables: function () {
        return [];
      },

      pointerDown: function (x, y) {
        for (var i = planets.length - 1; i >= 0; i -= 1) {
          var pos = planetPosition(planets[i]);
          var dx = pos.x - x;
          var dy = pos.y - y;
          if (Math.sqrt(dx * dx + dy * dy) <= planets[i].radius + 12) {
            dragged = planets[i];
            dragged.free = { x: x, y: y };
            dragged.returnT = 1;
            return;
          }
        }
      },

      pointerMove: function (x, y) {
        if (dragged) { dragged.free = { x: x, y: y }; }
      },

      pointerUp: function (x, y) {
        if (!dragged) { return; }

        var targetOrbit = nearestOrbit(x, y);
        if (targetOrbit !== dragged.orbit) {
          var occupant = null;
          for (var i = 0; i < planets.length; i += 1) {
            if (planets[i] !== dragged && planets[i].orbit === targetOrbit) {
              occupant = planets[i];
              break;
            }
          }
          if (occupant) {
            // Обмен орбитами: сцена не допускает двух планет на одном пути.
            var previous = dragged.orbit;
            dragged.orbit = targetOrbit;
            occupant.orbit = previous;
            occupant.returnFrom = planetPosition(occupant);
            occupant.returnT = 0;
          }
        }

        scheduleReturn(dragged);
        dragged = null;
      },

      celebrate: function (count) {
        for (var i = 0; i < u.clamp(count, 1, 5); i += 1) {
          var angle = u.rand(-0.9, -0.25);
          comets.push({
            x: u.rand(0, env.width * 0.4),
            y: u.rand(env.height * 0.75, env.height),
            vx: Math.cos(angle) * -0.55,
            vy: Math.sin(angle) * 0.55,
            life: 2200
          });
        }
      },

      destroy: function () {
        dragged = null;
        comets = [];
      }
    };
  });

  // ======================================================================= //
  // СТОЛ ВДОХНОВЕНИЯ                                                        //
  // ======================================================================= //

  global.Stage.register('desk', function (env) {
    var M = env.M;
    var draw = env.draw;
    var u = env.util;

    var MAX_ITEMS = 26;
    var PUSH_RADIUS = 90;

    var KINDS = [
      { kind: 'book',   top: '#8b5cf6', bottom: '#4c2d94' },
      { kind: 'book',   top: '#10b981', bottom: '#08543b' },
      { kind: 'book',   top: '#f59e0b', bottom: '#8a5306' },
      { kind: 'mug',    top: '#f1f5f9', bottom: '#8d99a8' },
      { kind: 'pencil', top: '#fbbf24', bottom: '#b45309' },
      { kind: 'die',    top: '#e2e8f0', bottom: '#94a3b8' },
      { kind: 'sheet',  top: '#f8fafc', bottom: '#cbd5e1' },
      { kind: 'clip',   top: '#94a3b8', bottom: '#475569' }
    ];

    var scenery = [];
    var items = [];
    var surfaceY = 0;
    var level = env.level;
    var stains = [];
    var dust = [];

    function targetCount() {
      return u.clamp(4 + Math.round(u.clamp(level, 1, 10) * 1.6), 5, MAX_ITEMS);
    }

    /**
     * Создаёт предмет заданного вида.
     * @param {number} x
     * @param {number} y
     * @param {Object} spec элемент KINDS
     */
    function makeItem(x, y, spec) {
      var scale = u.clamp(env.width / 620, 0.65, 1.5);
      var body;

      switch (spec.kind) {
        case 'book':
          body = M.Bodies.rectangle(x, y, 74 * scale, 20 * scale, {
            chamfer: { radius: 3 }, friction: 0.5, restitution: 0.06, density: 0.0016
          });
          break;
        case 'mug':
          body = M.Bodies.rectangle(x, y, 34 * scale, 38 * scale, {
            chamfer: { radius: 8 }, friction: 0.45, restitution: 0.1, density: 0.0018
          });
          break;
        case 'pencil':
          body = M.Bodies.rectangle(x, y, 84 * scale, 8 * scale, {
            chamfer: { radius: 3 }, friction: 0.3, restitution: 0.2, density: 0.0008
          });
          break;
        case 'die':
          body = M.Bodies.rectangle(x, y, 22 * scale, 22 * scale, {
            chamfer: { radius: 4 }, friction: 0.4, restitution: 0.35, density: 0.0014
          });
          break;
        case 'clip':
          body = M.Bodies.circle(x, y, 9 * scale, {
            friction: 0.25, restitution: 0.45, density: 0.0007
          });
          break;
        default:  // sheet
          body = M.Bodies.rectangle(x, y, 58 * scale, 42 * scale, {
            chamfer: { radius: 2 }, friction: 0.6, restitution: 0.02, density: 0.0005,
            frictionAir: 0.05
          });
      }

      body.plugin = { kind: spec.kind, top: spec.top, bottom: spec.bottom, scale: scale };
      M.Body.setAngle(body, u.rand(-0.5, 0.5));
      return body;
    }

    /**
     * Досыпает недостающие предметы сверху.
     * @param {number} count сколько добавить
     * @param {boolean} burst бросать с разлётом
     */
    function addItems(count, burst) {
      for (var i = 0; i < count; i += 1) {
        var spec = KINDS[(items.length + i) % KINDS.length];
        var item = makeItem(
          u.rand(env.width * 0.18, env.width * 0.82),
          burst ? u.rand(-60, 20) : u.rand(env.height * 0.1, env.height * 0.4),
          spec
        );
        if (burst) {
          M.Body.setVelocity(item, { x: u.rand(-3, 3), y: u.rand(1, 4) });
          M.Body.setAngularVelocity(item, u.rand(-0.3, 0.3));
        }
        items.push(item);
        M.Composite.add(env.world, item);
      }

      while (items.length > MAX_ITEMS) {
        M.Composite.remove(env.world, items.shift());
      }
    }

    function build(width, height) {
      M.Composite.remove(env.world, scenery);
      scenery = [];
      items.forEach(function (item) { M.Composite.remove(env.world, item); });
      items = [];

      surfaceY = height * 0.78;

      scenery.push(M.Bodies.rectangle(
        width / 2, surfaceY + (height - surfaceY) / 2, width * 2, height - surfaceY,
        { isStatic: true, friction: 0.7 }
      ));
      // Бортики: без них предметы улетают за край и сцена пустеет.
      scenery.push(M.Bodies.rectangle(-30, height / 2, 60, height * 3, { isStatic: true }));
      scenery.push(M.Bodies.rectangle(width + 30, height / 2, 60, height * 3, { isStatic: true }));

      M.Composite.add(env.world, scenery);

      // Следы от кружки: стол должен выглядеть рабочим, а не витринным.
      stains = [];
      for (var s = 0; s < 3; s += 1) {
        stains.push({
          x: u.rand(width * 0.1, width * 0.9),
          y: u.rand(surfaceY + 14, height - 14),
          r: u.rand(14, 26),
          a: u.rand(0.05, 0.12)
        });
      }

      dust = env.draw.seedMotes(18, width, surfaceY, { rise: false, speed: 0.4 });
      addItems(targetCount(), false);
    }

    /** Рисует конкретный предмет поверх его физического тела. */
    function renderItem(ctx, item) {
      var plugin = item.plugin;
      var position = item.position;

      draw.contactShadow(ctx, position.x, surfaceY + 3,
        26 * plugin.scale, 8 * plugin.scale, 0.3);

      ctx.save();
      draw.bodyFill(ctx, item, plugin.top, plugin.bottom, 'rgba(0,0,0,0.32)');
      ctx.restore();

      ctx.save();
      ctx.translate(position.x, position.y);
      ctx.rotate(item.angle);

      var s = plugin.scale;
      if (plugin.kind === 'book') {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(-37 * s + 6 * s, -10 * s + 3 * s, 3 * s, 14 * s);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(-20 * s, -3 * s, 46 * s, 1.5 * s);
      } else if (plugin.kind === 'mug') {
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 3 * s;
        ctx.beginPath();
        ctx.arc(20 * s, 0, 9 * s, -Math.PI / 2, Math.PI / 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(0, -16 * s, 15 * s, 4.5 * s, 0, 0, TAU);
        ctx.fillStyle = '#3a2418';
        ctx.fill();
      } else if (plugin.kind === 'pencil') {
        ctx.fillStyle = '#f8d9a0';
        ctx.beginPath();
        ctx.moveTo(42 * s, -4 * s);
        ctx.lineTo(52 * s, 0);
        ctx.lineTo(42 * s, 4 * s);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#2b2b2b';
        ctx.beginPath();
        ctx.moveTo(49 * s, -1.4 * s);
        ctx.lineTo(52 * s, 0);
        ctx.lineTo(49 * s, 1.4 * s);
        ctx.closePath();
        ctx.fill();
      } else if (plugin.kind === 'die') {
        ctx.fillStyle = '#1e293b';
        [[-6, -6], [6, 6], [0, 0], [-6, 6], [6, -6]].forEach(function (dot) {
          ctx.beginPath();
          ctx.arc(dot[0] * s, dot[1] * s, 2.1 * s, 0, TAU);
          ctx.fill();
        });
      } else if (plugin.kind === 'sheet') {
        ctx.strokeStyle = 'rgba(120,140,170,0.55)';
        ctx.lineWidth = 1;
        for (var line = -2; line <= 2; line += 1) {
          ctx.beginPath();
          ctx.moveTo(-22 * s, line * 7 * s);
          ctx.lineTo(22 * s, line * 7 * s);
          ctx.stroke();
        }
      } else if (plugin.kind === 'clip') {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.6 * s;
        ctx.beginPath();
        ctx.arc(0, 0, 5 * s, 0, TAU);
        ctx.stroke();
      }

      ctx.restore();
    }

    return {
      usesPhysics: true,
      hint: 'Хватай предметы и расшвыривай их. Клик по пустому месту толкает всё рядом.',

      build: build,

      resize: function (width, height) {
        build(width, height);
      },

      setLevel: function (next) {
        level = next;
        var missing = targetCount() - items.length;
        if (missing > 0) {
          addItems(missing, true);
        }
      },

      update: function () {
        var limit = env.height * 2.5;
        for (var i = items.length - 1; i >= 0; i -= 1) {
          if (items[i].position.y > limit) {
            M.Composite.remove(env.world, items[i]);
            items.splice(i, 1);
          }
        }
      },

      render: function (ctx, width, height, dt) {
        var wall = ctx.createLinearGradient(0, 0, 0, surfaceY);
        wall.addColorStop(0, '#12141b');
        wall.addColorStop(1, '#1c1f2a');
        ctx.fillStyle = wall;
        ctx.fillRect(0, 0, width, surfaceY);

        // Настольная лампа: сам источник видно, поэтому тени объяснены.
        var lampX = width * 0.2;
        var lampY = surfaceY * 0.22;
        ctx.beginPath();
        ctx.moveTo(lampX - width * 0.07, lampY + surfaceY * 0.12);
        ctx.lineTo(lampX + width * 0.07, lampY + surfaceY * 0.12);
        ctx.lineTo(lampX + width * 0.035, lampY);
        ctx.lineTo(lampX - width * 0.035, lampY);
        ctx.closePath();
        var shade = ctx.createLinearGradient(0, lampY, 0, lampY + surfaceY * 0.12);
        shade.addColorStop(0, '#3a3f4d');
        shade.addColorStop(1, '#22252f');
        ctx.fillStyle = shade;
        ctx.fill();

        // Конус света от лампы к столу.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        var cone = ctx.createLinearGradient(lampX, lampY, lampX, surfaceY + 40);
        cone.addColorStop(0, 'rgba(255, 214, 150, 0.16)');
        cone.addColorStop(1, 'rgba(255, 214, 150, 0)');
        ctx.beginPath();
        ctx.moveTo(lampX - width * 0.06, lampY + surfaceY * 0.12);
        ctx.lineTo(lampX + width * 0.06, lampY + surfaceY * 0.12);
        ctx.lineTo(lampX + width * 0.3, surfaceY + 50);
        ctx.lineTo(lampX - width * 0.3, surfaceY + 50);
        ctx.closePath();
        ctx.fillStyle = cone;
        ctx.fill();
        ctx.restore();

        draw.glow(ctx, lampX, lampY + surfaceY * 0.1, height * 0.9,
          'rgba(255, 214, 150, ALPHA)', 0.12);

        var wood = ctx.createLinearGradient(0, surfaceY, 0, height);
        wood.addColorStop(0, '#6b4a2f');
        wood.addColorStop(0.12, '#54371f');
        wood.addColorStop(1, '#2c1c10');
        ctx.fillStyle = wood;
        ctx.fillRect(0, surfaceY, width, height - surfaceY);

        ctx.strokeStyle = 'rgba(255, 214, 150, 0.22)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, surfaceY + 0.5);
        ctx.lineTo(width, surfaceY + 0.5);
        ctx.stroke();

        // Волокна дерева.
        ctx.strokeStyle = 'rgba(0,0,0,0.14)';
        ctx.lineWidth = 1;
        for (var grain = 1; grain < 7; grain += 1) {
          var gy = surfaceY + ((height - surfaceY) * grain) / 7;
          ctx.beginPath();
          ctx.moveTo(0, gy);
          ctx.bezierCurveTo(width * 0.3, gy - 3, width * 0.7, gy + 3, width, gy);
          ctx.stroke();
        }

        // Следы от кружки под предметами.
        stains.forEach(function (stain) {
          ctx.beginPath();
          ctx.arc(stain.x, stain.y, stain.r, 0, TAU);
          ctx.strokeStyle = 'rgba(40, 22, 10, ' + (stain.a * 2).toFixed(3) + ')';
          ctx.lineWidth = 2.4;
          ctx.stroke();
        });

        items.forEach(function (item) { renderItem(ctx, item); });

        // Пылинки в конусе света — классический признак «тёплой» сцены.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        draw.motes(ctx, dust, width, surfaceY, dt || 16, 'rgba(255, 220, 170, ALPHA)');
        ctx.restore();

        draw.vignette(ctx, width, height, 0.46);
      },

      draggables: function () {
        return items;
      },

      pointerDown: function (x, y) {
        // Клик по пустому месту — толчок: сцена отзывается, даже если
        // промахнулся мимо предмета.
        items.forEach(function (item) {
          var dx = item.position.x - x;
          var dy = item.position.y - y;
          var distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < PUSH_RADIUS && distance > 0.5) {
            var force = (1 - distance / PUSH_RADIUS) * 0.055 * item.mass;
            M.Body.applyForce(item, item.position, {
              x: (dx / distance) * force,
              y: (dy / distance) * force - force * 0.35
            });
          }
        });
      },

      celebrate: function (count) {
        addItems(u.clamp(count, 1, 5), true);
      },

      destroy: function () {
        items = [];
        scenery = [];
        stains = [];
        dust = [];
      }
    };
  });
}(window));
