/**
 * MyQuestify — «Паутина рассуждений».
 *
 * Граф цепочки мыслей: квест в центре, шаги расходятся кольцами по уровням
 * вложенности. Узлы можно растаскивать — связи тянутся за ними.
 *
 * Раскладка радиальная, а не силовая. Силовой алгоритм каждый раз даёт
 * новую картинку, и пользователь теряет узнавание собственного плана;
 * радиальная детерминирована — один и тот же план всегда выглядит одинаково,
 * а разложить его по-своему можно руками.
 *
 * Экспортирует `window.ThoughtWeb`.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;

  var PALETTE = {
    root:      { fill: '#8b5cf6', glow: 'rgba(139, 92, 246, ALPHA)' },
    level1:    { fill: '#10b981', glow: 'rgba(16, 185, 129, ALPHA)' },
    level2:    { fill: '#38bdf8', glow: 'rgba(56, 189, 248, ALPHA)' },
    deep:      { fill: '#f59e0b', glow: 'rgba(245, 158, 11, ALPHA)' },
    done:      { fill: '#4b5563', glow: 'rgba(120, 130, 150, ALPHA)' }
  };

  var S = {
    canvas: null,
    ctx: null,
    host: null,
    nodes: [],
    links: [],
    width: 0,
    height: 0,
    dpr: 1,
    raf: 0,
    dragging: null,
    hovered: null,
    bound: false,
    tree: null,
    title: '',
    selected: null,
    onSelect: null
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Выбирает палитру узла по глубине и состоянию.
   * @param {Object} node
   * @returns {Object}
   */
  function paletteFor(node) {
    if (node.done) { return PALETTE.done; }
    if (node.depth === 0) { return PALETTE.root; }
    if (node.depth === 1) { return PALETTE.level1; }
    if (node.depth === 2) { return PALETTE.level2; }
    return PALETTE.deep;
  }

  /**
   * Раскладывает дерево по кольцам.
   *
   * Каждому поддереву выделяется угловой сектор, пропорциональный числу его
   * листьев: иначе ветка с десятью шагами и ветка с одним получили бы
   * одинаковый сектор, и первая слиплась бы в кашу.
   *
   * @param {Object[]} tree корневые узлы
   * @param {string} title название квеста
   */
  function layout(tree, title) {
    S.nodes = [];
    S.links = [];

    /**
     * Глубина самой длинной ветки — от неё зависит шаг колец.
     */
    function depthOf(nodes) {
      if (!nodes || !nodes.length) { return 0; }
      return 1 + nodes.reduce(function (deepest, node) {
        return Math.max(deepest, depthOf(node.children));
      }, 0);
    }

    // Место под подпись снизу и под саму подсказку внизу холста.
    var marginX = 70;
    var marginTop = 40;
    var marginBottom = 76;

    var centerX = S.width / 2;
    var centerY = marginTop + (S.height - marginTop - marginBottom) / 2;

    // Шаг колец считается от доступного радиуса, а не фиксированной долей
    // экрана: при фиксированном шаге третий уровень уезжал за край холста.
    var available = Math.min(
      (S.width - marginX * 2) / 2,
      (S.height - marginTop - marginBottom) / 2
    );
    var deepest = Math.max(1, depthOf(tree));
    var ring = Math.max(46, available / (deepest + 0.35));

    var root = {
      // null, а не строка: корневой шар — это сам квест, а не запись в БД.
      // Строковый идентификатор уходил на сервер как parent_id и ронял
      // валидацию с «Input should be a valid integer».
      id: null,
      isRoot: true,
      text: title,
      depth: 0,
      done: false,
      generated: false,
      x: centerX,
      y: centerY,
      r: clamp(Math.min(S.width, S.height) * 0.062, 26, 46)
    };
    S.nodes.push(root);

    /**
     * Считает количество листьев поддерева — ширину его сектора.
     */
    function leaves(nodes) {
      if (!nodes || !nodes.length) { return 1; }
      return nodes.reduce(function (sum, node) {
        return sum + leaves(node.children);
      }, 0);
    }

    /**
     * Рекурсивно размещает уровень внутри выделенного сектора.
     */
    function place(children, parent, depth, from, to) {
      if (!children || !children.length) { return; }

      var total = leaves(children);
      var cursor = from;

      children.forEach(function (child) {
        var span = ((to - from) * leaves(child.children)) / total;
        var angle = cursor + span / 2;
        var radius = ring * (depth + 0.15);
        var nodeRadius = clamp(Math.min(S.width, S.height) * (0.042 - depth * 0.005), 13, 30);

        var node = {
          id: child.id,
          text: child.text,
          depth: depth,
          done: child.done,
          generated: child.generated,
          // Итоговая позиция подрезается по холсту: у эллиптического
          // распределения крайние узлы иначе выходят за границу.
          x: clamp(centerX + Math.cos(angle) * radius,
                   nodeRadius + 6, S.width - nodeRadius - 6),
          y: clamp(centerY + Math.sin(angle) * radius,
                   nodeRadius + 6, S.height - marginBottom + 20),
          r: nodeRadius
        };

        S.nodes.push(node);
        S.links.push({ from: parent, to: node });
        place(child.children, node, depth + 1, cursor, cursor + span);
        cursor += span;
      });
    }

    // Стартовый угол сдвинут вверх: первая ветка оказывается над центром,
    // а не справа, и чтение начинается там, где взгляд по умолчанию.
    place(tree, root, 1, -Math.PI / 2, -Math.PI / 2 + TAU);
  }

  /** Подгоняет буфер холста под контейнер и плотность экрана. */
  function applySize() {
    var rect = S.host.getBoundingClientRect();
    S.width = Math.max(240, Math.round(rect.width));
    S.height = Math.max(240, Math.round(rect.height));
    S.dpr = clamp(global.devicePixelRatio || 1, 1, 2.5);

    S.canvas.width = Math.round(S.width * S.dpr);
    S.canvas.height = Math.round(S.height * S.dpr);
    S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  }

  /** Обрезает подпись под ширину узла. */
  function fitLabel(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) { return text; }
    var cut = text;
    while (cut.length > 1 && ctx.measureText(cut + '…').width > maxWidth) {
      cut = cut.slice(0, -1);
    }
    return cut + '…';
  }

  function render() {
    var ctx = S.ctx;
    ctx.clearRect(0, 0, S.width, S.height);

    var backdrop = ctx.createRadialGradient(
      S.width / 2, S.height / 2, 0,
      S.width / 2, S.height / 2, Math.max(S.width, S.height) * 0.7
    );
    backdrop.addColorStop(0, 'rgba(30, 26, 56, 0.55)');
    backdrop.addColorStop(1, 'rgba(10, 10, 16, 0.75)');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, S.width, S.height);

    // Связи: дуга, а не прямая — так пересечения читаются как разные нити.
    S.links.forEach(function (link) {
      var midX = (link.from.x + link.to.x) / 2;
      var midY = (link.from.y + link.to.y) / 2;
      var bend = 0.12;
      var controlX = midX + (link.to.y - link.from.y) * bend;
      var controlY = midY - (link.to.x - link.from.x) * bend;

      var active = S.hovered === link.to || S.hovered === link.from;
      var gradient = ctx.createLinearGradient(link.from.x, link.from.y, link.to.x, link.to.y);
      gradient.addColorStop(0, paletteFor(link.from).glow.replace('ALPHA', active ? 0.8 : 0.35));
      gradient.addColorStop(1, paletteFor(link.to).glow.replace('ALPHA', active ? 0.8 : 0.22));

      ctx.beginPath();
      ctx.moveTo(link.from.x, link.from.y);
      ctx.quadraticCurveTo(controlX, controlY, link.to.x, link.to.y);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = active ? 2.4 : 1.4;
      ctx.stroke();
    });

    S.nodes.forEach(function (node) {
      var palette = paletteFor(node);
      var chosen = node.id !== null && S.selected === node.id;
      var active = S.hovered === node || S.dragging === node || chosen;

      var glow = ctx.createRadialGradient(node.x, node.y, node.r * 0.4, node.x, node.y, node.r * 2.6);
      glow.addColorStop(0, palette.glow.replace('ALPHA', active ? 0.42 : 0.24));
      glow.addColorStop(1, palette.glow.replace('ALPHA', 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r * 2.6, 0, TAU);
      ctx.fill();

      var body = ctx.createRadialGradient(
        node.x - node.r * 0.35, node.y - node.r * 0.4, node.r * 0.1,
        node.x, node.y, node.r
      );
      body.addColorStop(0, 'rgba(255,255,255,0.35)');
      body.addColorStop(0.45, palette.fill);
      body.addColorStop(1, 'rgba(8, 8, 14, 0.9)');

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, TAU);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.strokeStyle = chosen ? 'rgba(255, 224, 130, 0.95)'
        : (active ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.22)');
      ctx.lineWidth = chosen ? 3 : (active ? 2 : 1);
      ctx.stroke();

      // Выбранный узел обведён пульсирующим кольцом: он станет родителем
      // следующей мысли, и это должно быть видно без подписи.
      if (chosen) {
        var pulse = 1 + Math.sin(performance.now() * 0.004) * 0.07;
        ctx.beginPath();
        ctx.arc(node.x, node.y, (node.r + 9) * pulse, 0, TAU);
        ctx.strokeStyle = 'rgba(255, 214, 110, 0.55)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Узел, предложенный моделью, помечен пунктирным кольцом: свои мысли
      // должны быть отличимы от машинных и здесь, а не только в списке.
      if (node.generated) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r + 4, 0, TAU);
        ctx.strokeStyle = 'rgba(196, 181, 253, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.font = (node.depth === 0 ? '600 12px ' : '500 11px ') +
        '"Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = node.done ? 'rgba(200,205,220,0.55)' : 'rgba(240,242,250,0.95)';
      ctx.fillText(
        fitLabel(ctx, node.text, Math.max(90, node.r * 5)),
        node.x, node.y + node.r + 6
      );
    });
  }

  function toScene(event) {
    var rect = S.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (S.width / rect.width),
      y: (event.clientY - rect.top) * (S.height / rect.height)
    };
  }

  /**
   * Ищет узел под точкой.
   * @returns {?Object}
   */
  function hitTest(x, y) {
    for (var i = S.nodes.length - 1; i >= 0; i -= 1) {
      var node = S.nodes[i];
      var dx = node.x - x;
      var dy = node.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= node.r + 6) { return node; }
    }
    return null;
  }

  function bindPointer() {
    if (S.bound) { return; }
    S.bound = true;

    S.canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) { return; }
      var point = toScene(event);
      S.dragging = hitTest(point.x, point.y);
      S.pressOrigin = point;
      S.moved = false;
      if (S.dragging) {
        try {
          S.canvas.setPointerCapture(event.pointerId);
        } catch (error) {
          /* захват необязателен */
        }
        event.preventDefault();
        render();
      }
    });

    S.canvas.addEventListener('pointermove', function (event) {
      var point = toScene(event);

      if (S.dragging) {
        if (S.pressOrigin &&
            (Math.abs(point.x - S.pressOrigin.x) > 4 ||
             Math.abs(point.y - S.pressOrigin.y) > 4)) {
          S.moved = true;
        }
        S.dragging.x = clamp(point.x, S.dragging.r, S.width - S.dragging.r);
        S.dragging.y = clamp(point.y, S.dragging.r, S.height - S.dragging.r);
        render();
        return;
      }

      var hovered = hitTest(point.x, point.y);
      if (hovered !== S.hovered) {
        S.hovered = hovered;
        S.canvas.style.cursor = hovered ? 'grab' : 'default';
        render();
      }
    });

    function release(event) {
      if (!S.dragging) { return; }

      // Клик без движения — выбор узла; со сдвигом — это было перетаскивание,
      // и выбор менять нельзя, иначе любая перестановка сбивала бы цель.
      if (!S.moved) {
        var node = S.dragging;
        // Клик по корню снимает выбор: вложить мысль «в сам квест» —
        // это и есть верхний уровень.
        var next = (node.isRoot || S.selected === node.id) ? null : node.id;
        S.selected = next;
        if (typeof S.onSelect === 'function') {
          S.onSelect(next, next ? node.text : null);
        }
      }

      S.dragging = null;
      S.pressOrigin = null;
      try {
        S.canvas.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* уже отпущен */
      }
      render();
    }

    S.canvas.addEventListener('pointerup', release);
    S.canvas.addEventListener('pointercancel', release);
  }

  global.ThoughtWeb = {
    /**
     * Рисует паутину для дерева мыслей.
     *
     * @param {HTMLCanvasElement} canvas холст
     * @param {HTMLElement} host контейнер, задающий размер
     * @param {Object[]} tree дерево узлов с сервера
     * @param {string} title название квеста для центрального узла
     */
    render: function (canvas, host, tree, title, onSelect) {
      S.canvas = canvas;
      S.host = host;
      S.ctx = canvas.getContext('2d');
      S.hovered = null;
      S.dragging = null;
      if (onSelect) { S.onSelect = onSelect; }

      S.tree = tree || [];
      S.title = title || 'Квест';

      applySize();
      layout(S.tree, S.title);
      bindPointer();
      render();
    },

    /**
     * Снимает или задаёт выбор узла извне.
     * @param {?number} id идентификатор узла либо null
     */
    select: function (id) {
      S.selected = id;
      if (S.ctx) { render(); }
    },

    /** Идентификатор выбранного узла. */
    selected: function () { return S.selected; },

    /** Пересчитывает размер после показа скрытого контейнера. */
    resize: function () {
      if (!S.canvas || !S.host || !S.tree) { return; }

      var before = { width: S.width, height: S.height };
      applySize();

      // Позиции узлов пропорционально переносятся в новый холст: раскладка
      // пересобирается только при заметной смене размера, иначе руками
      // расставленная картина сбрасывалась бы на каждый ресайз.
      if (before.width && Math.abs(before.width - S.width) < 2 &&
          Math.abs(before.height - S.height) < 2) {
        render();
        return;
      }

      layout(S.tree, S.title);
      render();
    }
  };
}(window));
