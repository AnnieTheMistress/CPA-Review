/* Workspace data stays separate from grading and the question store. */
(function attachWorkspace(global) {
  function validDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return false;
    const date = new Date(`${day}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
  }
  function recordedDay(question) {
    for (const value of [question.recordedAt, question.createdAt, question.addedDate]) {
      if (validDay(value)) return value;
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) return global.ReviewScheduler.beijingDate(value);
    }
    const match = String(question.source || "").match(/(?:查看日期|归档日期|收录日期|记录日期|同步日期)[：:\s]*(\d{4}-\d{2}-\d{2})/);
    if (match && validDay(match[1])) return match[1];
    const title = String(question.title || "").match(/(?:·|\s)(\d{4}-\d{2}-\d{2})\s*$/);
    return title && validDay(title[1]) ? title[1] : null;
  }
  function summary(questions, progress, day = global.ReviewScheduler.beijingDate()) {
    const eligible = questions.filter(q => q.interactive && !q.uncertain);
    const due = global.ReviewScheduler.buildDailyQueue(eligible, progress, day);
    return { total: questions.length, added: questions.filter(q => recordedDay(q) === day), due,
      uncertain: questions.filter(q => q.uncertain) };
  }
  function noteUrl(path) {
    if (typeof path !== "string") return null;
    const normalized = path.replace(/\\/g, "/");
    if (!normalized.startsWith("CPA学习/") || /[\x00-\x1f?#]/.test(normalized) || normalized.split("/").some(part => !part || part === ".." || part === ".") || !normalized.endsWith(".md")) return null;
    return `https://github.com/AnnieTheMistress/CPA-Study/blob/main/${normalized.split("/").map(encodeURIComponent).join("/")}`;
  }
  function notes(questions) {
    const entries = new Map();
    for (const question of questions) {
      const url = noteUrl(question.sourceNote);
      if (!url) continue;
      const existing = entries.get(url);
      if (existing) existing.count++;
      else entries.set(url, { url, title: question.sourceNote.replace(/\\/g, "/").split("/").pop().replace(/\.md$/, "").replace(/^\d+[-_]/, ""), count: 1 });
    }
    return [...entries.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-CN", {numeric:true}));
  }
  function countdown(examDate, day = global.ReviewScheduler.beijingDate()) {
    if (!validDay(examDate) || !validDay(day)) return null;
    const days = Math.round((Date.parse(`${examDate}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
    return { days, label: days > 0 ? "距考试还有" : days === 0 ? "今天考试" : "考试已结束" };
  }
  function officialSource(examId, url) {
    const domains = { cpa:"cicpa\\.org\\.cn", intermediate:"mof\\.gov\\.cn", fund:"amac\\.org\\.cn" };
    return Boolean(domains[examId] && typeof url === "string" && new RegExp(`^https://(?:[a-z0-9-]+\\.)*${domains[examId]}/[^\\s]*$`, "i").test(url));
  }
  function validSchedules(value) {
    return value?.version === 1 && value.years && typeof value.years === "object" && !Array.isArray(value.years) && Number.isFinite(Date.parse(value.updatedAt));
  }
  function examDate(examId, settings, schedules, day = global.ReviewScheduler.beijingDate()) {
    if (validDay(settings?.examDate)) return { mode:"manual", date:settings.examDate, endDate:settings.examDate, targetDate:settings.examDate };
    const year = day.slice(0,4);
    const record = validSchedules(schedules) ? schedules.years[year]?.[examId] : null;
    const sessions = (Array.isArray(record?.sessions) ? record.sessions : []).filter(session => validDay(session.date) && validDay(session.endDate || session.date) && session.date.startsWith(`${year}-`) && (session.endDate || session.date) >= session.date && officialSource(examId,session.sourceUrl)).sort((a,b)=>a.date.localeCompare(b.date));
    const session = sessions.find(item => (item.endDate || item.date) >= day) || sessions[sessions.length-1];
    if (!session) return { mode:"official", date:"", year, status:record?.status || "unavailable" };
    const endDate = session.endDate || session.date;
    return { ...session, mode:"official", year, endDate, targetDate:day >= session.date && day <= endDate ? day : day > endDate ? endDate : session.date, status:record.status, checkedAt:session.verifiedAt || record.checkedAt };
  }
  const api = { validDay, recordedDay, summary, notes, noteUrl, countdown, officialSource, validSchedules, examDate };
  global.ReviewWorkspace = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

let officialExamDates = null;
let officialExamDatesStatus = "loading";
let officialExamDatesRequest = null;

async function loadOfficialExamDates() {
  if (officialExamDatesRequest) return officialExamDatesRequest;
  const key = "exam-official-dates-v1";
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (ReviewWorkspace.validSchedules(saved) && (!officialExamDates || Date.parse(saved.updatedAt) >= Date.parse(officialExamDates.updatedAt))) officialExamDates = saved;
  } catch { /* A missing or unavailable cache must not prevent studying. */ }
  const urls = ["data/exam-dates.json", "https://raw.githubusercontent.com/AnnieTheMistress/CPA-Review/main/data/exam-dates.json"];
  officialExamDatesRequest = Promise.all(urls.map(async url => {
    try {
      const options = { cache:"no-store" };
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) options.signal = AbortSignal.timeout(10000);
      const response = await fetch(url, options);
      if (!response.ok) return false;
      const value = await response.json();
      if (!ReviewWorkspace.validSchedules(value)) return false;
      if (!officialExamDates || Date.parse(value.updatedAt) >= Date.parse(officialExamDates.updatedAt)) {
        officialExamDates = value;
        try { localStorage.setItem(key,JSON.stringify(value)); } catch { /* Read-only storage still permits official dates. */ }
        officialExamDatesStatus = "ready";
        if (app.view === "workspace" && !app.loading) renderWorkspace();
      }
      return true;
    } catch { return false; }
  })).then(results => {
    officialExamDatesStatus = results.some(Boolean) ? "ready" : "offline";
    if (app.view === "workspace" && !app.loading) renderWorkspace();
  }).finally(() => { officialExamDatesRequest = null; });
  return officialExamDatesRequest;
}

function workspaceDateDescription(date) {
  if (!date.date) return officialExamDatesStatus === "loading" ? "正在读取官网考试安排…" : date.status === "unpublished" ? `${date.year}年考试日期尚未公布，可手动设置` : "暂时无法读取官网日期，可手动设置";
  if (date.mode === "manual") return "手动设置 · 优先使用你的日期";
  const checked = typeof date.checkedAt === "string" && Number.isFinite(Date.parse(date.checkedAt)) ? ReviewScheduler.beijingDate(date.checkedAt) : "";
  return `${date.status === "stale" || officialExamDatesStatus === "offline" ? "上次核对的官网记录" : "官网公布"}${date.label ? ` · ${date.label}` : ""}${checked ? ` · 核对于${checked}` : ""}`;
}

function workspaceDateCard(examName) {
  const date = ReviewWorkspace.examDate(app.examId,examState(),officialExamDates);
  const countdown = ReviewWorkspace.countdown(date.targetDate);
  const range = date.date && date.date !== date.endDate ? `${date.date} 至 ${date.endDate}` : date.date;
  return `<section class="workspace-card countdown-card"><h2>考试倒计时</h2><span class="badge">${escapeHtml(examName)}</span><p>${countdown ? countdown.label : "考试安排"}</p><div class="countdown-value"><strong>${countdown?.days === 0 ? "今天" : countdown ? Math.abs(countdown.days) : "—"}</strong><span>${countdown?.days === 0 ? "" : countdown?.days < 0 ? "天前" : "天"}</span></div>${range ? `<p>${escapeHtml(range)}</p>` : ""}<p>${escapeHtml(workspaceDateDescription(date))}${date.sourceUrl ? `<br><a href="${escapeHtml(date.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看官网公告 ↗</a>` : ""}</p><button class="secondary-button" data-workspace="date">${date.date ? "修改考试日期" : "设置考试日期"}</button>${date.mode === "manual" ? `<button class="link-button" data-workspace="clear-date">恢复官网日期</button>` : ""}</section>`;
}

function workspaceSubjectLabel(subject) {
  const names = {"科目一":"基金基础知识与法律法规","科目三":"私募股权投资基金基础知识"};
  return app.examId === "fund" ? names[subject] || subject : subject;
}

function workspaceSubjectOrder(a,b) {
  if (app.examId === "fund") {
    const order = {"科目一":1,"科目三":3};
    const difference = (order[a] || 99) - (order[b] || 99);
    if (difference) return difference;
  }
  return a.localeCompare(b,"zh-CN",{numeric:true});
}

function workspaceSubject() {
  const subjects = [...new Set(app.data.map(q => q.subject))].sort(workspaceSubjectOrder);
  const selected = examState().workspace?.subject;
  return subjects.includes(selected) ? selected : subjects[0] || "";
}

function workspaceQuestions() {
  const subject = workspaceSubject();
  return app.data.filter(q => q.subject === subject);
}

function renderWorkspaceSidebar() {
  const sidebar = document.querySelector("#exam-sidebar");
  if (!sidebar) return;
  const labels = { cpa: "注册会计师", intermediate: "会计专业技术资格", fund: "基金从业资格" };
  sidebar.innerHTML = `<h2 class="exam-sidebar-title">我的考试</h2><div class="exam-sidebar-items">${app.exams.map(exam => `<button class="exam-item ${exam.id === app.examId ? "active" : ""}" data-workspace-exam="${escapeHtml(exam.id)}" ${app.loading ? "disabled" : ""} aria-pressed="${exam.id === app.examId}"><strong>${escapeHtml(exam.name)}</strong><small>${escapeHtml(labels[exam.id] || "错题复习")}</small></button>`).join("")}</div><p class="exam-sidebar-hint">学习记录按考试分别保存</p>`;
}

function workspaceNoteRows(notes) {
  return notes.map(note => `<a class="workspace-note-row" href="${escapeHtml(note.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(note.title)}</strong><small>${note.count} 道相关错题 · 打开知识点笔记 ↗</small></a>`).join("");
}

function renderWorkspace() {
  const selected = workspaceSubject();
  const questions = workspaceQuestions();
  const stats = ReviewWorkspace.summary(questions, examState().questions);
  const subjects = [...group(app.data, "subject")].sort((a,b) => workspaceSubjectOrder(a[0],b[0]));
  const examName = app.exams.find(exam => exam.id === app.examId)?.name || "错题复习";
  const chapters = group(questions, "chapter").map(([chapter, items], index) => {
    const sections = items.some(q => q.section) ? group(items.map(q => ({...q, section:q.section || "其他题目"})), "section") : [];
    return `<section class="workbench-chapter"><div class="workbench-chapter-head"><button class="link-button" data-workspace-chapter="${escapeHtml(chapter)}"><span class="chapter-index">${String(index+1).padStart(2,"0")}</span>${escapeHtml(chapter)}</button><span class="badge">${items.length} 道错题</span></div>${sections.length ? `<div class="workbench-sections">${sections.map(([section, rows]) => `<button class="workbench-section" data-workspace-chapter="${escapeHtml(chapter)}" data-workspace-section="${escapeHtml(section)}"><span>${escapeHtml(section)}</span><small>${rows.length} 道 <span aria-hidden="true">→</span></small></button>`).join("")}</div>` : `<button class="workbench-section" data-workspace-chapter="${escapeHtml(chapter)}"><span>练习本章错题</span><small>${items.length} 道 →</small></button>`}</section>`;
  }).join("");
  const notes = ReviewWorkspace.notes(questions);
  const resume = app.byId.get(examState().workspace?.lastQuestionId);
  document.querySelector("#main").innerHTML = `<section class="workspace">
    <header class="workspace-head"><h1>工作台</h1><p>${escapeHtml(examName)} · 选择章节，或从今天的复习开始。</p></header>
    <div class="workspace-subjects" aria-label="选择科目">${subjects.map(([subject,items]) => `<button class="secondary-button ${subject === selected ? "active" : ""}" data-workspace-subject="${escapeHtml(subject)}" aria-pressed="${subject === selected}">${escapeHtml(workspaceSubjectLabel(subject))} <span>${items.length}</span></button>`).join("")}</div>
    <div class="workspace-layout"><div class="workspace-primary">
      <section class="workspace-card"><div class="workspace-card-head"><div><h2>章节错题</h2><p>按章节与小节查看已收录的错题</p></div><button class="link-button" data-workspace="catalog">进入全部目录 →</button></div><div class="workspace-chapters">${chapters || `<p class="workbench-empty">当前考试暂无已归档错题，归档后会在这里显示。</p>`}</div></section>
      <section class="workspace-today"><h2>今天的学习 <small>${escapeHtml(workspaceSubjectLabel(selected) || examName)}</small></h2>
        <div class="workspace-card workspace-stat"><h3>今日新增错题</h3><div class="workspace-stat-value">${stats.added.length}<small>道</small></div><p>回看今天记录的错题</p><button class="secondary-button" data-workspace="new" ${stats.added.length ? "" : "disabled"}>查看新增</button></div>
        <div class="workspace-card workspace-stat"><h3>今日待复习</h3><div class="workspace-stat-value">${stats.due.length}<small>道</small></div><p>到期题与尚未练习的可判分题</p><button class="primary-button" data-workspace="daily" ${stats.due.length ? "" : "disabled"}>开始复习</button></div>
      </section>
      <section class="workspace-card workspace-notes"><div class="workspace-card-head"><h2>笔记</h2><button class="link-button" data-workspace="notes">我的笔记与知识点 →</button></div><div class="notes-toolbar"><button class="secondary-button" data-notes-action="new">新建笔记</button><button class="secondary-button" data-notes-action="import">导入文件</button></div><div class="workspace-note-list">${notes.length ? workspaceNoteRows(notes.slice(0,2)) : `<p class="workbench-empty">收录题目的知识点笔记会显示在这里。</p>`}</div></section>
    </div><aside class="workspace-side">
      ${workspaceDateCard(examName)}
      <section class="workspace-card resume-card"><h2>继续上次</h2>${resume ? `<p>${escapeHtml(resume.subject)} · ${escapeHtml(resume.chapter)}</p><h3>${escapeHtml(resume.section || resume.knowledge || "继续复习")}</h3><p>上次停在第 ${app.data.indexOf(resume)+1} 题</p><button class="primary-button" data-workspace="resume">继续刷题</button>` : `<p>从第一组错题开始，随时回来继续。</p><button class="primary-button" data-workspace="all" ${app.data.length ? "" : "disabled"}>开始练习</button>`}</section>
      ${stats.uncertain.length ? `<section class="workspace-card"><h2>答案存疑</h2><p>${stats.uncertain.length} 道题可作答、查看原解析，暂不判分。</p><button class="secondary-button" data-workspace="uncertain">查看存疑题</button></section>` : ""}
    </aside></div></section>`;
}

function renderWorkspaceNotes() {
  if (typeof renderPersonalNotes === "function") return renderPersonalNotes();
  const notes = ReviewWorkspace.notes(workspaceQuestions());
  document.querySelector("#main").innerHTML = `<section class="workspace"><header class="workspace-head"><h1>知识点笔记</h1><p>${escapeHtml(workspaceSubject())} · ${notes.length} 篇笔记</p><button class="secondary-button" data-view="workspace">返回工作台</button></header><section class="workspace-card workspace-note-list">${workspaceNoteRows(notes) || `<p class="workbench-empty">暂无知识点笔记。</p>`}</section></section>`;
}

function rememberWorkspaceQuestion() {
  const id = app.queue[app.cursor];
  if (!id || !app.byId.has(id)) return;
  const workspace = examState().workspace ||= {};
  if (workspace.lastQuestionId !== id) { workspace.lastQuestionId = id; saveState(); }
}

function startWorkspaceQueue(questions, id = null) {
  if (!questions.length) return;
  app.filters = { subject:"", chapter:"", type:"", status:"" };
  setQueue(questions, id);
  app.view = "practice";
  render();
}

if (typeof document !== "undefined") {
  document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.workspaceExam) { switchExam(button.dataset.workspaceExam); return; }
    if (button.dataset.workspaceSubject) {
      (examState().workspace ||= {}).subject = button.dataset.workspaceSubject;
      saveState(); render(); return;
    }
    if (button.dataset.workspaceChapter) {
      const rows = workspaceQuestions().filter(q => q.chapter === button.dataset.workspaceChapter && (!button.dataset.workspaceSection || (q.section || "其他题目") === button.dataset.workspaceSection));
      startWorkspaceQueue(rows); return;
    }
    const action = button.dataset.workspace;
    if (!action) return;
    const stats = ReviewWorkspace.summary(workspaceQuestions(), examState().questions);
    if (action === "daily") startWorkspaceQueue(stats.due);
    if (action === "new") startWorkspaceQueue(stats.added);
    if (action === "uncertain") startWorkspaceQueue(stats.uncertain);
    if (action === "all") startWorkspaceQueue(app.data);
    if (action === "resume") {
      const id = examState().workspace?.lastQuestionId;
      const saved = (examState().session?.queue || []).map(key => app.byId.get(key)).filter(Boolean);
      startWorkspaceQueue(saved.some(q => q.id === id) ? saved : app.data, id);
    }
    if (action === "catalog") { app.catalog = {subject:workspaceSubject() || null,chapter:null,section:null,knowledge:null}; app.view="catalog";render(); }
    if (action === "notes") { app.view="notes";render(); }
    if (action === "date") {
      document.querySelector("#exam-date").value = ReviewWorkspace.examDate(app.examId,examState(),officialExamDates).date || "";
      const official = ReviewWorkspace.examDate(app.examId,{},officialExamDates);
      const hint = document.querySelector("#official-exam-date");
      if (hint) hint.textContent = official.date ? `官网日期：${official.date}${official.endDate !== official.date ? ` 至 ${official.endDate}` : ""}。保存个人日期后优先使用你的设置。` : workspaceDateDescription(official);
      document.querySelector("#countdown-error").textContent = "";
      document.querySelector("#countdown-dialog").showModal();
    }
    if (action === "cancel-date") document.querySelector("#countdown-dialog").close();
    if (action === "clear-date") { delete examState().examDate; saveState();document.querySelector("#countdown-dialog").close();render(); }
    if (action === "reload-exam") switchExam(app.failedExamId || app.examId, true);
  });
  document.addEventListener("submit", event => {
    if (event.target.id !== "countdown-form") return;
    event.preventDefault();
    const value = document.querySelector("#exam-date").value;
    if (!ReviewWorkspace.validDay(value)) { document.querySelector("#countdown-error").textContent="请选择有效的考试日期。"; return; }
    examState().examDate = value;
    saveState(); document.querySelector("#countdown-dialog").close(); render();
  });
}
