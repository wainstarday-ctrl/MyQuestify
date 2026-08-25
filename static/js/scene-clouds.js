/**
 * MyQuestify — Облака Вдохновения.
 *
 * Небо, по которому плывут облака, и солнце, определяющее время суток.
 * Облака уходят за правый край и появляются слева — небо не кончается.
 *
 * Две независимые возможности. Нажатие на облако собирает в нём тучу: она
 * темнеет, роняет дождь, а при частых нажатиях разражается молнией.
 * Солнце перетаскивается по дуге, и вместе с ним меняется время суток —
 * от синего рассвета слева до ночи справа.
 *
 * Физика своя, без Matter. Причина та же, что в «Орбитах Замысла»: здесь
 * нет столкновений и нет тел, есть перемещение по заданным законам.
 * Облако плывёт с постоянной скоростью, капля падает с ускорением, солнце
 * идёт по дуге. Через тела движка каждое из этих движений пришлось бы
 * задавать силами, подбирая их так, чтобы получилось то же самое.
 */
(function (global) {
  'use strict';

  if (!global.Stage) { return; }

  var TAU = Math.PI * 2;

  global.Stage.register('clouds', function (env) {
    var draw = env.draw;
    var u = env.util;

    /** Полный оборот солнца, миллисекунды. */
    var DAY_MS = 20000;

    /** Сколько нажатий подряд собирают молнию. */
    var STRIKES_FOR_BOLT = 4;

    /** Промежуток, в течение которого нажатия считаются частыми. */
    var STRIKE_WINDOW_MS = 1400;

    /**
     * Ключевые точки суток.
     *
     * Цвет неба задан четырьмя опорными положениями солнца, между которыми
     * идёт плавный переход. Задавать цвет формулой было бы короче, но
     * рассвет и закат отличаются от полудня не яркостью, а оттенком, и
     * подобрать это выражением сложнее, чем перечислить.
     */
    var SKY = [
      { at: 0.00, top: [12, 18, 42], bottom: [40, 32, 68], light: 0.12, name: 'ночь' },
      { at: 0.22, top: [58, 62, 120], bottom: [190, 132, 120], light: 0.45, name: 'рассвет' },
      { at: 0.50, top: [78, 148, 220], bottom: [176, 214, 244], light: 1.00, name: 'день' },
      { at: 0.78, top: [92, 76, 136], bottom: [228, 138, 98], light: 0.48, name: 'закат' },
      { at: 1.00, top: [12, 18, 42], bottom: [40, 32, 68], light: 0.12, name: 'ночь' }
    ];

    var clouds = [];
    var drops = [];
    var bolts = [];
    var stars = [];
    var birds = [];
    var sun = { t: 0.5, dragging: false, x: 0, y: 0, r: 0 };
    var level = env.level;
    var pointer = null;
    var flash = 0;
    var shake = 0;

    /** Доля частиц, разрешённая профилем отрисовки. Задаётся в build. */
    var density = env.density || 1;

    /** Предел одновременно падающих капель. Задаётся в build. */
    var dropLimit = 320;

    /**
     * Возвращает состояние неба для текущего положения солнца.
     *
     * @returns {{top: number[], bottom: number[], light: number}}
     */
    function sky() {
      var t = sun.t;
      for (var i = 0; i < SKY.length - 1; i += 1) {
        var a = SKY[i];
        var b = SKY[i + 1];
        if (t >= a.at && t <= b.at) {
          var k = (t - a.at) / (b.at - a.at);
          return {
            top: u.mix(a.top, b.top, k),
            bottom: u.mix(a.bottom, b.bottom, k),
            light: a.light + (b.light - a.light) * k,
            name: k < 0.5 ? a.name : b.name
          };
        }
      }
      return { top: SKY[0].top, bottom: SKY[0].bottom, light: SKY[0].light, name: SKY[0].name };
    }

    /**
     * Положение солнца на дуге.
     *
     * Дуга, а не прямая: светило, идущее по прямой, читается как предмет
     * на верёвке. Подъём в середине пути и снижение к краям — то, чего
     * ожидает глаз.
     */
    function sunPosition(width, height) {
      var angle = Math.PI * (1 - sun.t);
      return {
        x: width * 0.5 + Math.cos(angle) * width * 0.42,
        y: height * 0.72 - Math.sin(angle) * height * 0.52
      };
    }

    /**
     * Создаёт облако.
     *
     * @param {number} x положение по горизонтали
     * @param {number} width ширина холста
     * @param {number} height высота холста
     */
    function makeCloud(x, width, height) {
      var scale = u.rand(0.6, 1.4);
      var puffs = [];
      var count = Math.round(u.rand(4, 7));

      // Облако складывается из перекрывающихся кругов. Ряд кругов по
      // возрастающей и убывающей высоте даёт узнаваемый силуэт, тогда как
      // случайные размеры превращают его в бесформенное пятно.
      for (var i = 0; i < count; i += 1) {
        var position = i / (count - 1);
        var bulge = Math.sin(position * Math.PI);
        puffs.push({
          dx: (position - 0.5) * 120 * scale,
          dy: -bulge * 16 * scale + u.rand(-4, 4),
          r: (16 + bulge * 22) * scale * u.rand(0.85, 1.15),

          // Хранимый градиент заливки и ступень оттенка, для которой он
          // построен. Отрицательное значение не совпадает ни с одной
          // ступенью, поэтому первый кадр строит градиент заново.
          gradient: null,
          tint: -1
        });
      }

      return {
        x: x,
        y: u.rand(height * 0.12, height * 0.46),
        scale: scale,
        puffs: puffs,
        // Дальние облака мельче и медленнее: разница скоростей создаёт
        // ощущение глубины без второго слоя отрисовки.
        speed: (0.12 + scale * 0.16) * u.rand(0.85, 1.15),
        storm: 0,
        strikes: 0,
        lastStrike: 0,
        rainAt: 0
      };
    }

    function build(width, height) {
      density = env.density || 1;
      dropLimit = Math.max(80, Math.round(320 * density));

      var count = u.clamp(4 + Math.round(u.clamp(level, 1, 10) / 2), 4, 9);
      count = Math.max(3, Math.round(count * density));

      clouds = [];
      for (var i = 0; i < count; i += 1) {
        clouds.push(makeCloud((width * (i + 0.5)) / count, width, height));
      }

      drops = [];
      bolts = [];

      // Плотность звёзд и предел одновременных капель следуют профилю
      // отрисовки. Прежде и то, и другое было задано числом: на слабом
      // устройстве профиль понижал количество облаков, а сотня звёзд и
      // три сотни капель оставались, и выигрыш съедался ими.
      stars = [];
      var starCount = Math.max(24, Math.round((width / 9) * density));
      for (var s = 0; s < starCount; s += 1) {
        stars.push({
          x: u.rand(0, width),
          y: u.rand(0, height * 0.7),
          r: u.rand(0.4, 1.5),
          twinkle: u.rand(0.0006, 0.0026)
        });
      }

      // Птицы появляются только днём: ночью их не видно, и рисовать их
      // означало бы показывать силуэты на тёмном фоне без причины.
      birds = [];
      for (var b = 0; b < 5; b += 1) {
        birds.push({
          x: u.rand(0, width),
          y: u.rand(height * 0.15, height * 0.4),
          speed: u.rand(0.25, 0.6),
          phase: u.rand(0, TAU),
          scale: u.rand(0.6, 1.1)
        });
      }
    }

    /** Роняет каплю из облака. */
    function rain(cloud) {
      if (drops.length > dropLimit) { return; }
      drops.push({
        x: cloud.x + u.rand(-60, 60) * cloud.scale,
        y: cloud.y + 12 * cloud.scale,
        vy: u.rand(2.2, 4.2),
        len: u.rand(6, 14),
        life: 1
      });
    }

    /**
     * Разряжает молнию из облака.
     *
     * Ломаная строится один раз и живёт доли секунды: пересчитывать её
     * каждый кадр значило бы показывать не разряд, а мерцающий шум.
     */
    function strike(cloud, height) {
      var points = [{ x: cloud.x, y: cloud.y + 14 * cloud.scale }];
      var y = points[0].y;
      var x = points[0].x;

      while (y < height * 0.92) {
        y += u.rand(24, 52);
        x += u.rand(-34, 34);
        points.push({ x: x, y: y });
      }

      bolts.push({ points: points, life: 1, branch: u.rand(0.3, 0.7) });
      flash = 1;
      shake = 1;
    }

    return {
      usesPhysics: false,
      hint: 'Нажимай на облако — соберётся туча и пойдёт дождь, а от частых нажатий ударит молния. Перетащи солнце — сменится время суток.',

      build: build,
      resize: function (w, h) { build(w, h); },
      setLevel: function (next) { level = next; build(env.width, env.height); },

      update: function (dt) {
        var frames = u.clamp(dt / 16.7, 0.5, 2);
        flash = Math.max(0, flash - dt / 260);
        shake = Math.max(0, shake - dt / 420);

        // Солнце идёт само, пока его не держат. Полный оборот за двадцать
        // секунд: медленнее — и смена суток перестаёт читаться, быстрее —
        // превращается в мельтешение.
        if (!sun.dragging) {
          sun.t = (sun.t + dt / DAY_MS) % 1;
        }

        var width = env.width;
        var height = env.height;

        clouds.forEach(function (cloud) {
          cloud.x += cloud.speed * frames;

          // Уходя за правый край, облако появляется слева. Небо не имеет
          // границ, и остановка облака у края разрушила бы это.
          var span = 140 * cloud.scale;
          if (cloud.x - span > width) {
            cloud.x = -span;
            cloud.y = u.rand(height * 0.12, height * 0.46);
          }

          // Туча рассеивается сама: собранная нажатием, она не должна
          // висеть вечно.
          cloud.storm = Math.max(0, cloud.storm - dt / 9000);

          if (cloud.storm > 0.15) {
            cloud.rainAt += dt * cloud.storm;
            var interval = 90 - cloud.storm * 60;
            while (cloud.rainAt > interval) {
              cloud.rainAt -= interval;
              rain(cloud);
            }
          }

          // Счётчик частых нажатий сбрасывается по истечении окна: молния
          // должна быть наградой за настойчивость, а не копиться часами.
          if (cloud.strikes && performance.now() - cloud.lastStrike > STRIKE_WINDOW_MS) {
            cloud.strikes = 0;
          }
        });

        for (var i = drops.length - 1; i >= 0; i -= 1) {
          var drop = drops[i];
          drop.vy += 0.06 * frames;
          drop.y += drop.vy * frames;
          if (drop.y > height * 0.98) { drops.splice(i, 1); }
        }

        for (var b = bolts.length - 1; b >= 0; b -= 1) {
          bolts[b].life -= dt / 220;
          if (bolts[b].life <= 0) { bolts.splice(b, 1); }
        }

        var light = sky().light;
        birds.forEach(function (bird) {
          bird.x += bird.speed * frames * light;
          bird.phase += dt * 0.008;
          if (bird.x > width + 30) { bird.x = -30; }
        });

      },

      render: function (ctx, width, height) {
        var now = performance.now();
        var state = sky();
        var position = sunPosition(width, height);
        sun.x = position.x;
        sun.y = position.y;
        sun.r = Math.min(width, height) * 0.055;

        ctx.save();
        if (shake > 0.02) {
          var amp = shake * 4;
          ctx.translate(u.rand(-amp, amp), u.rand(-amp, amp));
        }

        // Грозовые тучи затемняют небо целиком: гроза — состояние погоды,
        // а не пятно над одним облаком.
        var storminess = clouds.reduce(function (peak, cloud) {
          return Math.max(peak, cloud.storm);
        }, 0);
        var daylight = state.light * (1 - storminess * 0.55);

        var gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, u.rgba(u.mix(state.top, [24, 26, 34], storminess * 0.6), 1));
        gradient.addColorStop(1, u.rgba(u.mix(state.bottom, [46, 46, 56], storminess * 0.6), 1));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // Звёзды проступают по мере темноты — и ночью, и в грозу.
        var starAlpha = u.clamp(1 - daylight * 1.6, 0, 1);
        if (starAlpha > 0.02) {
          // Цвет задаётся один раз, а мерцание — числовой прозрачностью.
          // Прежде на каждую звезду каждый кадр собиралась строка вида
          // «rgba(...)» с округлением: сотня строк за кадр, шесть тысяч в
          // секунду, и все немедленно выбрасывались.
          ctx.fillStyle = 'rgb(240, 244, 255)';
          var baseAlpha = ctx.globalAlpha;
          stars.forEach(function (star) {
            var twinkle = 0.6 + 0.4 * Math.sin(now * star.twinkle + star.x);
            ctx.globalAlpha = baseAlpha * starAlpha * twinkle * 0.9;
            ctx.beginPath();
            ctx.arc(star.x, star.y, star.r, 0, TAU);
            ctx.fill();
          });
          ctx.globalAlpha = baseAlpha;
        }

        // Солнце. Ореол рисуется в режиме сложения, поэтому свет ложится
        // на небо, а не закрывает его кругом.
        if (env.glow) {
          draw.glow(ctx, sun.x, sun.y, sun.r * 9,
            'rgba(255, 226, 150, ALPHA)', 0.1 + daylight * 0.22);
        }

        var disc = ctx.createRadialGradient(
          sun.x - sun.r * 0.2, sun.y - sun.r * 0.2, sun.r * 0.1,
          sun.x, sun.y, sun.r
        );
        // На закате и рассвете светило теплеет: белое солнце у горизонта
        // выглядит чужеродно.
        var warm = 1 - daylight;
        disc.addColorStop(0, u.rgba(u.mix([255, 252, 226], [255, 214, 150], warm), 1));
        disc.addColorStop(1, u.rgba(u.mix([255, 206, 92], [236, 128, 72], warm), 1));
        ctx.beginPath();
        ctx.arc(sun.x, sun.y, sun.r, 0, TAU);
        ctx.fillStyle = disc;
        ctx.fill();

        if (sun.dragging) {
          ctx.beginPath();
          ctx.arc(sun.x, sun.y, sun.r * 1.35, 0, TAU);
          ctx.strokeStyle = 'rgba(255, 240, 200, 0.7)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Птицы: только при достаточном свете.
        if (daylight > 0.4) {
          ctx.strokeStyle = 'rgba(40, 44, 56, ' + ((daylight - 0.4) * 0.9).toFixed(2) + ')';
          ctx.lineWidth = 1.6;
          birds.forEach(function (bird) {
            var wing = Math.sin(bird.phase) * 5 * bird.scale;
            ctx.beginPath();
            ctx.moveTo(bird.x - 7 * bird.scale, bird.y + wing);
            ctx.quadraticCurveTo(bird.x, bird.y - 3 * bird.scale, bird.x + 7 * bird.scale, bird.y + wing);
            ctx.stroke();
          });
        }

        // Дождь под облаками, но над ними самими: капля, нарисованная
        // поверх тучи, выглядит падающей сквозь неё.
        // Все капли собираются в один контур и обводятся разом. Отдельная
        // обводка на каплю означала бы до трёхсот вызовов за кадр при
        // одинаковых цвете и толщине — а именно они и стоят дорого.
        if (drops.length) {
          ctx.strokeStyle = 'rgba(184, 214, 240, 0.55)';
          ctx.lineWidth = 1.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          drops.forEach(function (drop) {
            ctx.moveTo(drop.x, drop.y);
            ctx.lineTo(drop.x - 1, drop.y + drop.len);
          });
          ctx.stroke();
        }

        // Облака.
        clouds.forEach(function (cloud) {
          var tone = u.mix([255, 255, 255], [92, 96, 112], cloud.storm);
          var shade = u.mix([206, 214, 230], [58, 60, 74], cloud.storm);

          // Оттенок тучи меняется плавно, но незаметно для глаза мелкими
          // долями. Достаточно двадцати ступеней: градиент пересобирается
          // при переходе на новую, а не каждый кадр. Прежде на девять
          // облаков приходилось до полусотни новых градиентов за кадр —
          // три тысячи в секунду, и это самая дорогая операция холста.
          var step = Math.round(cloud.storm * 20);

          cloud.puffs.forEach(function (puff) {
            var px = cloud.x + puff.dx;
            var py = cloud.y + puff.dy;

            if (puff.tint !== step) {
              // Градиент строится вокруг начала координат, а не вокруг
              // положения клуба: тогда он не зависит от того, где облако
              // окажется в следующем кадре, и переживает его движение.
              // Нижняя половина темнее: свет падает сверху, и однотонное
              // облако выглядит вырезанным из бумаги.
              var body = ctx.createLinearGradient(0, -puff.r, 0, puff.r);
              body.addColorStop(0, u.rgba(tone, 0.97));
              body.addColorStop(1, u.rgba(shade, 0.95));
              puff.gradient = body;
              puff.tint = step;
            }

            ctx.save();
            ctx.translate(px, py);
            ctx.beginPath();
            ctx.arc(0, 0, puff.r, 0, TAU);
            ctx.fillStyle = puff.gradient;
            ctx.fill();
            ctx.restore();
          });

          if (cloud.storm > 0.25) {
            // Тучу подсвечивает изнутри — так читается близкий разряд.
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            draw.glow(ctx, cloud.x, cloud.y, 90 * cloud.scale,
              'rgba(150, 180, 255, ALPHA)', cloud.storm * 0.16 * (0.6 + flash));
            ctx.restore();
          }
        });

        // Молнии поверх всего: разряд ярче любого облака.
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        bolts.forEach(function (bolt) {
          ctx.beginPath();
          ctx.moveTo(bolt.points[0].x, bolt.points[0].y);
          bolt.points.forEach(function (point) { ctx.lineTo(point.x, point.y); });

          ctx.strokeStyle = 'rgba(190, 214, 255, ' + (bolt.life * 0.5).toFixed(2) + ')';
          ctx.lineWidth = 7;
          ctx.stroke();

          ctx.strokeStyle = 'rgba(255, 255, 255, ' + bolt.life.toFixed(2) + ')';
          ctx.lineWidth = 2.2;
          ctx.stroke();
        });
        ctx.restore();

        // Вспышка разряда освещает весь кадр.
        if (flash > 0.02) {
          ctx.fillStyle = 'rgba(214, 228, 255, ' + (flash * 0.28).toFixed(3) + ')';
          ctx.fillRect(0, 0, width, height);
        }

        ctx.restore();

        // Подпись времени суток: без неё смысл перетаскивания солнца
        // приходится угадывать.
        ctx.font = '600 9.5px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255, 255, 255, ' + (0.3 + daylight * 0.35).toFixed(2) + ')';
        ctx.fillText(
          env.t('sky.' + state.name, state.name).toUpperCase(),
          14, height - 14
        );

        draw.vignette(ctx, width, height, 0.3 + storminess * 0.2);
      },

      draggables: function () { return []; },

      pointerDown: function (x, y) {
        pointer = { x: x, y: y };

        // Солнце проверяется первым: оно может оказаться за облаком, и
        // тогда нажатие по нему собирало бы тучу вместо перемещения.
        var dx = x - sun.x;
        var dy = y - sun.y;
        if (Math.sqrt(dx * dx + dy * dy) < sun.r * 2) {
          sun.dragging = true;
          return;
        }

        for (var i = clouds.length - 1; i >= 0; i -= 1) {
          var cloud = clouds[i];
          var span = 90 * cloud.scale;
          if (Math.abs(x - cloud.x) < span && Math.abs(y - cloud.y) < 46 * cloud.scale) {
            cloud.storm = Math.min(1, cloud.storm + 0.34);

            var now = performance.now();
            cloud.strikes = (now - cloud.lastStrike < STRIKE_WINDOW_MS)
              ? cloud.strikes + 1 : 1;
            cloud.lastStrike = now;

            for (var d = 0; d < 6; d += 1) { rain(cloud); }

            if (cloud.strikes >= STRIKES_FOR_BOLT) {
              strike(cloud, env.height);
              cloud.strikes = 0;
              cloud.storm = 1;
            }
            return;
          }
        }
      },

      pointerMove: function (x, y) {
        pointer = { x: x, y: y };
        if (!sun.dragging) { return; }

        // Положение на дуге восстанавливается по горизонтали: вести
        // солнце строго по кривой значило бы отрывать его от пальца.
        sun.t = u.clamp((x / env.width) * 1.1 - 0.05, 0, 1);
      },

      pointerUp: function () {
        sun.dragging = false;
        pointer = null;
      },

      celebrate: function (count) {
        // Награда разгоняет облака и возвращает ясный день: завершённый
        // квест должен ощущаться прояснением, а не грозой.
        clouds.forEach(function (cloud) {
          cloud.storm = Math.max(0, cloud.storm - 0.5);
        });
        sun.t = 0.5;

        for (var i = 0; i < u.clamp(count, 1, 4); i += 1) {
          clouds.push(makeCloud(-140, env.width, env.height));
        }
        while (clouds.length > 12) { clouds.shift(); }
      },

      destroy: function () {
        clouds = []; drops = []; bolts = []; stars = []; birds = [];
        sun.dragging = false; pointer = null; flash = 0; shake = 0;
      }
    };
  });
}(window));
