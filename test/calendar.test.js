import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery as splitSqlQuery } from "wrangler";

const origin = "https://test.local";
const password = "new!课程#123";
const calendarInstant = "2028-02-29T18:00:00Z";
const period = { first: "2027-12-01", last: "2028-05-31", total: 2 };
const migrationDir = new URL("../migrations/", import.meta.url);

async function migrate(db, first = 1, last = Infinity) {
  const files = (await readdir(migrationDir)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (version < first || version > last) continue;
    const sql = await readFile(new URL(file, migrationDir), "utf8");
    await db.batch(splitSqlQuery(sql).map(statement => db.prepare(statement)));
  }
}

async function startApp(t, { migrateOnStart = true, fixedClock = true } = {}) {
  // The calendar clock is March 1 in Shanghai and February 29 in UTC.
  const clock = fixedClock ? `const NativeDate = globalThis.Date;
    const fixedNow = ${Date.parse(calendarInstant)};
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixedNow])); }
      static now() { return fixedNow; }
    };\n` : "";
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-05-01", d1Databases: ["DB"],
    serviceBindings: { ASSETS: async () => new Response(await readFile(new URL("../public/index.html", import.meta.url)), {
      headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"static-template"' }
    }) },
    bindings: { CLASS_TIME_ZONE: "Asia/Shanghai" },
    script: clock + await readFile(new URL("../src/worker.js", import.meta.url), "utf8")
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  if (migrateOnStart) await migrate(db);

  async function call(path, { method = "GET", body, cookie, familyId, headers = {} } = {}) {
    const requestHeaders = new Headers(headers);
    if (cookie) requestHeaders.set("Cookie", cookie);
    if (familyId) requestHeaders.set("X-Family-Id", String(familyId));
    if (body) requestHeaders.set("Content-Type", "application/json");
    const res = await runtime.dispatchFetch(origin + "/api/" + path, {
      method, headers: requestHeaders, body: body && JSON.stringify(body)
    });
    return { status: res.status, cookie: res.headers.get("Set-Cookie"), data: await res.json() };
  }
  const post = (path, body, cookie) => call(path, { method: "POST", body, cookie });
  async function session(route, username, secret = password) {
    const res = await post(route, { username, password: secret });
    assert.equal(res.status, route === "register" ? 201 : 200, route + " " + username);
    assert.match(res.cookie, /HttpOnly; Secure; SameSite=Lax/);
    return res.cookie.split(";")[0];
  }
  async function family(cookie, name = "小星星的家") {
    const res = await post("families", { name, role: "妈妈" }, cookie);
    assert.equal(res.status, 201);
    return res.data.familyId;
  }
  const check = (date, cookie, method = "PUT") => call("checkins/" + date, { method, cookie });
  return { runtime, db, call, post, session, family, check };
}

test("首页直接显示登录或家庭入口，安全携带当前账号的日历并支持读取失败重试", async t => {
  const { runtime, session, family, db, post } = await startApp(t);
  async function home(cookie = "") {
    const response = await runtime.dispatchFetch(origin + "/", { headers: { Cookie: cookie, "If-None-Match": '"static-template"' } });
    assert.match(response.headers.get("Cache-Control"), /private, no-store/);
    assert.equal(response.headers.get("ETag"), null);
    return { status: response.status, html: await response.text() };
  }
  const visible = (html, id) => !html.match(new RegExp('<section id="' + id + '"([^>]*)>'))[1].includes(" hidden");
  for (const cookie of ["", "__Host-class_session=" + "0".repeat(64)]) {
    const { status, html } = await home(cookie);
    assert.equal(status, 200);
    assert.ok(visible(html, "login"));
    assert.ok(!visible(html, "journal"));
    assert.match(html, /<template id="entry-calendar"><\/template>/);
  }
  const cookie = await session("register", "home-tester");
  assert.ok(visible((await home(cookie)).html, "family-welcome"));
  const name = "<星星&月亮>";
  await family(cookie, name);
  const { html } = await home(cookie);
  assert.ok(visible(html, "journal"));
  assert.ok(!visible(html, "login"));
  assert.match(html, /&lt;星星&amp;月亮&gt;/);
  assert.ok(!html.includes(name));
  assert.match(html, /<section id="journal"[^>]* data-opening="empty"/);
  assert.equal((await post("courses", { ...period, name: "早教课" }, cookie)).status, 201);
  assert.match((await home(cookie)).html, /<section id="journal"[^>]* data-opening="courses"/);
  assert.ok(!(await home()).html.includes("home-tester"));
  await db.prepare("DROP TABLE sessions").run();
  const failure = await home(cookie);
  assert.equal(failure.status, 503);
  assert.ok(visible(failure.html, "load-error"));
  assert.ok(!visible(failure.html, "login"));
  assert.equal((await home()).status, 200);
});

test("旧手账迁移保留原始打卡、账号归属和邀请码的七日过渡期", async t => {
  // Migration deadlines use SQLite's wall clock, so run the Worker on the same clock.
  const { db, call, post, session } = await startApp(t, { migrateOnStart: false, fixedClock: false });
  await migrate(db, 1, 1);
  const oldPassword = randomBytes(18).toString("hex");
  for (const username of ["one", "two"]) {
    const salt = randomBytes(16).toString("hex");
    const hash = pbkdf2Sync(oldPassword, salt, 100000, 32, "sha512").toString("hex");
    await db.prepare("INSERT INTO users(username,display_name,password_hash,salt) VALUES (?,?,?,?)")
      .bind(username, username, hash, salt).run();
  }
  await db.prepare("INSERT INTO checkins(user_id,class_date,created_at) VALUES (1,?,?)")
    .bind("2026-11-09", "2026-11-09 01:23:45").run();
  await migrate(db, 2, 7);
  const activeCode = "abcd1234ef567890", expiredCode = "1234567890abcdef";
  await db.prepare("UPDATE family_codes SET code=CASE family_id WHEN 1 THEN ? ELSE ? END")
    .bind(activeCode, expiredCode).run();
  const clock = db.prepare("SELECT unixepoch() AS now");
  const before = await clock.first("now");
  await migrate(db, 8);
  const after = await clock.first("now");
  const week = 7 * 24 * 60 * 60;
  for (const code of [activeCode, expiredCode]) {
    const expires = await db.prepare("SELECT expires_at FROM family_codes WHERE code=?").bind(code).first("expires_at");
    assert.ok(expires >= before + week && expires <= after + week, "deadline must be seven days after migration");
  }

  const owner = await session("login", "one", oldPassword);
  const other = await session("login", "two", oldPassword);
  const calendar = (await call("calendar", { cookie: owner })).data;
  assert.deepEqual(calendar.dates, ["2026-11-09"]);
  assert.deepEqual(calendar.markedBy, { "2026-11-09": "one" });
  assert.equal(await db.prepare("SELECT created_at FROM cycle_checkins").first("created_at"), "2026-11-09 01:23:45");
  assert.deepEqual((await call("calendar", { cookie: other })).data.dates, []);
  const members = await call("members", { cookie: owner });
  assert.equal(members.status, 200);
  assert.ok(!Object.hasOwn(members.data, "code"));

  const visitor = await session("register", "visitor");
  const join = code => post("families/join", { code, role: "小姨" }, visitor);
  assert.equal((await join("ABCD-1234-EF56-7890")).data.familyId, calendar.family.id);
  assert.equal((await join(activeCode)).status, 200);
  const events = (await call("history", { cookie: owner })).data.entries;
  assert.equal(events.filter(e => e.username === "visitor" && e.detail === "通过邀请码加入家庭").length, 1);
  assert.equal((await call("members", { method: "DELETE", cookie: visitor, body: { username: "visitor" } })).status, 200);
  assert.equal((await join(activeCode)).status, 404);
  assert.equal(await db.prepare("SELECT code FROM family_codes WHERE family_id=?").bind(calendar.family.id).first(), null);

  await db.prepare("UPDATE family_codes SET expires_at=unixepoch() WHERE code=?").bind(expiredCode).run();
  assert.equal((await join(expiredCode)).status, 404);
  assert.equal((await call("calendar", { cookie: visitor })).data.family, null);
});

test("注册密码和账号边界、跨设备引导和独立登出", async t => {
  const { call, post, session, family } = await startApp(t);
  for (const [candidate, status] of [
    ["a!".repeat(3) + "1", 400], ["a!".repeat(8) + "1", 400], ["星🌻@!1234", 201], ["$!".repeat(8), 201]
  ]) {
    const res = await post("register", { username: "boundary" + candidate.length, password: candidate });
    assert.equal(res.status, status);
  }
  assert.equal((await call("calendar")).status, 401);
  const mobile = await session("register", "three");
  const desktop = await session("login", "three");
  assert.equal((await post("register", { username: "THREE", password })).status, 409);
  const welcome = (await call("calendar", { cookie: mobile })).data;
  assert.equal(welcome.family, null);
  assert.deepEqual(welcome.families, []);
  assert.equal((await call("history", { cookie: mobile })).status, 403);
  assert.equal((await post("courses", { ...period, name: "我的课程" }, mobile)).status, 403);
  assert.equal(welcome.guideDone, false);
  await family(mobile);
  assert.equal((await post("guide", {}, mobile)).status, 200);
  assert.equal((await call("calendar", { cookie: desktop })).data.guideDone, true);
  assert.equal((await post("logout", {}, mobile)).status, 200);
  assert.equal((await call("calendar", { cookie: mobile })).status, 401);
  assert.equal((await call("calendar", { cookie: desktop })).status, 200);
});

test("同一来源的其他账号成功登录后，目标账号的十次失败上限仍然有效", async t => {
  const { post, session } = await startApp(t);
  await session("register", "one");
  await session("register", "two");
  const wrongPassword = { username: "one", password: "wrong" };
  for (let i = 0; i < 9; i++) {
    assert.equal((await post("login", wrongPassword)).status, 401);
  }
  await session("login", "two");
  assert.equal((await post("login", wrongPassword)).status, 401);
  assert.equal((await post("login", { username: "one", password })).status, 429);
});

test("同一家庭跨设备同步打卡，两台设备争用最后一课时只扣一次", async t => {
  const { call, post, session, family, check } = await startApp(t);
  const mobile = await session("register", "one");
  const desktop = await session("login", "one");
  const other = await session("register", "two");
  for (const cookie of [mobile, other]) {
    await family(cookie);
    assert.equal((await post("courses", { ...period, name: "我的课程" }, cookie)).status, 201);
  }
  assert.equal((await call("calendar", { cookie: mobile })).data.today, "2028-03-01");
  const date = "2028-02-28";
  assert.deepEqual((await check(date, mobile)).data.dates, [date]);
  assert.deepEqual((await check(date, mobile)).data.dates, [date]);
  assert.deepEqual((await call("calendar", { cookie: desktop })).data.dates, [date]);
  assert.deepEqual((await call("calendar", { cookie: other })).data.dates, []);
  assert.deepEqual((await check(date, other)).data.dates, [date]);
  for (const invalid of ["2028-03-02", "2028-02-30", "2027-11-30", "2028-06-01"]) {
    assert.equal((await check(invalid, mobile)).status, 400, invalid);
  }
  assert.equal((await call("checkins/" + date, {
    method: "DELETE", cookie: other, headers: { Origin: "https://elsewhere.example" }
  })).status, 403);
  const last = await Promise.all([check("2028-02-29", mobile), check("2028-03-01", desktop)]);
  assert.deepEqual(last.map(r => r.status).sort(), [200, 409]);
  assert.equal((await check(date, mobile)).data.dates.length, period.total);
  assert.equal((await check(date, desktop, "DELETE")).data.dates.length, 1);
  assert.equal((await check("2028-02-27", mobile)).data.dates.length, period.total);
  assert.deepEqual((await call("calendar", { cookie: other })).data.dates, [date]);
});

test("跨年续课和同日多课分别统计，删除级联清理且不复用旧设备的课程 ID", async t => {
  const { db, call, post, session, family, check } = await startApp(t);
  const owner = await session("register", "one");
  const desktop = await session("login", "one");
  const other = await session("register", "two");
  await family(owner);
  await family(other);
  const first = await post("courses", { name: "启蒙课", first: "2026-11-01", last: "2027-11-30", total: 35 }, owner);
  assert.equal(first.status, 201);
  assert.equal(first.data.startCourseGuide, true);
  const original = (await call("calendar", { cookie: desktop })).data;
  assert.equal(original.courseGuideDone, true);
  const courseId = original.periods[0].courseId;
  const coursePath = "courses/" + courseId;
  assert.equal((await call(coursePath, { method: "PATCH", body: { name: "早教班" }, cookie: owner })).status, 200);
  assert.deepEqual((await check("2027-03-01", owner)).data.dates, ["2027-03-01"]);
  const renewal = await post(coursePath + "/cycles", period, owner);
  assert.equal(renewal.status, 201);
  assert.equal((await post(coursePath + "/cycles", period, owner)).status, 409);
  const fitnessClass = await post("courses", { ...period, name: "体能班" }, owner);
  assert.equal(fitnessClass.status, 201);
  assert.equal(fitnessClass.data.startCourseGuide, false);
  assert.equal((await post("courses", { ...period, name: "体能班" }, owner)).status, 409);
  const early = "?cycle=" + renewal.data.cycleId, fitness = "?cycle=" + fitnessClass.data.cycleId;
  const day = "2028-02-29";
  assert.deepEqual((await call("calendar" + early, { cookie: owner })).data.dates, []);
  assert.deepEqual((await check(day + early, owner)).data.dates, [day]);
  assert.deepEqual((await check(day + fitness, owner)).data.dates, [day]);
  const current = (await check("2028-03-01" + early, owner)).data;
  const stats = current.periods.find(p => p.id === renewal.data.cycleId);
  assert.deepEqual([stats.thisMonth, stats.total - stats.done], [1, 0]);
  assert.equal(current.periods.find(p => p.id === fitnessClass.data.cycleId).thisMonth, 0);
  assert.equal((await check("2028-02-28" + early, owner)).status, 409);
  assert.deepEqual((await check(day + fitness, owner, "DELETE")).data.dates, []);
  assert.equal((await call("calendar" + early, { cookie: desktop })).data.dates.length, 2);
  assert.deepEqual((await call("calendar", { cookie: owner })).data.dates, ["2027-03-01"]);
  assert.equal((await call("calendar" + early, { cookie: other })).status, 404);
  assert.equal((await check(day + early, other, "DELETE")).status, 404);
  assert.equal((await post(coursePath + "/cycles", period, other)).status, 404);
  const overlap = await post(coursePath + "/cycles", { ...period, last: "2028-06-30" }, owner);
  assert.equal(overlap.status, 201);
  assert.equal((await check(day + "?cycle=" + overlap.data.cycleId, owner)).status, 409);
  assert.equal((await post("courses", { ...period, first: "2027-02-29", name: "无效" }, owner)).status, 400);

  assert.equal((await call(coursePath, { method: "DELETE", cookie: other })).status, 404);
  assert.equal((await call(coursePath, { method: "DELETE", cookie: owner })).status, 200);
  assert.equal((await call("calendar" + early, { cookie: desktop })).status, 404);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM cycle_checkins WHERE course_id=?").bind(courseId).first("n"), 0);
  const remaining = (await call("calendar", { cookie: owner })).data.periods;
  assert.deepEqual(remaining.map(p => p.id), [fitnessClass.data.cycleId]);
  const lastPath = "courses/" + remaining[0].courseId;
  assert.equal((await call(lastPath, { method: "DELETE", cookie: owner })).status, 200);
  assert.equal((await call("calendar", { cookie: owner })).data.cycleId, null);
  const replacement = await post("courses", { ...period, name: "新课" }, owner);
  assert.ok(replacement.data.cycleId > remaining[0].id);
  assert.equal(replacement.data.startCourseGuide, false);
  assert.equal((await call(lastPath, { method: "DELETE", cookie: owner })).status, 404);
});

test("同名改课不记历史，并发改名的审计与每次生效的课程名一致", async t => {
  const { call, post, session, family } = await startApp(t);
  const mobile = await session("register", "one");
  const desktop = await session("login", "one");
  await family(mobile);
  const original = "启蒙课";
  assert.equal((await post("courses", { ...period, name: original }, mobile)).status, 201);
  const calendar = () => call("calendar", { cookie: desktop });
  const coursePath = "courses/" + (await calendar()).data.periods[0].courseId;
  const rename = (name, cookie) => call(coursePath, { method: "PATCH", body: { name }, cookie });
  const history = async () => (await call("history", { cookie: desktop })).data.entries
    .map(event => event.detail).filter(detail => detail.startsWith("将课程")).reverse();

  assert.equal((await rename(original, mobile)).status, 200);
  assert.deepEqual(await history(), []);
  const names = ["绘画课", "游泳课"];
  const writes = await Promise.all([rename(names[0], mobile), rename(names[1], desktop)]);
  for (const write of writes) assert.ok([200, 409].includes(write.status), "unexpected status " + write.status);
  const applied = names.filter((_, index) => writes[index].status === 200);
  const finalName = (await calendar()).data.periods[0].name;
  assert.ok(applied.includes(finalName));
  const order = [original, ...applied.filter(name => name !== finalName), finalName];
  assert.deepEqual(await history(), order.slice(1).map((name, i) => "将课程「" + order[i] + "」改名为「" + name + "」"));
});

test("家庭成员权限和历史记录保留实际操作者与当时的称呼", async t => {
  const { db, call, session, family } = await startApp(t);
  const owner = await session("register", "one"), parent = await session("register", "two");
  const child = await session("register", "three");
  const familyId = await family(owner);
  const personalFamily = await family(parent, "自己的家");
  const shared = (path, cookie, method = "GET", body) => call(path, { cookie, familyId, method, body });
  assert.equal((await shared("calendar", parent)).status, 403);
  assert.equal((await shared("members", owner, "POST", { username: "two", role: "爸爸" })).status, 201);
  assert.equal((await shared("members", parent, "POST", { username: "three", role: "小星星" })).status, 201);
  assert.equal((await shared("members", parent, "POST", { username: "three", role: "小星星" })).status, 409);
  assert.equal((await shared("members", parent, "PATCH", { username: "three", role: "小姨" })).status, 200);
  const together = await shared("courses", owner, "POST", { ...period, name: "一起游泳" });
  const personalCalendar = (await call("calendar", { cookie: parent })).data;
  assert.equal(personalCalendar.family.id, personalFamily);
  assert.deepEqual(personalCalendar.periods, []);
  assert.deepEqual(personalCalendar.families.map(f => f.id), [personalFamily, familyId]);
  const day = "2028-02-29", when = "checkins/" + day + "?cycle=" + together.data.cycleId;
  assert.equal((await shared(when, child, "PUT")).data.markedBy[day], "three");
  assert.equal((await shared(when, parent, "PUT")).data.markedBy[day], "three");
  assert.equal((await shared(when, parent, "DELETE")).status, 200);
  assert.equal((await shared(when, parent, "DELETE")).status, 200);
  assert.equal((await shared("members", parent, "DELETE", { username: "three" })).status, 403);
  assert.equal((await shared("members", owner, "DELETE", { username: "three" })).status, 200);
  assert.equal((await shared("history", child)).status, 403);
  const events = (await shared("history", parent)).data.entries;
  assert.deepEqual(events.filter(e => e.detail.startsWith("打卡")).map(e => [e.username, e.role]), [["three", "小姨"]]);
  assert.deepEqual(events.filter(e => e.detail.startsWith("撤销")).map(e => e.username), ["two"]);
  assert.deepEqual(events.filter(e => e.detail.startsWith("添加成员")).map(e => e.username), ["two", "one"]);
  assert.equal(events.find(e => e.detail.startsWith("移除成员")).username, "one");

  const actor = (await shared("calendar", owner)).data.userId;
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1005)
    INSERT INTO family_events(family_id,actor_id,actor_role,detail) SELECT ?,?,'家人','测试记录 '||n FROM seq`)
    .bind(familyId, actor).run();
  const recent = (await shared("history", parent)).data.entries;
  assert.equal(recent.length, 100);
  assert.equal(recent[0].detail, "测试记录 1005");
  assert.equal(recent.at(-1).detail, "测试记录 906");
  assert.deepEqual((await shared("history?limit=1000&before=1", parent)).data.entries, recent);
});

test("新家庭使用限时短码和邀请链接，预览不加入，移除成员同时撤销两种邀请", async t => {
  const { runtime, db, call, post, session, family } = await startApp(t);
  const owner = await session("register", "one"), parent = await session("register", "two");
  const visitor = await session("register", "visitor");
  const familyId = await family(owner);
  const shared = (path, cookie, method = "GET", body) => call(path, { familyId, cookie, method, body });
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM family_codes WHERE family_id=?").bind(familyId).first("n"), 0);
  assert.equal((await shared("members", owner, "POST", { username: "two", role: "爸爸" })).status, 201);
  assert.equal((await shared("members", owner, "POST", { username: "@visitor", role: "小姨" })).status, 400);
  assert.equal((await shared("courses", owner, "POST", { ...period, name: "一起游泳" })).status, 201);
  assert.equal((await shared("invitations", visitor, "POST")).status, 403);
  const invite = (await shared("invitations", parent, "POST")).data;
  assert.match(invite.code, /^[2-9A-HJ-NP-Z]{6}$/);
  assert.equal(invite.expiresAt, Date.parse(calendarInstant) / 1000 + 7 * 24 * 60 * 60);
  assert.deepEqual((await shared("invitations", parent, "POST")).data, invite);
  const url = origin + invite.path;
  const preview = await runtime.dispatchFetch(url, { headers: { "User-Agent": "LinkPreview", Accept: "text/html" } });
  assert.equal(preview.status, 200);
  const markup = await preview.text();
  assert.ok(markup.includes('<meta property="og:title" content="爸爸（@two）邀请你加入家庭「小星星的家」">'));
  assert.ok(markup.includes('<meta property="og:image" content="https://test.local/garden.jpg">'));
  assert.ok(markup.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(!markup.includes("一起游泳"));
  assert.equal((await call("calendar", { cookie: visitor })).data.family, null);
  const join = code => post("families/join", { code, role: "小姨" }, visitor);
  assert.equal((await join("not-a-code")).status, 400);
  assert.equal((await join(invite.code.toLowerCase())).data.familyId, familyId);
  assert.equal((await runtime.dispatchFetch(url, { headers: { Cookie: visitor } })).status, 200);
  assert.equal((await shared("members", owner, "DELETE", { username: "visitor" })).status, 200);
  assert.equal((await join(invite.code)).status, 404);
  assert.equal((await runtime.dispatchFetch(url)).status, 404);

  const renewed = (await shared("invitations", parent, "POST")).data;
  const acceptUrl = origin + renewed.path;
  const accept = () => runtime.dispatchFetch(acceptUrl, {
    method: "POST", headers: { Cookie: visitor, Origin: origin }, redirect: "manual"
  });
  const joined = await accept();
  assert.equal(joined.status, 303);
  assert.equal(joined.headers.get("Location"), "/?family=" + familyId);
  assert.equal((await accept()).status, 303);
  const events = (await shared("history", parent)).data.entries;
  assert.equal(events.filter(e => e.username === "visitor" && e.detail === "通过 @two 的邀请加入家庭").length, 2);
  await db.prepare("UPDATE family_invitations SET expires_at=0 WHERE short_code=?").bind(renewed.code).run();
  assert.equal((await runtime.dispatchFetch(acceptUrl)).status, 404);
  assert.equal((await join(renewed.code)).status, 404);
});
