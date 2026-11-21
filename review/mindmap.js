/* Offline enhancement for the existing pre.mindmap trees. */
(function () {
  'use strict';

  // Destinations are existing review groups; descendants inherit their branch's group.
  var routes = {
    'fund-subject-1.html': {
      '市场与资管': 'section-19', '资产管理': 'section-7',
      '基金概述': 'section-46', '角色': 'section-84', '生命周期': 'section-84',
      '法律监管': 'section-98', '证监会行政监管': 'section-111',
      '基金参与主体': 'section-160', '基金活动': 'section-194',
      '经营管理': 'section-305', '职业规范与文化': 'section-414'
    },
    'fund-subject-3.html': {
      '认识基金': 'section-11', '谁来管': 'section-12',
      '产品是什么': 'section-13', '怎样募集与投资': 'section-14',
      '投后与退出': 'section-3', '投后：': 'section-14', '治理和运营': 'section-3'
    }
  };
  var pageRoutes = routes[location.pathname.split('/').pop()] || {};
  var serial = 0;

  function parse(text) {
    var lines = text.replace(/\r/g, '').split('\n').filter(function (line) { return line.trim(); });
    if (!lines.length) return null;
    var root = { text: lines[0].trim(), children: [] };
    var stack = [root];
    lines.slice(1).forEach(function (line) {
      var match = line.match(/^([│\s]*)([├└])─\s*(.*)$/);
      if (!match) {
        // Preserve wrapped explanatory lines as part of the preceding node.
        if (stack.length > 1) stack[stack.length - 1].text += ' ' + line.trim();
        return;
      }
      var depth = Math.floor(match[1].length / 3) + 1;
      depth = Math.min(depth, stack.length);
      var node = { text: match[3].trim(), children: [] };
      stack.length = depth;
      stack[depth - 1].children.push(node);
      stack.push(node);
    });
    return root;
  }

  function routeFor(text, fallback) {
    var key = Object.keys(pageRoutes).find(function (prefix) { return text.indexOf(prefix) === 0; });
    var id = key && pageRoutes[key];
    return id && document.getElementById(id) ? id : fallback;
  }

  function createNode(node, inherited, side, isRoot, redraw) {
    var item = document.createElement('li');
    item.className = 'mm-item';
    var row = document.createElement('div');
    row.className = 'mm-row';
    var target = routeFor(node.text, inherited);
    var label = document.createElement(target ? 'a' : 'span');
    label.className = 'mm-label' + (isRoot ? ' mm-root' : '');
    label.textContent = node.text;
    if (target) {
      label.href = '#' + target;
      label.title = '前往相关复习内容';
    }
    row.appendChild(label);
    item.appendChild(row);
    if (node.children.length) {
      var list = document.createElement('ul');
      list.className = 'mm-children';
      list.id = 'mm-children-' + (++serial);
      list.hidden = true;
      node.children.forEach(function (child) { list.appendChild(createNode(child, target, side, false, redraw)); });
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mm-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', list.id);
      toggle.setAttribute('aria-label', '展开' + node.text + '的分支');
      toggle.textContent = '+';
      toggle.addEventListener('click', function () {
        var open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        toggle.setAttribute('aria-label', (open ? '展开' : '收起') + node.text + '的分支');
        toggle.textContent = open ? '+' : '−';
        list.hidden = open;
        redraw();
      });
      row.appendChild(toggle);
      item.appendChild(list);
    }
    return item;
  }

  function init(pre) {
    if (pre.dataset.mmReady) return;
    var tree = parse(pre.textContent);
    if (!tree || !tree.children.length) return;
    var section = document.createElement('section');
    section.className = 'mm-widget';
    section.setAttribute('aria-label', '可交互思维导图');
    var help = document.createElement('p');
    help.className = 'mm-help';
    help.textContent = '点击主题前往相关复习内容；使用 + / − 展开或收起分支。手机可左右滑动，键盘可用 Tab 和回车操作。';
    section.appendChild(help);
    var viewport = document.createElement('div');
    viewport.className = 'mm-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', '思维导图，可横向滚动');
    var canvas = document.createElement('div');
    canvas.className = 'mm-canvas';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('mm-lines');
    svg.setAttribute('aria-hidden', 'true');
    canvas.appendChild(svg);
    var frame = 0;
    function redraw() {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(function () {
        frame = 0;
        var bounds = canvas.getBoundingClientRect();
        svg.setAttribute('width', canvas.offsetWidth);
        svg.setAttribute('height', canvas.offsetHeight);
        svg.replaceChildren();
        function connect(parent, item, side) {
          var row = item.querySelector(':scope > .mm-row');
          var a = parent.getBoundingClientRect();
          var b = row.getBoundingClientRect();
          var x1 = (side === 'left' ? a.left : a.right) - bounds.left;
          var x2 = (side === 'left' ? b.right : b.left) - bounds.left;
          var y1 = a.top + a.height / 2 - bounds.top;
          var y2 = b.top + b.height / 2 - bounds.top;
          var middle = (x1 + x2) / 2;
          var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + middle + ' ' + y1 + ', ' + middle + ' ' + y2 + ', ' + x2 + ' ' + y2);
          path.setAttribute('stroke', getComputedStyle(item).getPropertyValue('--branch').trim() || '#9771be');
          svg.appendChild(path);
          var children = item.querySelector(':scope > .mm-children');
          if (children && !children.hidden) Array.prototype.forEach.call(children.children, function (child) { connect(row, child, side); });
        }
        Array.prototype.forEach.call(left.children, function (item) { connect(center, item, 'left'); });
        Array.prototype.forEach.call(right.children, function (item) { connect(center, item, 'right'); });
      });
    }
    var left = document.createElement('ul');
    var right = document.createElement('ul');
    left.className = 'mm-side mm-left';
    right.className = 'mm-side mm-right';
    var split = Math.ceil(tree.children.length / 2);
    tree.children.forEach(function (child, index) {
      (index < split ? left : right).appendChild(createNode(child, null, index < split ? 'left' : 'right', false, redraw));
    });
    var center = document.createElement('div');
    center.className = 'mm-center mm-label mm-root';
    center.textContent = tree.text;
    canvas.appendChild(left);
    canvas.appendChild(center);
    canvas.appendChild(right);
    viewport.appendChild(canvas);
    section.appendChild(viewport);
    pre.parentNode.insertBefore(section, pre);
    pre.dataset.mmReady = 'true';
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(redraw).observe(canvas);
    window.addEventListener('resize', redraw);
    redraw();
    // Center the root when the map overflows, without affecting the original text tree.
    requestAnimationFrame(function () {
      var centerX = center.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft + center.offsetWidth / 2;
      viewport.scrollLeft = Math.max(0, centerX - viewport.clientWidth / 2);
    });
  }

  function start() { document.querySelectorAll('pre.mindmap').forEach(init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}());
