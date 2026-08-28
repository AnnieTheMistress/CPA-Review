const STORAGE_KEY = "exam-review-state-v2";
const LEGACY_STORAGE_KEY = "cpa-review-state-v1";

const app = {
  data: [],
  exams: [],
  examId: "cpa",
  byId: new Map(),
  view: "practice",
  queue: [],
  cursor: 0,
  selected: new Set(),
  submitted: false,
  reveal: false,
  knowledgeState: new Map(),
  catalog: { subject: null, chapter: null, knowledge: null },
  filters: { subject: "", chapter: "", type: "", status: "" },
  state: loadState(),
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.version === 2 && saved.exams) return saved;
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)) || {};
    const migrated = {
      version: 2,
      currentExam: "cpa",
      exams: { cpa: { questions: legacy.questions || {}, session: legacy.session || null } },
      migratedLegacy: true,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return { version: 2, currentExam: "cpa", exams: { cpa: { questions: {}, session: null } }, migratedLegacy: true };
  }
}

function saveState() {
  app.state.currentExam = app.examId;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(app.state));
}

function examState() {
  app.state.exams[app.examId] ||= { questions: {}, session: null };
  return app.state.exams[app.examId];
}

function progressFor(id) {
  return examState().questions[id] || { attempts: 0, correct: 0, mastery: "未掌握", favorite: false, retry: false };
}

function updateProgress(id, patch) {
  examState().questions[id] = { ...progressFor(id), ...patch };
  saveState();
}

function resolveAlias(id, aliases) {
  let resolved = id;
  const visited = new Set();
  while (aliases[resolved] && !visited.has(resolved)) {
    visited.add(resolved);
    resolved = aliases[resolved];
  }
  return resolved;
}

function mergeProgress(left = {}, right = {}) {
  const masteryRank = { "未掌握": 0, "复习中": 1, "已掌握": 2 };
  const ordered = [left, right].sort((a, b) => String(a.lastReviewed || "").localeCompare(String(b.lastReviewed || "")));
  const latest = ordered[ordered.length - 1];
  return {
    ...left,
    ...right,
    attempts: (left.attempts || 0) + (right.attempts || 0),
    correct: (left.correct || 0) + (right.correct || 0),
    favorite: Boolean(left.favorite || right.favorite),
    retry: Boolean(left.retry || right.retry),
    mastery: masteryRank[left.mastery] > masteryRank[right.mastery] ? left.mastery : (right.mastery || left.mastery || "未掌握"),
    lastAnswer: latest.lastAnswer,
    lastReviewed: latest.lastReviewed,
    dailyResults: { ...(left.dailyResults || {}), ...(right.dailyResults || {}) },
    stage: Number.isInteger(latest.stage) ? latest.stage : (left.stage ?? right.stage),
    dueDate: latest.dueDate || left.dueDate || right.dueDate,
    mastered: Boolean(left.mastered || right.mastered),
  };
}

function migrateAliases(aliases) {
  const state = examState();
  for (const [oldId, targetId] of Object.entries(aliases)) {
    const resolved = resolveAlias(targetId, aliases);
    if (state.questions[oldId]) {
      state.questions[resolved] = mergeProgress(state.questions[resolved], state.questions[oldId]);
      delete state.questions[oldId];
    }
  }
  if (state.session) {
    state.session.currentId = resolveAlias(state.session.currentId, aliases);
    state.session.queue = (state.session.queue || []).map(id => resolveAlias(id, aliases));
  }
  saveState();
}

function saveSession() {
  if (!app.data.length) return;
  examState().session = {
    filters: { ...app.filters },
    queue: [...app.queue],
    currentId: app.queue[app.cursor] || null,
    day: ReviewScheduler.beijingDate(),
  };
  saveState();
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function markdown(value = "") {
  const lines = value.replace(/\r/g, "").split("\n");
  const output = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\|.*\|$/.test(line.trim()) && /^\|?\s*:?-+/.test((lines[index + 1] || "").trim())) {
      flush();
      const table = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) table.push(lines[index++]);
      index -= 1;
      const rows = table.filter((_, row) => row !== 1).map(row => row.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim()));
      output.push(`<div class="table-scroll"><table>${rows.map((cells, row) => `<tr>${cells.map(cell => row === 0 ? `<th>${inlineMarkdown(cell)}</th>` : `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</table></div>`);
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return output.join("");
}

function filteredQuestions(extra = {}) {
  const filters = { ...app.filters, ...extra };
  return app.data.filter(question => {
    const progress = progressFor(question.id);
    return (!filters.subject || question.subject === filters.subject)
      && (!filters.chapter || question.chapter === filters.chapter)
      && (!filters.type || question.type === filters.type)
      && (!filters.status || (filters.status === "收藏" ? progress.favorite : filters.status === "待重做" ? progress.retry : progress.mastery === filters.status));
  });
}

function catalogQuestionType(question) {
  if (question.answerMode === "single") return "单选题";
  if (question.answerMode === "multiple") return "多选题";
  return "主观题";
}

function resetQuestionState(id = app.queue[app.cursor]) {
  const progress = id ? progressFor(id) : {};
  const reviewedToday = progress.lastReviewed && ReviewScheduler.beijingDate(progress.lastReviewed) === ReviewScheduler.beijingDate();
  app.selected = new Set(reviewedToday ? (progress.lastAnswer || []) : []);
  app.submitted = Boolean(reviewedToday && progress.lastAnswer);
  app.reveal = false;
}

function setQueue(questions, startId = null) {
  app.queue = questions.map(item => item.id);
  app.cursor = Math.max(0, startId ? app.queue.indexOf(startId) : 0);
  resetQuestionState();
  saveSession();
}

function restoreSession() {
  const session = examState().session;
  if (!session) {
    setQueue(dailyQuestions());
    return;
  }
  app.filters = { ...app.filters, ...(session.filters || {}) };
  const sameDay = session.day === ReviewScheduler.beijingDate();
  const saved = sameDay ? (session.queue || []).map(id => app.byId.get(id)).filter(Boolean) : [];
  const queue = saved.length ? saved : dailyQuestions();
  setQueue(queue.length ? queue : app.data, sameDay ? session.currentId : null);
  if (app.cursor < 0) app.cursor = 0;
}

function dailyQuestions() {
  const filtered = filteredQuestions();
  return ReviewScheduler.buildDailyQueue(filtered, examState().questions);
}

function recomputeKnowledgeState() {
  const groups = new Map();
  for (const question of app.data) {
    const key = `${question.subject}|${question.chapter}|${question.knowledge}`;
    groups.set(key, [...(groups.get(key) || []), question]);
  }
  app.knowledgeState = new Map(
    [...groups].map(([key, questions]) => [key, ReviewScheduler.knowledgeMastered(questions, examState().questions)])
  );
}

function currentQuestion() {
  if (!app.queue.length) setQueue(filteredQuestions());
  return app.byId.get(app.queue[app.cursor]);
}

function renderQuestionText(question) {
  let text = question.question;
  for (const option of question.options) {
    const pattern = new RegExp(`(^|\\n)${option.key}[.．、]\\s*[\\s\\S]*?(?=(\\n[A-H][.．、])|$)`, "m");
    text = text.replace(pattern, "");
  }
  return markdown(text.trim());
}

function answerPanel(question) {
  if (!app.submitted && !app.reveal) return `<div class="answer-placeholder">提交答案后显示核对与解析</div>`;
  const correct = sameKeys([...app.selected], question.correctKeys);
  const result = question.uncertain
    ? `<div class="result uncertain">答案标记存疑 · 原答案 ${escapeHtml(question.correctAnswer)}</div>`
    : app.submitted
      ? `<div class="result ${correct ? "" : "wrong"}">${correct ? "回答正确" : `回答错误 · 正确答案 ${escapeHtml(question.correctAnswer)}`}</div>`
      : `<div class="result">参考答案 ${escapeHtml(question.correctAnswer || "见解析")}</div>`;
  return `${result}
    ${section("我的答案", question.myAnswer)}
    ${section("我的错因", question.reason)}
    ${section("核对意见", question.check)}
    ${section("解析", question.analysis)}`;
}

function section(title, content) {
  return content ? `<section class="answer-section"><h3>${title}</h3><div class="markdown">${markdown(content)}</div></section>` : "";
}

function sameKeys(left, right) {
  return [...left].sort().join("") === [...right].sort().join("");
}

function renderPractice() {
  const question = currentQuestion();
  if (!question) return renderEmpty("当前筛选下没有题目");
  const progress = progressFor(question.id);
  const options = question.options.map(option => {
    const selected = app.selected.has(option.key);
    const graded = app.submitted ? question.correctKeys.includes(option.key) ? "correct" : selected ? "wrong" : "" : "";
    const control = selected ? (question.answerMode === "multiple" ? "✓" : "•") : "";
    return `<button class="option ${question.answerMode} ${selected ? "selected" : ""} ${graded}" data-option="${option.key}" ${app.submitted ? "disabled" : ""}><span class="choice-control" aria-hidden="true">${control}</span><span class="option-key">${option.key}</span><span>${inlineMarkdown(option.text)}</span></button>`;
  }).join("");
  const typeLabel = question.answerMode === "multiple" ? "多选题 · 可选择多个答案" : question.answerMode === "single" ? "单选题" : question.type;
  document.querySelector("#main").innerHTML = `<div class="practice">
    <div class="practice-head"><div class="eyebrow">${escapeHtml(question.subject)} · ${escapeHtml(question.chapter)} · ${escapeHtml(question.knowledge)}</div><div class="counter">${app.cursor + 1} / ${app.queue.length}</div></div>
    <div class="split-question">
      <section class="question-pane">
        <div class="question-type ${question.answerMode}">${escapeHtml(typeLabel)}</div>
        <div class="markdown">${renderQuestionText(question)}</div>
        ${question.interactive ? `<div class="options ${question.answerMode}">${options}</div>` : ""}
        <div class="question-actions">
          ${question.interactive ? app.submitted ? `<button class="secondary-button" data-action="retry-question">重新作答</button>` : `<button class="primary-button" data-action="submit" ${!app.selected.size ? "disabled" : ""}>提交答案</button>` : `<button class="primary-button" data-action="reveal">${app.reveal ? "收起解析" : "展开答案与解析"}</button>`}
          <button class="compact-button ${progress.favorite ? "active" : ""}" data-action="favorite">${progress.favorite ? "★ 已收藏" : "☆ 收藏"}</button>
          <span class="spacer"></span>
          <button class="secondary-button" data-action="previous" ${app.cursor === 0 ? "disabled" : ""}>←</button>
          <button class="secondary-button" data-action="next" ${app.cursor >= app.queue.length - 1 ? "disabled" : ""}>→</button>
        </div>
      </section>
      <aside class="answer-pane">${answerPanel(question)}</aside>
    </div>
  </div>`;
}

function renderCatalog() {
  const main = document.querySelector("#main");
  const path = app.catalog;
  const base = app.data;
  const breadcrumb = [`<button data-catalog-level="root">全部科目</button>`];
  if (path.subject) breadcrumb.push(`<span>›</span><button data-catalog-level="subject">${escapeHtml(path.subject)}</button>`);
  if (path.chapter) breadcrumb.push(`<span>›</span><button data-catalog-level="chapter">${escapeHtml(path.chapter)}</button>`);
  if (path.knowledge) breadcrumb.push(`<span>›</span><span>${escapeHtml(path.knowledge)}</span>`);
  let content;
  if (!path.subject) {
    content = directoryItems(group(base, "subject"), "subject");
  } else if (!path.chapter) {
    content = directoryItems(group(base.filter(q => q.subject === path.subject), "chapter"), "chapter");
  } else {
    const questions = base.filter(q => q.subject === path.subject && q.chapter === path.chapter);
    content = catalogQuestionGroups(questions);
  }
  main.innerHTML = `<section class="catalog"><h1 class="page-title">错题目录</h1><p class="page-subtitle">${app.data.length} 道已归档错题</p><div class="breadcrumbs">${breadcrumb.join("")}</div>${content}</section>`;
}

function catalogQuestionGroups(questions) {
  const order = ["单选题", "多选题", "主观题"];
  return `<div class="catalog-question-groups">${order.map(type => {
    const items = questions.filter(question => catalogQuestionType(question) === type);
    if (!items.length) return "";
    return `<section class="catalog-question-group"><div class="catalog-group-head"><h2>${type}</h2><span>${items.length} 道</span></div><div class="question-list">${items.map((question, index) => questionRow(question, index + 1)).join("")}</div></section>`;
  }).join("")}</div>`;
}

function group(items, key) {
  const grouped = new Map();
  for (const item of items) grouped.set(item[key], [...(grouped.get(item[key]) || []), item]);
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
}

function directoryItems(groups, level) {
  return `<div class="directory-grid">${groups.map(([name, items]) => {
    return `<button class="directory-item" data-catalog-pick="${level}" data-value="${escapeHtml(name)}"><h3>${escapeHtml(name)}</h3><p>${items.length} 道</p></button>`;
  }).join("")}</div>`;
}

function questionRow(question, number = null) {
  const prefix = number === null ? "" : `<span class="question-number">${number}.</span>`;
  return `<button class="question-row" data-open-question="${question.id}"><span class="question-row-main">${prefix}<span><strong>${escapeHtml(question.title)}</strong><br><small>${escapeHtml(question.knowledge)}</small></span></span><span class="badge ${question.uncertain ? "warn" : ""}">${question.uncertain ? "存疑" : question.interactive ? "可作答" : "查阅"}</span></button>`;
}

function renderFavorites() {
  const items = app.data.filter(item => progressFor(item.id).favorite);
  document.querySelector("#main").innerHTML = `<section class="catalog"><h1 class="page-title">收藏</h1><p class="page-subtitle">${items.length} 道</p>${items.length ? `<div class="question-list">${items.map(questionRow).join("")}</div>` : renderEmpty("还没有收藏题目", false)}</section>`;
}

function renderProgress() {
  const states = app.data.map(item => progressFor(item.id));
  const attempted = states.filter(item => item.attempts).length;
  const totalAttempts = states.reduce((sum, item) => sum + item.attempts, 0);
  const correct = states.reduce((sum, item) => sum + item.correct, 0);
  const retry = states.filter(item => item.retry).length;
  const favorites = states.filter(item => item.favorite).length;
  const subjectBars = group(app.data, "subject").map(([subject, items]) => {
    const done = items.filter(item => (progressFor(item.id).attempts || 0) > 0).length;
    const percent = items.length ? Math.round(done / items.length * 100) : 0;
    return `<div class="bar-row"><span>${subject}</span><div class="bar"><i style="width:${percent}%"></i></div><b>${percent}%</b></div>`;
  }).join("");
  document.querySelector("#main").innerHTML = `<div class="progress-grid">
    ${metric("已作答", attempted)}${metric("正确率", totalAttempts ? `${Math.round(correct / totalAttempts * 100)}%` : "0%")} ${metric("待重做", retry)}${metric("已收藏", favorites)}
  </div><section class="progress-section"><h2>科目作答进度</h2>${subjectBars}</section>
  <section class="progress-section"><h2>本地进度</h2><div class="question-actions"><button class="secondary-button" data-action="export">导出进度</button><button class="secondary-button" data-action="import">导入进度</button></div></section>`;
}

function metric(label, value) {
  return `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`;
}

function renderEmpty(message, wrapper = true) {
  const html = `<div class="empty">${message}</div>`;
  if (wrapper) document.querySelector("#main").innerHTML = html;
  return html;
}

function render() {
  document.querySelectorAll(".bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.view === app.view));
  if (app.view === "practice") renderPractice();
  if (app.view === "catalog") renderCatalog();
  if (app.view === "favorites") renderFavorites();
  if (app.view === "progress") renderProgress();
}

function submitAnswer(question) {
  app.submitted = true;
  const correct = sameKeys([...app.selected], question.correctKeys);
  const previous = progressFor(question.id);
  const reviewed = ReviewScheduler.updateReview(previous, correct);
  delete reviewed.effective;
  updateProgress(question.id, { ...reviewed, attempts: previous.attempts + 1, correct: previous.correct + (correct ? 1 : 0), retry: !correct, lastAnswer: [...app.selected], lastReviewed: new Date().toISOString() });
  recomputeKnowledgeState();
  render();
}

function navigateQuestion(delta) {
  app.cursor = Math.min(Math.max(0, app.cursor + delta), app.queue.length - 1);
  resetQuestionState();
  saveSession();
  render();
}

function openQuestion(id) {
  setQueue(filteredQuestions(), id);
  if (!app.queue.includes(id)) setQueue(app.data, id);
  app.view = "practice";
  saveSession();
  render();
}

function renderFilters() {
  const subjects = [...new Set(app.data.map(item => item.subject))];
  const chapters = [...new Set(app.data.filter(item => !app.filters.subject || item.subject === app.filters.subject).map(item => item.chapter))];
  document.querySelector("#filter-content").innerHTML = `${selectGroup("科目", "subject", ["", ...subjects])}${selectGroup("章节", "chapter", ["", ...chapters])}${selectGroup("题型", "type", ["", "客观", "综合"])}${selectGroup("状态", "status", ["", "待重做", "收藏"])}<div class="filter-actions"><button class="secondary-button" data-action="clear-filters">清除</button><button class="primary-button" data-action="apply-filters">应用</button></div>`;
}

function selectGroup(label, key, values) {
  return `<div class="filter-group"><label for="filter-${key}">${label}</label><select class="select-input" id="filter-${key}" data-filter="${key}">${values.map(value => `<option value="${escapeHtml(value)}" ${app.filters[key] === value ? "selected" : ""}>${escapeHtml(value || "全部")}</option>`).join("")}</select></div>`;
}

function search(query) {
  const normalized = query.trim().toLowerCase();
  const results = normalized ? app.data.filter(item => [item.question, item.knowledge, item.reason, item.analysis].some(value => (value || "").toLowerCase().includes(normalized))).slice(0, 60) : [];
  document.querySelector("#search-results").innerHTML = results.map(item => `<button class="search-result" data-open-question="${item.id}"><strong>${escapeHtml(item.title)}</strong><br><small>${escapeHtml(item.subject)} · ${escapeHtml(item.knowledge)}</small></button>`).join("");
}

function exportProgress() {
  const blob = new Blob([JSON.stringify(app.state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `错题复习进度-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) { app.view = button.dataset.view; render(); return; }
  if (button.dataset.option) {
    const question = currentQuestion();
    if (question.answerMode === "single") app.selected = new Set([button.dataset.option]);
    else app.selected.has(button.dataset.option) ? app.selected.delete(button.dataset.option) : app.selected.add(button.dataset.option);
    render(); return;
  }
  if (button.dataset.mastery) { updateProgress(currentQuestion().id, { mastery: button.dataset.mastery }); render(); return; }
  if (button.dataset.openQuestion) { document.querySelector("#search-dialog").close(); openQuestion(button.dataset.openQuestion); return; }
  if (button.dataset.catalogPick) { app.catalog[button.dataset.catalogPick] = button.dataset.value; render(); return; }
  if (button.dataset.catalogLevel === "root") app.catalog = { subject: null, chapter: null, knowledge: null };
  if (button.dataset.catalogLevel === "subject") app.catalog = { ...app.catalog, chapter: null, knowledge: null };
  if (button.dataset.catalogLevel === "chapter") app.catalog.knowledge = null;
  if (button.dataset.catalogLevel) { render(); return; }
  const action = button.dataset.action;
  if (action === "submit") submitAnswer(currentQuestion());
  if (action === "retry-question") { app.selected = new Set(); app.submitted = false; app.reveal = false; render(); }
  if (action === "reveal") { app.reveal = !app.reveal; render(); }
  if (action === "favorite") { const q = currentQuestion(); updateProgress(q.id, { favorite: !progressFor(q.id).favorite }); render(); }
  if (action === "previous") navigateQuestion(-1);
  if (action === "next") navigateQuestion(1);
  if (action === "home") { app.view = "practice"; render(); }
  if (action === "search") { document.querySelector("#search-dialog").showModal(); document.querySelector("#search-input").focus(); }
  if (action === "filters") { renderFilters(); document.querySelector("#filter-dialog").showModal(); }
  if (action === "clear-filters") { app.filters = { subject: "", chapter: "", type: "", status: "" }; renderFilters(); }
  if (action === "apply-filters") { setQueue(filteredQuestions()); document.querySelector("#filter-dialog").close(); app.view = "practice"; saveSession(); render(); }
  if (action === "export") exportProgress();
  if (action === "import") document.querySelector("#import-file").click();
});

document.addEventListener("change", event => {
  if (event.target.id === "exam-select") switchExam(event.target.value);
  if (event.target.dataset.filter) { app.filters[event.target.dataset.filter] = event.target.value; if (event.target.dataset.filter === "subject") app.filters.chapter = ""; renderFilters(); }
  if (event.target.id === "import-file" && event.target.files[0]) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const imported = JSON.parse(reader.result);
        app.state = imported.version === 2 && imported.exams
          ? imported
          : { version: 2, currentExam: "cpa", exams: { cpa: { questions: imported.questions || {}, session: imported.session || null } }, migratedLegacy: true };
        saveState();
        await loadExam(app.state.currentExam || "cpa");
      } catch {
        alert("进度文件无法读取");
      }
    };
    reader.readAsText(event.target.files[0]);
  }
});

document.querySelector("#search-input").addEventListener("input", event => search(event.target.value));

function renderExamSelector() {
  const select = document.querySelector("#exam-select");
  select.innerHTML = app.exams.map(exam => `<option value="${escapeHtml(exam.id)}" ${exam.id === app.examId ? "selected" : ""}>${escapeHtml(exam.name)}</option>`).join("");
}

async function loadExam(examId) {
  const exam = app.exams.find(item => item.id === examId) || app.exams[0];
  if (!exam) throw new Error("没有可用的考试题库");
  app.examId = exam.id;
  app.filters = { subject: "", chapter: "", type: "", status: "" };
  app.catalog = { subject: null, chapter: null, knowledge: null };
  const [payload, aliases] = await Promise.all([
    fetch(exam.questions).then(response => { if (!response.ok) throw new Error(`${exam.name} 题库载入失败`); return response.json(); }),
    fetch(exam.aliases).then(response => response.ok ? response.json() : {}).catch(() => ({})),
  ]);
  app.data = payload.questions;
  app.byId = new Map(app.data.map(item => [item.id, item]));
  migrateAliases(aliases);
  restoreSession();
  recomputeKnowledgeState();
  renderExamSelector();
  document.title = `${exam.name} 错题复习`;
  saveState();
  render();
}

async function switchExam(examId) {
  if (examId === app.examId) return;
  saveSession();
  document.querySelector("#main").innerHTML = `<div class="loading">正在载入题库…</div>`;
  try {
    await loadExam(examId);
  } catch (error) {
    renderEmpty(error.message);
  }
}

fetch("data/exams.json")
  .then(response => { if (!response.ok) throw new Error("考试清单载入失败"); return response.json(); })
  .then(async exams => {
    app.exams = exams;
    const initial = exams.some(exam => exam.id === app.state.currentExam) ? app.state.currentExam : exams[0]?.id;
    await loadExam(initial);
  })
  .catch(error => renderEmpty(error.message));
