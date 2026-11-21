/* 基金记忆闯关：读取当前页面，不修改原始题库。 */
(function () {
  'use strict';
  var rootId = 'fund-review-quiz';
  var topics3 = ['基金基础与运作', '基金基础与运作', '监管与管理人', '监管与管理人', '监管与管理人', '基金组织形式', '投资策略与流程', '投资策略与流程', '投资策略与流程', '历史与业绩', '历史与业绩', '退出与清算', '存疑与核查'];
  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  // 基于题面和来源生成稳定键；不依赖页面标题编号或题目顺序。
  function stableId(text) {
    var normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    var a = 2166136261, b = 2246822519;
    for (var i = 0; i < normalized.length; i++) {
      a = Math.imul(a ^ normalized.charCodeAt(i), 16777619);
      b = Math.imul(b ^ normalized.charCodeAt(i), 3266489917);
    }
    return 'q-' + (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
  }
  function extractOne() {
    var start = document.getElementById('section-6');
    if (!start || !/逐题主动回忆/.test(start.textContent)) return [];
    var result = [], topic = '';
    for (var node = start.nextElementSibling; node && node.tagName !== 'H2'; node = node.nextElementSibling) {
      if (node.tagName === 'H3') topic = node.textContent.trim();
      if (node.tagName !== 'H4') continue;
      var title = node, pieces = [], details = null;
      while (node.nextElementSibling && !/^H[234]$/.test(node.nextElementSibling.tagName)) {
        node = node.nextElementSibling;
        if (node.tagName === 'DETAILS') details = node;
        else pieces.push(node.cloneNode(true));
      }
      if (!details) continue;
      var answer = element('div');
      Array.prototype.forEach.call(details.children, function (child) { if (child.tagName !== 'SUMMARY') answer.appendChild(child.cloneNode(true)); });
      var source = pieces.map(function (part) { return part.querySelector('a[href]'); }).filter(Boolean)[0];
      var questionText = pieces.filter(function (part) { return !part.querySelector('a[href]'); }).map(function (part) { return part.textContent; }).join(' ');
      result.push({ id: stableId(questionText + '|' + (source ? source.getAttribute('href') : '')), topic: topic, title: title.textContent.trim(), question: pieces, answer: answer, doubtful: /存疑|❓/.test(title.textContent + ' ' + details.textContent) });
    }
    return result;
  }
  function extractThree() {
    var heading = document.getElementById('section-7'), answersHeading = document.getElementById('section-8');
    if (!heading || !answersHeading || !/主动回忆/.test(heading.textContent)) return [];
    var questions = heading.nextElementSibling, answers = answersHeading.nextElementSibling;
    if (!questions || !answers || questions.tagName !== 'OL' || answers.tagName !== 'OL' || questions.children.length !== answers.children.length) return [];
    return Array.prototype.map.call(questions.children, function (question, index) {
      var answer = answers.children[index], wrap = element('div'), p = element('p');
      p.innerHTML = answer.innerHTML; wrap.appendChild(p);
      if (index === 12) { var link = element('a', '', '查看存疑与未核实清单'); link.href = '#section-9'; wrap.appendChild(link); }
      return { id: stableId(question.textContent), topic: topics3[index] || '其他', title: '自测 ' + (index + 1), question: [element('p', '', question.textContent)], answer: wrap, doubtful: /存疑|待核实|待独立核验|尚需核实|管理人登记与产品备案分别对应什么对象/.test(question.textContent + answer.textContent) };
    });
  }
  function init() {
    if (document.getElementById(rootId)) return;
    var cards = extractOne(), subject = '1';
    if (!cards.length) { cards = extractThree(); subject = '3'; }
    if (!cards.length) return;
    var article = document.querySelector('main article');
    if (!article) return;
    var key = 'fund-review-quiz-v2-subject-' + subject, state = { marks: {}, topic: '', index: 0 }, storageAvailable = true;
    try {
      var saved = JSON.parse(localStorage.getItem(key) || '{}');
      if (saved && saved.marks && typeof saved.marks === 'object' && !Array.isArray(saved.marks)) state.marks = saved.marks;
      if (saved && typeof saved.topic === 'string') state.topic = saved.topic;
      if (saved && Number.isInteger(saved.index)) state.index = saved.index;
    } catch (_) { storageAvailable = false; }
    var topics = Array.from(new Set(cards.map(function (card) { return card.topic; })));
    if (topics.indexOf(state.topic) < 0) state.topic = topics[0];
    var panel = element('section', 'fund-quiz'); panel.id = rootId;
    panel.setAttribute('aria-label', '记忆闯关');
    var top = element('div', 'fq-top');
    var intro = element('div'); intro.appendChild(element('span', 'fq-eyebrow', '主动回忆 · 每次一题'));
    intro.appendChild(element('h2', 'fq-heading', '记忆闯关'));
    intro.appendChild(element('p', 'fq-intro', (subject === '3' ? '本科共 13 条主动回忆自测；51 条原题索引请在下方查阅。' : '本科共 ' + cards.length + ' 条主动回忆题。') + '选择主题，先回忆再翻看答案。进度仅保存在本设备，按科目分别记录。'));
    top.appendChild(intro); panel.appendChild(top);
    var controls = element('div', 'fq-controls'), label = element('label', '', '选择主题'); label.htmlFor = 'fq-topic';
    var select = element('select'); select.id = 'fq-topic';
    topics.forEach(function (topic) { var option = element('option', '', topic); option.value = topic; select.appendChild(option); });
    label.appendChild(select); controls.appendChild(label);
    var reset = element('button', 'fq-reset', '重置本科进度'); reset.type = 'button'; controls.appendChild(reset); panel.appendChild(controls);
    var status = element('p', 'fq-status'); status.setAttribute('role', 'status'); panel.appendChild(status);
    var progress = element('progress', 'fq-progress'); progress.setAttribute('aria-label', '本主题已处理进度'); panel.appendChild(progress);
    var cardView = element('div', 'fq-card'); panel.appendChild(cardView);
    var note = element('p', 'fq-note'); panel.appendChild(note);
    article.insertBefore(panel, article.firstChild.nextSibling);
    function save() {
      try { localStorage.setItem(key, JSON.stringify(state)); storageAvailable = true; }
      catch (_) { storageAvailable = false; }
    }
    function markText(value) { return value === 'remembered' ? '记住了' : value === 'again' ? '再练一次' : value === 'reviewed' ? '已查看，待核查' : '未处理'; }
    function render() {
      select.value = state.topic;
      var group = cards.filter(function (card) { return card.topic === state.topic; });
      state.index = Math.max(0, Math.min(state.index, group.length - 1));
      var card = group[state.index], done = group.filter(function (item) { return !!state.marks[item.id]; }).length;
      var remembered = group.filter(function (item) { return state.marks[item.id] === 'remembered'; }).length;
      status.textContent = '本主题第 ' + (state.index + 1) + ' / ' + group.length + ' 题 · 已处理 ' + done + ' / ' + group.length + ' · 记住 ' + remembered;
      progress.max = group.length; progress.value = done;
      note.textContent = storageAvailable ? '“再练一次”会保留标记，可通过下一题继续并随时返回；存疑题只记录查看状态，不计入记住数。' : '浏览器不允许保存本地进度；本次可继续练习，关闭页面后进度可能丢失。';
      cardView.replaceChildren();
      var meta = element('div', 'fq-meta'); meta.appendChild(element('span', '', card.title)); meta.appendChild(element('span', 'fq-mark', markText(state.marks[card.id]))); cardView.appendChild(meta);
      if (card.doubtful) cardView.appendChild(element('p', 'fq-warning', '⚠️ 存疑或待核实：请回查来源，不作为确定结论或判分依据。'));
      var question = element('div', 'fq-question'); card.question.forEach(function (piece) { question.appendChild(piece.cloneNode(true)); }); cardView.appendChild(question);
      var reveal = element('button', 'fq-primary', '翻看参考答案'); reveal.type = 'button'; reveal.setAttribute('aria-expanded', 'false'); cardView.appendChild(reveal);
      var answer = element('div', 'fq-answer'); answer.hidden = true; answer.appendChild(element('h3', '', '参考答案与解析')); answer.appendChild(card.answer.cloneNode(true)); cardView.appendChild(answer);
      var actions = element('div', 'fq-actions'); actions.hidden = true;
      function mark(value) { state.marks[card.id] = value; save(); render(); cardView.querySelector('.fq-navigation button:last-child').focus(); }
      if (card.doubtful) {
        var reviewed = element('button', 'fq-secondary', '已查看，待核查'); reviewed.type = 'button'; reviewed.addEventListener('click', function () { mark('reviewed'); }); actions.appendChild(reviewed);
      } else {
        var rememberedButton = element('button', 'fq-primary', '记住了'); rememberedButton.type = 'button'; rememberedButton.addEventListener('click', function () { mark('remembered'); }); actions.appendChild(rememberedButton);
        var again = element('button', 'fq-secondary', '再练一次'); again.type = 'button'; again.addEventListener('click', function () { mark('again'); }); actions.appendChild(again);
      }
      cardView.appendChild(actions);
      reveal.addEventListener('click', function () { answer.hidden = false; actions.hidden = false; reveal.hidden = true; reveal.setAttribute('aria-expanded', 'true'); });
      var navigation = element('div', 'fq-navigation');
      var previous = element('button', 'fq-secondary', '上一题'); previous.type = 'button'; previous.disabled = state.index === 0;
      previous.addEventListener('click', function () { state.index--; save(); render(); cardView.querySelector('.fq-primary').focus(); }); navigation.appendChild(previous);
      var next = element('button', 'fq-secondary', state.index === group.length - 1 ? '回到本主题第一题' : '下一题'); next.type = 'button';
      next.addEventListener('click', function () { state.index = (state.index + 1) % group.length; save(); render(); cardView.querySelector('.fq-primary').focus(); }); navigation.appendChild(next); cardView.appendChild(navigation);
    }
    select.addEventListener('change', function () { state.topic = select.value; state.index = 0; save(); render(); });
    reset.addEventListener('click', function () { if (window.confirm('确定重置本科目的记忆闯关进度吗？')) { state.marks = {}; state.index = 0; save(); render(); } });
    render();
  }
  window.FundReviewQuiz = { init: init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
