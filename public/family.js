import { journalTour } from "./tour.js";

const el = id => document.getElementById(id);
export const roles = ["爸爸", "妈妈", "奶奶", "爷爷", "姥姥", "姥爷", "舅舅", "小姨"];
function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}
export function portrait(role, icon = document.createElement("i")) {
  const index = roles.indexOf(role);
  icon.className = "family-avatar" + (index < 0 ? " custom-avatar" : "");
  icon.dataset.col = index % 4;
  icon.dataset.row = Math.floor(index / 4);
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

export function familyControls({ api, current, switchFamily, showLogin, notice }) {
  const sheet = el("family-sheet"), history = el("activity-sheet");
  let mode, target, editingFamily, writing = false;
  let listVersion = 0, historyVersion = 0;
  const write = (path, method, data, id) => api(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  }, id);
  function failure(err, id) {
    if (err.status === 401) return showLogin();
    el(id).textContent = err.message || "读取失败，请重试";
  }
  const tools = el("family-tools"), menu = el("family-menu"), opener = el("family-open");
  let hovered = false, closeTimer, menuVersion = 0, familySignature = "";
  const tour = journalTour({ current, openMenu, closeMenu, failure, complete: async () => {
    const userId = current()?.userId;
    await write("guide", "POST", {});
    if (current()?.userId === userId) current().guideDone = true;
  } });
  function cards(families) {
    const signature = JSON.stringify([current().family.id, families]);
    if (signature === familySignature) return;
    familySignature = signature;
    el("family-list").replaceChildren(...families.map(f => {
      const card = node("button", "");
      card.dataset.tone = (f.id - 1) % 4;
      card.dataset.family = f.id;
      card.setAttribute("aria-pressed", String(f.id === current().family.id));
      const copy = node("div", "");
      copy.className = "course-copy";
      copy.append(node("strong", f.name), node("span", f.role));
      card.append(portrait(f.role), copy);
      card.onclick = async () => {
        closeMenu(); opener.focus();
        if (current().family.id === f.id) return;
        try { await switchFamily(f.id); }
        catch (err) { if (err.status === 401) showLogin(); else notice(err.message, true); }
      };
      return card;
    }));
  }
  function render(data) {
    el("owner").textContent = data.family.name;
    opener.setAttribute("aria-label", "家庭菜单：" + data.family.name);
    portrait(data.family.role, el("my-avatar"));
    cards(data.families);
    tour.render(data);
  }
  function updateFamilies(families) {
    const data = current();
    data.families = families;
    const family = families.find(item => item.id === data.family.id);
    if (family) data.family = family;
    render(data);
  }
  function closeMenu() {
    clearTimeout(closeTimer);
    menuVersion++;
    hovered = false;
    menu.hidden = true;
    opener.setAttribute("aria-expanded", "false");
    tour.menuClosed();
  }
  function openMenu() {
    clearTimeout(closeTimer);
    if (!current() || opener.disabled || !menu.hidden) return;
    menu.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    const version = ++menuVersion, id = current().family.id;
    api("members", {}, id).then(({families}) => {
      if (version !== menuVersion || current()?.family?.id !== id) return;
      updateFamilies(families);
    }).catch(err => {
      if (version === menuVersion) {
        if (err.status === 401) showLogin(); else notice(err.message, true);
      }
    });
  }
  tools.onpointerenter = e => {
    if (e.pointerType === "mouse" && matchMedia("(hover:hover)").matches) {
      clearTimeout(closeTimer);
      if (menu.hidden) { openMenu(); hovered = true; }
    }
  };
  tools.onpointerleave = e => {
    if (e.pointerType === "mouse" && hovered) closeTimer = setTimeout(() => {
      if (!menu.contains(document.activeElement) && !menu.querySelector("[data-tour-target]")) closeMenu();
    }, 220);
  };
  opener.onclick = () => {
    if (menu.hidden || hovered) { openMenu(); hovered = false; }
    else closeMenu();
  };
  tools.onkeydown = e => {
    if (e.key === "Escape") { closeMenu(); opener.focus(); }
    if (e.key === "ArrowDown" && e.target === opener) {
      e.preventDefault(); openMenu(); menu.querySelector("button")?.focus();
    }
  };
  function dismissMenu(e) {
    if (!menu.hidden && !tools.contains(e.target) && !el("guide-sheet").contains(e.target)) closeMenu();
  }
  document.addEventListener("pointerdown", dismissMenu);
  document.addEventListener("focusin", dismissMenu);
  el("manage-family").onclick = () => { closeMenu(); void home(); };
  el("guide-replay").onclick = () => { tour.start(); };
  el("logout").addEventListener("click", closeMenu);
  for (const dialog of [sheet, history]) dialog.addEventListener("close", () => {
    if (current()?.family && !document.querySelector("dialog[open]")) opener.focus({ preventScroll: true });
  });

  function panel(id, title) {
    for (const page of ["family-home", "family-form", "remove-panel"]) el(page).hidden = page !== id;
    el("family-heading").textContent = title;
    el("family-error").textContent = "";
    sheet.scrollTop = 0;
  }
  async function home() {
    const version = ++listVersion;
    const { family, userId } = current();
    editingFamily = family.id;
    panel("family-home", "我的家庭");
    el("member-list").replaceChildren();
    el("family-name").textContent = family.name;
    el("invite-details").open = false;
    el("invite-details").hidden = true;
    el("invite-code").textContent = "";
    el("invite-ready").hidden = true;
    if (!sheet.open) sheet.showModal();
    try {
      const { members, families } = await api("members", {}, family.id);
      if (!sheet.open || version !== listVersion || current()?.family?.id !== family.id) return;
      updateFamilies(families);
      el("invite-details").hidden = false;
      const rows = members.map(person => {
        const row = node("li", ""), info = node("div", ""), edit = node("button", "编辑");
        info.append(node("strong", person.role + (person.id === userId ? "（我）" : "")), node("small", "@" + person.username + (person.id === family.ownerId ? " · 创建人" : "")));
        edit.className = "text-link";
        edit.setAttribute("aria-label", "编辑 " + person.username);
        edit.onclick = () => form("edit", person);
        row.append(portrait(person.role), info, edit);
        return row;
      });
      el("member-list").replaceChildren(...rows);
    } catch (err) { if (sheet.open && version === listVersion) failure(err, "family-error"); }
  }
  function form(action, member = null) {
    listVersion++;
    editingFamily = current().family?.id;
    mode = action;
    target = member;
    const isHouse = mode === "house", isAdd = mode === "add";
    const joining = mode === "join";
    panel("family-form", isHouse ? "创建新家庭" : joining ? "加入家庭" : isAdd ? "添加家人" : "编辑 @" + member.username);
    el("family-form").reset();
    el("house-field").hidden = !isHouse;
    el("house-name").required = isHouse;
    el("invite-field").hidden = !joining;
    el("join-code").required = joining;
    el("account-field").hidden = !isAdd;
    el("member-account").required = isAdd;
    el("role-caption").textContent = (isHouse || joining) ? "你在家的称呼" : "在家怎么称呼？";
    const selected = member?.role || ((isHouse || joining) ? (current().family?.role || current().preferredRole) : roles[0]);
    const custom = !roles.includes(selected);
    el("role-grid").replaceChildren(...[...roles, "其他"].map((label, i) => {
      const wrap = node("label", ""), radio = document.createElement("input");
      radio.type = "radio"; radio.name = "family-role"; radio.value = label;
      radio.checked = i === (custom ? roles.length : roles.indexOf(selected));
      radio.onchange = () => {
        el("custom-field").hidden = i !== roles.length;
        el("role-custom").required = !el("custom-field").hidden;
        if (el("role-custom").required) el("role-custom").focus();
      };
      wrap.append(radio, portrait(label), node("span", label));
      return wrap;
    }));
    el("custom-field").hidden = !custom;
    el("role-custom").required = custom;
    el("role-custom").value = custom ? selected : "";
    const { family, userId } = current();
    el("member-remove").hidden = !member || member.id === family.ownerId || (userId !== family.ownerId && userId !== member.id);
    el("member-remove").textContent = member?.id === userId ? "退出这个家庭" : "移除这位家人";
    el("family-save").textContent = isHouse ? "创建家庭" : joining ? "加入家庭" : isAdd ? "添加到家庭" : "保存称呼";
    if (!sheet.open) sheet.showModal();
  }
  el("family-close").onclick = () => { if (!writing) sheet.close(); };
  sheet.oncancel = e => { if (writing) e.preventDefault(); };
  el("family-back").onclick = () => { if (!writing) { if (current().family) void home(); else sheet.close(); } };
  el("member-add").onclick = () => form("add");
  el("family-create").onclick = el("welcome-create").onclick = () => form("house");
  el("family-join").onclick = el("welcome-join").onclick = () => form("join");
  const account = el("member-account");
  account.onbeforeinput = event => {
    if (/^[@＠]+$/.test(event.data || "")) event.preventDefault();
  };
  function cleanAccount() {
    const value = account.value;
    if (!/[@＠]/.test(value)) return;
    const caret = value.slice(0,account.selectionStart).replace(/[@＠]/g,"").length;
    account.value = value.replace(/[@＠]/g,"");
    account.setSelectionRange(caret,caret);
  }
  account.oninput = event => { if (!event.isComposing) cleanAccount(); };
  account.oncompositionend = cleanAccount;

  async function loadInvite() {
    if (!el("invite-details").open) return;
    const version = listVersion, id = current().family.id;
    el("invite-status").textContent = "正在准备邀请…";
    el("invite-ready").hidden = el("manual-link").hidden = el("invite-retry").hidden = true;
    try {
      const invite = await api("invitations", {method:"POST"}, id);
      if (version !== listVersion || !sheet.open || current()?.family?.id !== id) return;
      el("invite-code").textContent = invite.code;
      el("invite-url").value = new URL(invite.path,location.origin).href;
      el("invite-expiry").textContent = "有效至 " + formatTime.format(new Date(invite.expiresAt * 1000));
      el("share-invite").hidden = typeof navigator.share !== "function";
      el("copy-link").className = el("share-invite").hidden ? "primary" : "text-link";
      el("invite-ready").hidden = false;
      el("invite-status").textContent = "";
    } catch (err) {
      if (version !== listVersion || !sheet.open) return;
      failure(err,"invite-status");
      el("invite-retry").hidden = false;
    }
  }
  el("invite-details").ontoggle = loadInvite;
  el("invite-retry").onclick = loadInvite;
  async function copyInvite(link) {
    try {
      await navigator.clipboard.writeText(link ? el("invite-url").value : el("invite-code").textContent);
      el("invite-status").textContent = link ? "邀请链接已复制，发给家人就好。" : "邀请码已复制。";
    } catch {
      if (link) { el("manual-link").hidden = false; el("invite-url").select(); }
      el("invite-status").textContent = link ? "请选择并复制链接。" : "请长按或选中短码复制。";
    }
  }
  el("copy-invite").onclick = () => copyInvite(false);
  el("copy-link").onclick = () => copyInvite(true);
  el("share-invite").onclick = async () => {
    try {
      await navigator.share({ title: "邀请你加入家庭「" + current().family.name + "」",url:el("invite-url").value });
    } catch (err) { if (err.name !== "AbortError") await copyInvite(true); }
  };
  el("member-remove").onclick = () => {
    if (writing) return;
    panel("remove-panel", el("member-remove").textContent);
    el("remove-copy").textContent = "移除 @" + target.username + " 后，该账号将无法查看这个家庭的课程。原有操作记录会保留。";
    el("remove-cancel").focus();
  };
  el("remove-cancel").onclick = () => { if (!writing) form("edit", target); };
  el("remove-confirm").onclick = () => submit(true);
  el("family-form").onsubmit = event => { event.preventDefault(); void submit(false); };
  async function openSavedFamily(id, message) {
    try {
      await switchFamily(id);
      notice(message);
    } catch (err) {
      if (err.status === 401) showLogin();
      else notice(message + " 暂时无法打开手账，请刷新后重试。", true);
    } finally { sheet.close(); }
  }
  async function submit(remove) {
    if (writing || current()?.family?.id !== editingFamily) return;
    const familyId = editingFamily, userId = current().userId;
    const stillEditing = () => sheet.open && current()?.userId === userId && current()?.family?.id === familyId;
    writing = true;
    const submitButton = el(remove ? "remove-confirm" : "family-save");
    submitButton.disabled = true;
    el("family-error").textContent = "";
    try {
      if (remove) {
        await write("members", "DELETE", { username: target.username }, familyId);
        if (!stillEditing()) return;
        if (target.id === userId) return await openSavedFamily(null, "已退出家庭。");
        await home();
        notice("家庭成员已更新。");
      } else {
        const chosen = el("family-form").elements["family-role"].value;
        const role = chosen === "其他" ? el("role-custom").value.trim() : chosen;
        if (mode === "house" || mode === "join") {
          const joining = mode === "join";
          const result = joining
            ? await write("families/join", "POST", { code: el("join-code").value.trim(), role })
            : await write("families", "POST", { name: el("house-name").value.trim(), role });
          if (!stillEditing()) return;
          await openSavedFamily(result.familyId, joining ? "已加入家庭。" : "家庭已建好，可以添加第一门课了。");
        } else {
          const adding = mode === "add";
          await write("members", adding ? "POST" : "PATCH", {
            username: adding ? el("member-account").value.trim() : target.username, role
          }, familyId);
          if (!stillEditing()) return;
          await home();
          notice(adding ? "家人已加入，可以一起记课啦。" : "称呼已更新。");
        }
      }
    } catch (err) { if (stillEditing()) failure(err, "family-error"); }
    finally { writing = false; submitButton.disabled = false; }
  }
  const formatTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
  async function readHistory() {
    const version = ++historyVersion, id = current().family.id;
    el("activity-list").replaceChildren();
    el("activity-retry").hidden = true;
    el("activity-status").textContent = "正在翻手账…";
    try {
      const data = await api("history", {}, id);
      if (version !== historyVersion || !history.open || id !== current()?.family?.id) return;
      const rows = data.entries.map(entry => {
        const row = node("li", ""), info = node("div", "");
        info.append(node("strong", entry.role + " · @" + entry.username), node("p", entry.detail), node("small", formatTime.format(new Date(entry.time.replace(" ", "T") + "Z"))));
        row.append(portrait(entry.role), info);
        return row;
      });
      el("activity-list").replaceChildren(...rows);
      el("activity-status").textContent = rows.length ? "" : "这里还没有操作记录。";
    } catch (err) {
      if (version === historyVersion && history.open) { failure(err, "activity-status"); el("activity-retry").hidden = false; }
    }
  }
  el("history-open").onclick = () => {
    closeMenu();
    el("activity-family").textContent = current().family.name;
    history.showModal();
    el("activity-list").scrollTop = 0;
    void readHistory();
  };
  el("activity-close").onclick = () => history.close();
  el("activity-retry").onclick = readHistory;
  function close() {
    listVersion++;
    historyVersion++;
    sheet.close();
    history.close();
    closeMenu();
    tour.stop();
    mode = target = editingFamily = null;
    familySignature = "";
    el("family-form").reset();
    el("invite-url").value = "";
    el("invite-details").open = false;
    el("invite-ready").hidden = true;
    opener.removeAttribute("aria-label");
    el("family-heading").textContent = "我的家庭";
    for (const id of ["family-list", "member-list", "activity-list", "role-grid", "family-name",
      "activity-family", "activity-status", "invite-status", "invite-code", "invite-expiry",
      "remove-copy", "family-error"]) el(id).replaceChildren();
  }
  return { render, close, afterCourse: tour.afterCourse, stopTour: tour.stop, reset() { close(); tour.reset(); } };
}
