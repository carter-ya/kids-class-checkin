import { monthOf, monthlyCounts, monthSpan } from "./months.js";

import { accessControls } from "./access.js";
import { familyControls } from "./family.js";

const el = id => document.getElementById(id);
let calendar = null;
let month = "";
let busy = false;
let revision = 0;
let selected = null;
let pending = null;
let stickerTimer;

function startPending(action) {
  pending = action;
  el("journal-status").textContent = action.description;
  stickerTimer = setTimeout(() => el("journal").classList.add("show-pending-sticker"), 200);
}

function endPending() {
  clearTimeout(stickerTimer);
  el("journal").classList.remove("show-pending-sticker");
  el("journal-status").textContent = "";
  pending = null;
}

const access = accessControls(async (path, payload) => {
  if (busy) throw new Error("请稍后再试");
  busy = true;
  revision++;
  el("login-error").textContent = "";
  try {
    await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } finally { busy = false; }
  await refresh();
});
const familyUI = familyControls({ api, current: () => calendar, switchFamily, showLogin, notice });

async function api(path, options = {}, familyId = calendar?.family?.id) {
  const headers = new Headers(options.headers);
  if (familyId) headers.set("X-Family-Id", familyId);
  const response = await fetch("/api/" + path, { cache: "no-store", ...options, headers });
  const data = await response.json();
  if (!response.ok) {
    const problem = new Error(data.error || "请求失败，请重试");
    problem.status = response.status;
    throw problem;
  }
  return data;
}

let noticeTimer;
function notice(message = "", failed = false) {
  clearTimeout(noticeTimer);
  el("notice-toast").classList.toggle("visible", Boolean(message));
  el("notice-toast").classList.toggle("failed", failed);
  el("notice").textContent = message;
  el("dismiss-notice").hidden = !message;
  if (message) noticeTimer = setTimeout(() => notice(), failed ? 9000 : 4500);
}
el("dismiss-notice").onclick = () => notice();

function view(name) {
  for (const id of ["load-error", "login", "family-welcome", "journal"]) el(id).hidden = id !== name;
  el("family-tools").hidden = name !== "journal";
  el("journal").removeAttribute("data-opening");
}

function clearJournal() {
  endPending();
  calendar = null;
  familyUI.reset();
  if (el("course-dialog").open) el("course-dialog").close();
  document.querySelector(".summary").classList.remove("celebrate");
  month = "";
  if (el("confirm").open) el("confirm").close();
  selected = null;
  el("days").replaceChildren();
  el("month-groups").replaceChildren();
  showMonthlyOverview(false);
  el("owner").textContent = "";
  el("management-sheet").close();
  el("course-list").replaceChildren();
  el("course-form").reset();
  renderCycleBookmarks([], null);
  for (const id of ["welcome-account", "managed-course", "course-title", "delete-description",
    "selected-cycle-title", "selected-cycle-info", "period-range", "confirm-text"]) el(id).textContent = "";
}

function showLogin() {
  revision++;
  clearJournal();
  access.reset();
  notice();
  view("login");
  if (inviteToken()) el("access-intro").textContent = "登录或注册后，就能继续接受家人的邀请。";
}

function showLoadFailure() {
  view("load-error");
}

function showMonthlyOverview(show) {
  el("calendar-detail").inert = show;
  el("monthly-overview").inert = !show;
  el("show-calendar").setAttribute("aria-pressed", String(!show));
  el("show-months").setAttribute("aria-pressed", String(show));
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function turnPage(panel, direction) {
  if (reducedMotion.matches) return;
  panel.getAnimations().forEach(animation => animation.cancel());
  panel.animate([
    { opacity: 0.4, transform: `perspective(700px) rotateY(${direction * 8}deg) translateX(${direction * 12}px)` },
    { opacity: 1, transform: "none" }
  ], { duration: 380, easing: "cubic-bezier(.2,.85,.25,1)", composite: "replace" });
}

function celebrate(date) {
  if (reducedMotion.matches) return;
  const stamp = el("days").querySelector('[data-date="' + date + '"]');
  stamp?.classList.add("fresh-stamp");
  const summary = document.querySelector(".summary");
  summary.classList.remove("celebrate");
  // Restart the burst even when two successful check-ins happen close together.
  void summary.offsetWidth;
  summary.classList.add("celebrate");
}

function setSticker(animal, index) {
  animal.dataset.col = index % 4;
  animal.dataset.row = Math.floor(index / 4);
}

function sticker(index) {
  const animal = document.createElement("i");
  animal.className = "animal-sticker";
  animal.setAttribute("aria-hidden", "true");
  setSticker(animal, index);
  return animal;
}

function replaceChoices(container, children, key) {
  const focused = container.contains(document.activeElement) && document.activeElement.dataset[key];
  container.replaceChildren(...children);
  if (focused) container.querySelector(`[data-${key}="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function renderMonthlyOverview(counts) {
  const overview = el("month-groups");
  const content = document.createDocumentFragment();
  let lastYear;
  let grid;
  for (const [key, count] of counts) {
    const [year, number] = key.split("-").map(Number);
    if (year !== lastYear) {
      const heading = document.createElement("h3");
      heading.textContent = year + " 年";
      grid = document.createElement("div");
      grid.className = "month-grid";
      if (el("years").hidden) content.append(heading);
      content.append(grid);
      lastYear = year;
    }
    const button = document.createElement("button");
    button.dataset.month = key;
    button.dataset.tone = Math.floor((number - 1) / 3);
    const span = monthSpan(key, calendar.first, calendar.last);
    const limits = span.from === span.to ? span.from + " 日" : span.from + "–" + span.to + " 日";
    button.setAttribute("aria-label", year + " 年 " + number + " 月" + (span.partial ? " " + limits : "") + "，已上 " + count + " 节，查看月历");
    const label = document.createElement("span");
    label.textContent = number + " 月";
    const value = document.createElement("strong");
    value.textContent = count + " 节";
    if (count > 0) button.className = "has-classes";
    button.append(label, sticker(number - 1), value);
    if (span.partial) {
      const range = document.createElement("small");
      range.textContent = limits;
      button.append(range);
    }
    grid.append(button);
  }
  replaceChoices(overview, [content], "month");
}

function currentMonth() {
  const today = calendar.today;
  return monthOf(today < calendar.first ? calendar.first : today > calendar.last ? calendar.last : today);
}

function moveMonth(offset) {
  const d = new Date(month + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + offset);
  month = monthOf(d.toISOString());
  render();
  turnPage(el("calendar-detail"), Math.sign(offset));
}

function currentPeriod() {
  return calendar.periods.find(period => period.id === calendar.cycleId);
}

function cycleQuery(id = calendar?.cycleId) {
  return id ? "?cycle=" + encodeURIComponent(id) : "";
}

function selectPeriod(data) {
  const newFamily = calendar && calendar.family?.id !== data.family?.id;
  if (newFamily) familyUI.close();
  const changed = newFamily || calendar?.cycleId !== data.cycleId;
  calendar = data;
  if (changed) {
    el("confirm").close();
    el("course-dialog").close();
    el("management-sheet").close();
    el("history-field").open = false;
    selected = null;
  }
  if (changed || !month) month = data.cycleId ? currentMonth() : "";
}

function renderCycleBookmarks(history, selectedId) {
  const field = el("history-field");
  const choices = el("cycle-choice");
  field.hidden = history.length < 2;
  if (field.hidden) {
    field.open = false;
    choices.replaceChildren();
    return;
  }

  const openingBookmark = history.some(period => period.id === pending?.period?.id);
  const buttons = history.map((period, index) => {
    const selected = period.id === selectedId;
    const title = "第 " + (index + 1) + " 期 · " + period.total + " 节";
    const range = period.first + " 至 " + period.last;
    if (selected) {
      el("selected-cycle-title").textContent = title;
      el("selected-cycle-info").textContent = openingBookmark ? pending.message : range;
    }
    const button = document.createElement("button");
    button.dataset.cycle = period.id;
    button.disabled = busy;
    button.setAttribute("aria-pressed", String(selected));
    const label = document.createElement("strong");
    label.textContent = title;
    const dates = document.createElement("span");
    dates.textContent = range;
    button.append(label, dates);
    return button;
  });
  replaceChoices(choices, buttons.reverse(), "cycle");
}

function renderCourseControls() {
  const period = currentPeriod();
  el("course-management").hidden = !period;
  el("dashboard").hidden = !period;
  el("empty-courses").hidden = !!period;
  for (const id of ["course-management", "first-course"]) el(id).disabled = busy;
  el("course-summary-month").textContent = Number(calendar.today.slice(5, 7)) + " 月课程";
  if (!period) {
    el("course-list").replaceChildren();
    renderCycleBookmarks([], null);
    return;
  }
  const courses = new Map();
  for (const item of calendar.periods) {
    if (!courses.has(item.courseId)) courses.set(item.courseId, []);
    courses.get(item.courseId).push(item);
  }
  const buttons = [];
  for (const periods of courses.values()) {
    const current = preferredPeriod(periods, calendar.today);
    const button = document.createElement("button");
    button.dataset.cycle = current.id;
    button.dataset.tone = (current.courseId - 1) % 4;
    button.disabled = busy;
    button.setAttribute("aria-pressed", String(current.courseId === period.courseId));
    const name = document.createElement("strong");
    name.textContent = current.name;
    const stats = document.createElement("span");
    const monthCount = periods.reduce((sum, item) => sum + item.thisMonth, 0);
    const label = current.last < calendar.today ? "上期剩余" : current.first > calendar.today ? "下期剩余" : "本期剩余";
    stats.textContent = "本月 " + monthCount + " 节 · " + label + " " + (current.total - current.done) + " 节";
    if (pending?.period?.courseId === current.courseId) {
      stats.textContent = pending.message;
      button.classList.add("is-pending");
    }
    const copy = document.createElement("div");
    copy.className = "course-copy";
    copy.append(name, stats);
    button.append(sticker((current.courseId - 1) % 12), copy);
    buttons.push(button);
  }
  replaceChoices(el("course-list"), buttons, "cycle");
  const history = courses.get(period.courseId);
  el("course-title").textContent = period.name + " · 本期进度";
  renderCycleBookmarks(history, period.id);
  el("managed-course").textContent = period.name;
  el("period-range").textContent = "本期 " + period.first.replaceAll("-", ".") + " 至 " + period.last.replaceAll("-", ".");
}

function render() {
  if (!calendar.family) {
    view("family-welcome");
    el("welcome-account").textContent = "当前账号　@" + calendar.username;
    return;
  }
  view("journal");
  el("family-open").disabled = el("history-open").disabled = busy;
  renderCourseControls();
  familyUI.render(calendar);
  if (!calendar.cycleId) return;
  const { dates, total, first, last, today } = calendar;
  const done = dates.length;
  el("count").textContent = done;
  el("left").textContent = total - done;
  el("progress").max = total;
  el("progress").value = done;
  const checkedToday = dates.includes(today);
  const outside = today < first || today > last;
  el("check-today").disabled = busy || outside || checkedToday || done >= total;
  const savingToday = pending?.date === today;
  el("check-today").classList.toggle("is-pending", savingToday);
  el("today-label").textContent = savingToday ? pending.message : done >= total ? total + " 节课，全部完成啦！" : checkedToday ? "今天已打卡 ✓" :
    today < first ? "课程尚未开始" : today > last ? "课程已结束" : "今天上课啦";
  el("prev").disabled = month <= monthOf(first);
  el("next").disabled = month >= monthOf(last);
  const [year, number] = month.split("-").map(Number);
  el("month-name").textContent = year + " 年 " + number + " 月";
  setSticker(el("month-friend"), number - 1);
  const monthIndex = date => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  const byYear = monthIndex(last) - monthIndex(first) >= 24;
  const counts = monthlyCounts(calendar, byYear ? year : null);
  el("years").hidden = !byYear;
  el("year-label").textContent = year + " 年";
  el("prev-year").disabled = year <= Number(first.slice(0, 4));
  el("next-year").disabled = year >= Number(last.slice(0, 4));
  el("month-count").textContent = "当月已上 " + counts.get(month) + " 节";
  if (pending?.date && monthOf(pending.date) === month) {
    el("month-count").textContent = Number(pending.date.slice(-2)) + " 日 · " + pending.message;
  }
  renderMonthlyOverview(counts);
  const { from, to, leading } = monthSpan(month, first, last);
  const children = [];
  for (let i = 0; i < leading; i++) children.push(document.createElement("span"));
  for (let i = from; i <= to; i++) {
    const button = document.createElement("button");
    const date = month + "-" + String(i).padStart(2, "0");
    const checked = dates.includes(date);
    button.className = "day";
    button.classList.toggle("today", date === today);
    button.classList.toggle("checked", checked);
    const numeral = document.createElement("span");
    numeral.textContent = i;
    button.append(numeral);
    button.dataset.date = date;
    button.disabled = busy || date > today || (!checked && done >= total);
    button.setAttribute("aria-label", date + (date === today ? " 今天" : "") + (checked ? " 已打卡" : " 未打卡"));
    if (pending?.date === date) {
      button.classList.add("is-pending");
      button.setAttribute("aria-label", date + " " + pending.message);
    }
    if (date === today) button.setAttribute("aria-current", "date");
    children.push(button);
  }
  replaceChoices(el("days"), children, "date");
}

async function readCalendar(id, familyId = calendar?.family?.id) {
  try {
    return await api("calendar" + cycleQuery(id), {}, familyId);
  } catch (err) {
    if (id && err.status === 404) return api("calendar", {}, familyId);
    throw err;
  }
}

function saved(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
async function preferredCalendar(data) {
  if (!data.periods.length) return data;
  const course = saved("class-course-" + data.userId + "-" + data.family.id) || saved("class-course-" + data.userId);
  const matches = data.periods.filter(p => String(p.courseId) === course);
  const preferred = preferredPeriod(matches.length ? matches : data.periods, data.today);
  return preferred.id === data.cycleId ? data : readCalendar(preferred.id, data.family.id);
}
async function switchFamily(id) {
  if (busy) throw new Error("手账正在保存，请稍后再试");
  const fromOpener = document.activeElement === el("family-open");
  const version = ++revision;
  busy = true;
  try {
    if (id === null) {
      // A completed membership removal invalidates the old journal even if the next read fails.
      clearJournal();
      view("journal");
      el("family-tools").hidden = true;
      el("journal").setAttribute("data-opening", "");
    } else render();
    const data = await preferredCalendar(await readCalendar(null, id));
    if (version !== revision) return;
    selectPeriod(data);
    try { if (data.family) localStorage.setItem("class-family-" + data.userId, data.family.id); } catch {}
  } catch (err) {
    if (version === revision && !calendar && err.status !== 401) showLoadFailure();
    throw err;
  } finally {
    busy = false;
    if (calendar) {
      render();
      if (document.activeElement === document.body) {
        if (!calendar.family) el("welcome-create").focus();
        else if (fromOpener || id === null) el("family-open").focus({ preventScroll: true });
      }
    }
  }
}
function inviteToken() {
  const token = new URLSearchParams(location.search).get("invite");
  return /^[a-f0-9]{32}$/.test(token || "") ? token : null;
}

async function refresh(firstCalendar) {
  if (busy) return;
  const version = ++revision;
  try {
    let data;
    try { data = firstCalendar ?? await readCalendar(calendar?.cycleId); }
    catch (err) {
      if (err.status !== 403 || !calendar) throw err;
      data = await readCalendar(null, null);
    }
    if (version !== revision) return;
    let initial = data;
    if (!calendar) {
      const token = inviteToken();
      if (token) { location.replace("/invite/" + token); return; }
      const params = new URLSearchParams(location.search);
      const requested = params.get("family");
      const family = requested || saved("class-family-" + data.userId);
      if (family && data.family && String(data.family.id) !== family && data.families.some(f => String(f.id) === family)) {
        data = await readCalendar(null, family);
      }
      initial = await preferredCalendar(data);
      if (requested && version === revision) {
        if (data.family) { try { localStorage.setItem("class-family-" + data.userId, data.family.id); } catch {} }
        history.replaceState(null, "", "/");
      }
    }
    if (version !== revision) return;
    selectPeriod(initial);
    render();
  } catch (err) {
    if (version !== revision) return;
    if (err.status === 401) return showLogin();
    if (!calendar) showLoadFailure();
    notice("读取失败，请检查网络后重试。", true);
  }
}

function preferredPeriod(periods, today) {
  return periods.filter(p => p.first <= today && today <= p.last).at(-1)
    || periods.find(p => p.first > today) || periods.at(-1);
}

async function loadPeriod(id) {
  const data = await readCalendar(id);
  selectPeriod(data);
  try {
    const key = "class-course-" + data.userId + "-" + data.family.id;
    if (data.cycleId) localStorage.setItem(key, String(currentPeriod().courseId));
    else localStorage.removeItem(key);
  } catch {}
}

async function switchPeriod(id) {
  if (busy) return;
  const period = calendar.periods.find(item => item.id === Number(id));
  if (!period) return;
  const history = calendar.periods.filter(item => item.courseId === period.courseId);
  const message = period.courseId === currentPeriod().courseId
    ? "正在翻到第 " + (history.indexOf(period) + 1) + " 期…" : "正在翻页…";
  startPending({ period, message, description: period.name + "，" + message });
  const fromCard = el("course-list").contains(document.activeElement);
  busy = true;
  revision++;
  notice();
  render();
  try { await loadPeriod(id); }
  catch (err) {
    if (err.status === 401) return showLogin();
    notice("切换失败，请重试", true);
  } finally {
    endPending();
    busy = false;
    if (calendar) {
      render();
      if (fromCard && document.activeElement === document.body) {
        el("course-list").querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      }
    }
  }
}

el("course-list").onclick = event => {
  const button = event.target.closest("button[data-cycle]");
  if (button && Number(button.dataset.cycle) !== calendar.cycleId) void switchPeriod(button.dataset.cycle);
};
function closeCycleBookmarks() {
  el("history-field").open = false;
  el("cycle-toggle").focus({ preventScroll: true });
}
el("cycle-choice").onclick = event => {
  const button = event.target.closest("button[data-cycle]");
  if (!button || busy) return;
  closeCycleBookmarks();
  if (Number(button.dataset.cycle) !== calendar.cycleId) void switchPeriod(button.dataset.cycle);
};
function dismissOutsideBookmarks(event) {
  const field = el("history-field");
  if (field.open && !field.contains(event.target)) field.open = false;
}
document.addEventListener("click", dismissOutsideBookmarks);
document.addEventListener("focusin", dismissOutsideBookmarks);
el("history-field").onkeydown = event => {
  if (event.key === "Escape" && el("history-field").open) {
    event.preventDefault();
    closeCycleBookmarks();
  }
};

const courseHints = {
  "course-name": "先填课程名，比如「游泳课」。",
  "cycle-first": "选这期课程开始的日期。",
  "cycle-last": "选这期课程结束的日期。",
  "cycle-total": "填这期一共买了几节课，再点「保存」。"
};
function pointToCourseField(input) {
  if (el("course-guide").hidden || !courseHints[input.id]) return;
  el("course-guide-hint").textContent = courseHints[input.id];
}
el("course-form").addEventListener("focusin", event => pointToCourseField(event.target));
el("skip-course-guide").onclick = async () => {
  if (busy) return;
  busy = true;
  revision++;
  const button = el("skip-course-guide");
  button.disabled = el("close-course").disabled = el("submit-course").disabled = true;
  try {
    await api("guide", { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({stage:"course"}) });
    calendar.courseGuideDone = calendar.guideDone = true;
    el("course-guide").hidden = true;
    familyUI.stopTour();
    el("course-name").focus();
  } catch (err) {
    if (err.status === 401) return showLogin();
    el("course-error").textContent = "暂时无法保存引导设置，请重试。";
  } finally {
    busy = false;
    button.disabled = el("close-course").disabled = el("submit-course").disabled = false;
  }
};
function openCourseForm(mode) {
  if (busy || !calendar) return;
  el("management-sheet").close();
  const period = currentPeriod();
  const form = el("course-form");
  form.reset();
  form.dataset.mode = mode;
  form.dataset.course = period?.courseId || "";
  const deleting = mode === "delete";
  const showName = mode === "create" || mode === "rename";
  const showDates = mode === "create" || mode === "renew";
  const titles = { create: "添加课程", rename: "给课程改名字", renew: "续课开新周期", delete: "删除这门课程？" };
  el("course-dialog-title").textContent = titles[mode];
  el("delete-description").hidden = !deleting;
  if (deleting) {
    const periods = calendar.periods.filter(p => p.courseId === period.courseId);
    const done = periods.reduce((sum, p) => sum + p.done, 0);
    el("delete-description").textContent = "《" + period.name + "》的 " + periods.length + " 个周期和 " + done + " 条打卡记录将一并删除，删除后无法恢复。";
  }
  el("submit-course").textContent = deleting ? "确认删除" : "保存";
  el("submit-course").classList.toggle("danger", deleting);
  el("course-error").textContent = "";
  el("name-field").hidden = !showName;
  el("course-name").disabled = !showName;
  el("course-name").value = mode === "rename" ? period.name : "";
  el("cycle-fields").hidden = !showDates;
  el("cycle-fields").disabled = !showDates;
  if (showDates) {
    const latest = mode === "renew" ? calendar.periods.filter(p => p.courseId === period.courseId)
      .reduce((a, b) => a.last > b.last ? a : b) : null;
    const start = new Date((latest?.last || calendar.today) + "T00:00:00Z");
    if (latest) start.setUTCDate(start.getUTCDate() + 1);
    const end = new Date(start);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    end.setUTCDate(end.getUTCDate() - 1);
    el("cycle-first").value = start.toISOString().slice(0, 10);
    el("cycle-last").value = end.toISOString().slice(0, 10);
    el("cycle-last").min = el("cycle-first").value;
    el("cycle-total").value = latest?.total || 35;
  }
  el("course-guide").hidden = mode !== "create" || calendar.courseGuideDone;
  pointToCourseField(el("course-name"));
  const initialFocus = el(deleting ? "close-course" : showName ? "course-name" : "course-dialog-title");
  // Set the target before showModal so mobile browsers never focus a date on entry.
  initialFocus.autofocus = true;
  el("course-dialog").showModal();
  initialFocus.autofocus = false;
}
el("course-management").onclick = () => {
  if (!busy && calendar?.cycleId) el("management-sheet").showModal();
};
el("close-management").onclick = () => el("management-sheet").close();
el("delete-course").onclick = () => openCourseForm("delete");
el("first-course").onclick = () => openCourseForm("create");
el("new-course").onclick = () => openCourseForm("create");
el("renew").onclick = () => openCourseForm("renew");
el("rename").onclick = () => openCourseForm("rename");
el("cycle-first").oninput = () => { el("cycle-last").min = el("cycle-first").value; };
el("close-course").onclick = () => el("course-dialog").close();
el("course-dialog").oncancel = event => { if (busy) event.preventDefault(); };
el("course-form").onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  revision++;
  const { mode, course } = event.currentTarget.dataset;
  const rename = mode === "rename";
  const path = mode === "create" ? "courses" : "courses/" + course + (mode === "renew" ? "/cycles" : "");
  el("course-error").textContent = "";
  el("submit-course").disabled = el("close-course").disabled = true;
  render();
  try {
    if (mode === "delete") {
      try {
        await api(path, { method: "DELETE" });
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      el("course-dialog").close();
      const remaining = calendar.periods.filter(p => String(p.courseId) !== course);
      await loadPeriod(preferredPeriod(remaining, calendar.today)?.id || null);
      notice("课程已删除。");
      return;
    }
    const result = await api(path, {
      method: rename ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: el("course-name").value.trim(), first: el("cycle-first").value,
        last: el("cycle-last").value, total: el("cycle-total").valueAsNumber })
    });
    el("course-dialog").close();
    await loadPeriod(result.cycleId || calendar.cycleId);
    if (result.startCourseGuide && !el("course-guide").hidden) familyUI.afterCourse();
    notice(rename ? "课程名称已更新。" : "新周期已建好。");
  } catch (err) {
    if (err.status === 401) return showLogin();
    if (el("course-dialog").open) el("course-error").textContent = err.message;
    else notice("已保存，请刷新手账查看。", true);
  } finally {
    busy = false;
    el("submit-course").disabled = el("close-course").disabled = false;
    if (calendar) render();
  }
};

el("welcome-refresh").onclick = async () => {
  await refresh();
  if (calendar && !calendar.family) notice("还没有加入家庭，请确认家人添加的是 @" + calendar.username + "。");
};
el("welcome-logout").onclick = el("logout").onclick = async () => {
  if (busy) return;
  busy = true;
  revision++;
  try {
    await api("logout", { method: "POST" });
    showLogin();
  } catch (err) {
    if (err.status === 401) showLogin();
    else notice("退出失败，请重试", true);
  } finally { busy = false; }
};

async function save(date, remove = false) {
  if (!calendar || busy) return;
  const cycleId = calendar.cycleId;
  const message = remove ? "正在撤销…" : "正在记课…";
  startPending({ date, message, description: date + "，" + message });
  let stamped = false;
  busy = true;
  const version = ++revision;
  notice();
  render();
  try {
    const updated = await api("checkins/" + date + cycleQuery(), { method: remove ? "DELETE" : "PUT" });
    if (revision !== version) return;
    calendar = updated;
    stamped = !remove;
  } catch (err) {
    if (revision !== version) return;
    if (err.status === 401) return showLogin();
    // A lost response can follow a successful write. Refresh before a retry.
    pending.message = "正在核对记录…";
    el("journal-status").textContent = date + "，" + pending.message;
    render();
    try {
      const latest = await readCalendar(cycleId);
      if (revision !== version) return;
      selectPeriod(latest);
      const matches = latest.cycleId === cycleId && latest.dates.includes(date) === !remove;
      if (err.status < 500 || !matches) {
        notice(err.status ? err.message : "这次更改未记入，请重试。", true);
        return;
      }
      stamped = !remove;
    } catch (retry) {
      if (retry.status === 401) return showLogin();
      notice(err.status && err.status < 500 ? err.message : "暂时无法核对记录，请刷新手账后再试。", true);
      return;
    }
  } finally {
    endPending();
    busy = false;
    if (calendar) render();
    if (stamped) celebrate(date);
  }
  notice(remove ? "已撤销这次打卡。" : "记好啦，又闪亮了一颗小星星！");
}

function moveOverviewYear(offset) {
  const target = String(Number(month.slice(0, 4)) + offset).padStart(4, "0") + month.slice(4);
  const first = monthOf(calendar.first), last = monthOf(calendar.last);
  month = target < first ? first : target > last ? last : target;
  render();
}
el("prev-year").onclick = () => moveOverviewYear(-1);
el("next-year").onclick = () => moveOverviewYear(1);
el("show-months").onclick = () => {
  if (!el("monthly-overview").inert) return;
  showMonthlyOverview(true);
  turnPage(el("monthly-overview"), 1);
};
el("show-calendar").onclick = () => {
  if (!el("calendar-detail").inert) return;
  showMonthlyOverview(false);
  turnPage(el("calendar-detail"), -1);
};
el("monthly-overview").onclick = event => {
  const key = event.target.closest("button")?.dataset.month;
  if (!key) return;
  month = key;
  showMonthlyOverview(false);
  render();
  turnPage(el("calendar-detail"), -1);
  el("month-name").focus();
};
el("prev").onclick = () => moveMonth(-1);
el("next").onclick = () => moveMonth(1);
el("current").onclick = () => {
  const target = currentMonth();
  if (target === month) return;
  const direction = target < month ? -1 : 1;
  month = target;
  render();
  turnPage(el("calendar-detail"), direction);
};
el("check-today").onclick = () => save(calendar.today);
el("days").onclick = event => {
  const date = event.target.closest("button")?.dataset.date;
  if (!date || busy) return;
  const remove = calendar.dates.includes(date);
  selected = { date, remove };
  el("confirm-title").textContent = remove ? "撤销这次打卡？" : "记录这节课？";
  el("confirm-text").textContent = date.replace(/^(\d+)-(\d+)-(\d+)$/, (_, y, m, d) => y + " 年 " + Number(m) + " 月 " + Number(d) + " 日") +
    (remove ? "由 @" + calendar.markedBy[date] + " 打卡。撤销后会恢复一节剩余课时。" : "将记为一次上课。");
  el("confirm-action").textContent = remove ? "确认撤销" : "确认打卡";
  el("confirm").showModal();
};
el("cancel").onclick = () => el("confirm").close();
el("confirm-action").onclick = () => {
  const { date, remove } = selected;
  el("confirm").close();
  void save(date, remove);
};
el("reload").onclick = () => refresh();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && calendar) void refresh();
});
setInterval(() => { if (!document.hidden && calendar && !el("confirm").open) void refresh(); }, 60000);
const entry = el("entry-calendar");
const firstCalendar = entry.content.textContent;
entry.remove();
if (firstCalendar) {
  void refresh(JSON.parse(firstCalendar));
} else if (!el("login").hidden) {
  if (inviteToken()) el("access-intro").textContent = "登录或注册后，就能继续接受家人的邀请。";
} else if (el("load-error").hidden) {
  // Static previews can serve the template without a Worker.
  void refresh();
}
