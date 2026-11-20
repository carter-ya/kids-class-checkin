import { portrait, roles } from "./family.js";

const el = id => document.getElementById(id);

export function accessControls(onSubmit) {
  const login = el("login-form");
  const signup = el("signup-template").content.firstElementChild;
  let active = login, role = "家人";
  const field = id => signup.querySelector("#" + id);
  const toggle = field("signup-role-toggle"), grid = field("signup-role-grid");

  function selectRole(name) {
    role = name;
    field("signup-role-name").textContent = name;
    portrait(name, field("signup-avatar"));
    for (const button of grid.children) button.setAttribute("aria-pressed", String(button.value === name));
    grid.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    field("signup-custom-field").hidden = name !== "其他";
    field("signup-custom").required = name === "其他";
  }
  for (const name of [...roles, "家人", "其他"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.value = name;
    button.append(portrait(name), document.createTextNode(name));
    button.onclick = () => {
      selectRole(name);
      (name === "其他" ? field("signup-custom") : toggle).focus();
    };
    grid.append(button);
  }
  selectRole(role);
  toggle.onclick = () => {
    grid.hidden = !grid.hidden;
    toggle.setAttribute("aria-expanded", String(!grid.hidden));
    if (!grid.hidden) grid.querySelector('[aria-pressed="true"]').focus();
  };
  function dismissPicker(event) {
    if (!grid.hidden && !event.target.closest(".signup-picker")) selectRole(role);
  }
  document.addEventListener("click", dismissPicker);
  document.addEventListener("focusin", dismissPicker);
  grid.onkeydown = event => {
    if (event.key === "Escape") { selectRole(role); toggle.focus(); }
  };
  const password = field("signup-password"), confirm = field("confirm-password");
  function validate() {
    const length = [...password.value].length;
    password.setCustomValidity(length && (length < 8 || length > 16) ? "密码需要 8–16 个字符。" : "");
    confirm.setCustomValidity(confirm.value && password.value !== confirm.value ? "两次输入的密码不同，请再确认一次。" : "");
  }
  signup.oninput = validate;
  function mode(signingUp) {
    const username = active.elements.username.value;
    active.reset();
    active = signingUp ? signup : login;
    el("access-fields").replaceChildren(active);
    active.elements.username.value = username;
    selectRole("家人");
    validate();
    for (const button of active.querySelectorAll(".pass button")) {
      active.querySelector("#" + button.getAttribute("aria-controls")).type = "password";
      button.textContent = "显示";
      button.setAttribute("aria-pressed", "false");
    }
    el("access-title").textContent = signingUp ? "创建我的手账" : "打开我的手账";
    el("access-intro").textContent = signingUp ? "和家人一起，记下孩子的每一节课。" : "登录后，记录孩子的每一个上课日。";
    el("access-toggle").textContent = signingUp ? "已有账号？去登录" : "还没有账号？去注册";
    el("login-error").textContent = "";
  }
  el("access-toggle").onclick = () => { mode(active === login); active.elements.username.focus(); };
  el("access-fields").onclick = event => {
    const button = event.target.closest(".pass button");
    if (!button) return;
    const input = el(button.getAttribute("aria-controls"));
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.textContent = reveal ? "隐藏" : "显示";
    button.setAttribute("aria-pressed", String(reveal));
  };
  el("access-fields").onsubmit = async event => {
    event.preventDefault();
    const signingUp = active === signup;
    if (signingUp) { validate(); if (!signup.reportValidity()) return; }
    const payload = { username: active.elements.username.value, password: active.elements.password.value };
    if (signingUp) payload.role = role === "其他" ? field("signup-custom").value.trim() : role;
    const submitter = active.querySelector(".primary");
    submitter.disabled = el("access-toggle").disabled = true;
    try {
      await onSubmit(signingUp ? "register" : "login", payload);
      active.elements.password.value = confirm.value = "";
    } catch (err) { el("login-error").textContent = err.status ? err.message : "网络连接失败，请重试"; }
    finally { submitter.disabled = el("access-toggle").disabled = false; }
  };
  return { reset: () => mode(false) };
}
