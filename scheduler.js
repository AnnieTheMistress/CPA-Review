(function attachReviewScheduler(global) {
  const INTERVALS = [1, 3, 7, 14, 30];

  function beijingDate(value = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value));
    const pick = type => parts.find(part => part.type === type).value;
    return `${pick("year")}-${pick("month")}-${pick("day")}`;
  }

  function addDays(day, amount) {
    const date = new Date(`${day}T12:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() + amount);
    return beijingDate(date);
  }

  function updateReview(progress = {}, correct, now = new Date()) {
    const day = beijingDate(now);
    const dailyResults = { ...(progress.dailyResults || {}) };
    if (dailyResults[day]) return { ...progress, dailyResults, effective: false };
    if (Object.keys(dailyResults).length && progress.dueDate && progress.dueDate > day) {
      return { ...progress, dailyResults, effective: false };
    }

    const previousStage = Number.isInteger(progress.stage) ? progress.stage : -1;
    let stage;
    let mastered;
    let longTermChecked = Boolean(progress.longTermChecked);
    if (correct) {
      stage = Math.min(previousStage + 1, INTERVALS.length - 1);
      mastered = stage >= INTERVALS.length - 1;
      if (previousStage === INTERVALS.length - 1) longTermChecked = true;
    } else {
      stage = 0;
      mastered = false;
      longTermChecked = false;
    }
    dailyResults[day] = { correct: Boolean(correct), at: new Date(now).toISOString() };
    return {
      ...progress,
      stage,
      dueDate: addDays(day, INTERVALS[stage]),
      dailyResults,
      lastIndependentDate: day,
      mastered,
      longTermChecked,
      effective: true,
    };
  }

  function buildDailyQueue(questions, progressById, day = beijingDate()) {
    const due = [];
    const unseen = [];
    for (const question of questions) {
      const progress = progressById[question.id] || {};
      const hasIndependentResult = Object.keys(progress.dailyResults || {}).length > 0;
      if (hasIndependentResult && progress.dueDate && progress.dueDate <= day) due.push(question);
      else if (!hasIndependentResult) unseen.push(question);
    }
    due.sort((left, right) => {
      const leftDue = progressById[left.id].dueDate;
      const rightDue = progressById[right.id].dueDate;
      return leftDue.localeCompare(rightDue);
    });
    return [...due, ...unseen];
  }

  function knowledgeMastered(questions, progressById) {
    const latestByDay = new Map();
    for (const question of questions) {
      const results = progressById[question.id]?.dailyResults || {};
      for (const [day, result] of Object.entries(results)) {
        const current = latestByDay.get(day);
        if (!current || String(result.at).localeCompare(String(current.at)) > 0) latestByDay.set(day, result);
      }
    }
    const recent = [...latestByDay.entries()].sort((left, right) => left[0].localeCompare(right[0])).slice(-3);
    return recent.length === 3 && recent.every(([, result]) => result.correct);
  }

  const api = { INTERVALS, addDays, beijingDate, buildDailyQueue, knowledgeMastered, updateReview };
  global.ReviewScheduler = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
