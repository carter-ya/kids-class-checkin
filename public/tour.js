const el = id => document.getElementById(id);

// Each stop is attached to the real control, so clicking it uses its usual handler.
export function journalTour({ current, openMenu, closeMenu, complete, failure }) {
  const tip = el("guide-sheet");
  const stops = [
    () => current().cycleId
      ? ["course-management", "点这里管理课程，可以添加课程或续课。"]
      : ["first-course", "点这里添加第一门课，填好课程名称、日期和课时后保存。"],
    () => current().cycleId && !el("check-today").disabled && ["check-today", "孩子今天上过课？点这里记一节。也可以直接看下一处。"],
    () => current().cycleId && ["show-calendar", "点「上课月历」，再点一个日期，就可以补记或撤销打卡。"],
    () => current().cycleId && ["show-months", "点「每月课时」，看看这个周期每个月上了几节课。"],
    () => ["family-open", "点右上角的家庭名，展开家庭菜单。"],
    () => ["history-open", "点这枚铅笔查看谁打了卡。菜单里的家庭卡可以切换手账。"]
  ];
  let index = -1, target = null, seenUser, frame, saving = false;
  function clearTarget() {
    if (target) {
      target.removeAttribute("data-tour-target");
      target.removeAttribute("aria-describedby");
    }
    target = null;
    tip.hidden = true;
  }
  function stop() {
    index = -1;
    cancelAnimationFrame(frame);
    clearTarget();
  }
  function position() {
    if (!target || tip.hidden) return;
    const r = target.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
    const left = Math.min(innerWidth - width - 10, Math.max(10, r.left + (r.width - width) / 2));
    const above = r.bottom + 12 + height > innerHeight && r.top > height + 12;
    const top = above ? r.top - height - 12 : r.bottom + 12;
    tip.style.left = left + "px";
    tip.style.top = Math.max(5, Math.min(innerHeight - height - 5, top)) + "px";
    tip.style.setProperty("--pointer-at", Math.min(width - 18, Math.max(18, r.left + r.width / 2 - left)) + "px");
    tip.dataset.side = above ? "above" : "below";
  }
  function show() {
    if (index < 0 || !current() || saving || el("family-open").disabled) return;
    if (document.querySelector("dialog[open]")) { clearTarget(); return; }
    let spec = stops[index]();
    while (!spec) spec = stops[++index]();
    if (spec[0] === "history-open") openMenu();
    const button = el(spec[0]);
    if (target !== button || tip.hidden) {
      clearTarget();
      target = button;
      button.setAttribute("data-tour-target", "");
      button.setAttribute("aria-describedby", "guide-copy");
      el("guide-step").textContent = "小兔带路";
      el("guide-copy").textContent = spec[1];
      el("guide-next").textContent = index === stops.length - 1 ? "我知道啦 ✓" : "看下一处 ›";
      button.scrollIntoView({ block: "center", behavior: "instant" });
      tip.hidden = false;
      button.focus({ preventScroll: true });
    }
    position();
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(show);
  }
  function start(firstStop = 0) {
    stop();
    closeMenu();
    seenUser = current().userId;
    index = firstStop;
    el("guide-error").textContent = "";
    schedule();
  }
  async function finish() {
    if (saving || index < 0) return;
    saving = true;
    try {
      await complete();
      const returnTo = tip.contains(document.activeElement) && target;
      stop();
      if (returnTo) returnTo.focus({ preventScroll: true });
    }
    catch (err) { failure(err, "guide-error"); }
    finally { saving = false; }
  }
  function next() {
    if (saving || index < 0) return;
    if (index === stops.length - 1) { void finish(); return; }
    clearTarget();
    index++;
    schedule();
  }
  document.addEventListener("click", event => {
    if (target?.contains(event.target)) next();
  }, true);
  document.addEventListener("keydown", event => {
    if (index < 0 || document.querySelector("dialog[open]")) return;
    if (event.key === "Tab" && target && !tip.hidden) {
      if (!event.shiftKey && event.target === target) {
        event.preventDefault(); el("guide-skip").focus();
      } else if (event.shiftKey && event.target === el("guide-skip")) {
        event.preventDefault(); target.focus();
      }
    }
    if (event.key === "Escape") {
      event.preventDefault(); void finish();
    }
  });
  const observer = new MutationObserver(schedule);
  for (const dialog of document.querySelectorAll("dialog")) observer.observe(dialog, { attributes: true, attributeFilter: ["open"] });
  window.addEventListener("scroll", position, true);
  window.addEventListener("resize", schedule);
  el("guide-next").onclick = next;
  el("guide-skip").onclick = finish;
  return {
    start, stop, afterCourse() { start(1); },
    menuClosed() {
      if (target?.id === "history-open" && !saving) {
        clearTarget();
        index--;
        schedule();
      }
    },
    reset() { stop(); seenUser = null; },
    render(data) {
      if (!data.guideDone && seenUser !== data.userId) start();
      else if (index >= 0) schedule();
    }
  };
}
