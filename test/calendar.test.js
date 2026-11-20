import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("旧手账迁移、跨设备登录、不同课程同日打卡、跨年续课与账号隔离", async t => {
  const password = randomBytes(18).toString("hex");
  // Fixed instant is March 1 in Shanghai and February 29 in UTC.
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-05-01", d1Databases: ["DB"],
    bindings: { CLASS_TIME_ZONE: "Asia/Shanghai" },
    script: `const NativeDate = globalThis.Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : ["2028-02-29T18:00:00Z"])); }
        static now() { return NativeDate.parse("2028-02-29T18:00:00Z"); }
      };\n` + await readFile(new URL("../src/worker.js", import.meta.url), "utf8")
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  const sql = await readFile(new URL("../migrations/0001_calendar.sql", import.meta.url), "utf8");
  for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  async function call(path, { method = "GET", body, headers = {}, cookie } = {}) {
    if (cookie) headers.Cookie = cookie;
    if (body) headers["Content-Type"] = "application/json";
    const res = await runtime.dispatchFetch("https://test.local/api/" + path, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, cookie: res.headers.get("Set-Cookie"), data: await res.json() };
  }
  const account = username => ({ username, password: username.toLowerCase() === "three" ? "new!课程#123" : password });
  const create = username => call("register", { method: "POST", body: account(username) });
  const login = async username => {
    const r = await call("login", { method: "POST", body: account(username) });
    assert.equal(r.status, 200);
    assert.match(r.cookie, /HttpOnly; Secure; SameSite=Lax/);
    return r.cookie.split(";")[0];
  };
  const check = (date, cookie, method = "PUT") => call("checkins/" + date, { method, cookie });

  for (const username of ["one","two"]) {
    const salt = randomBytes(16).toString("hex");
    const hash = pbkdf2Sync(password, salt, 100000, 32, "sha512").toString("hex");
    await db.prepare("INSERT INTO users(username,display_name,password_hash,salt) VALUES (?,?,?,?)").bind(username,username,hash,salt).run();
  }
  // Seed the original schema, then apply the same migration used in production.
  await db.prepare("INSERT INTO checkins(user_id,class_date,created_at) SELECT id,?,? FROM users WHERE username=?")
    .bind("2026-11-09", "2026-11-09 01:23:45", "one").run();
  const migration = await readFile(new URL("../migrations/0002_courses.sql", import.meta.url), "utf8");
  await db.batch(migration.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const stableIds = await readFile(new URL("../migrations/0003_stable_course_ids.sql", import.meta.url), "utf8");
  await db.batch(stableIds.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const familyMigration = await readFile(new URL("../migrations/0004_families.sql", import.meta.url), "utf8");
  await db.batch(familyMigration.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const entryMigration = await readFile(new URL("../migrations/0005_family_entry.sql", import.meta.url), "utf8");
  await db.batch(entryMigration.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const invitesMigration = await readFile(new URL("../migrations/0006_share_invitations.sql", import.meta.url), "utf8");
  await db.batch(invitesMigration.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  const guideMigration = await readFile(new URL("../migrations/0007_first_course_guide.sql", import.meta.url), "utf8");
  await db.batch(guideMigration.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  assert.equal((await db.prepare("SELECT created_at FROM cycle_checkins").first()).created_at, "2026-11-09 01:23:45");
  assert.equal((await call("calendar")).status, 401);
  const mobile = await login("one"), desktop = await login("one"), other = await login("two");
  const date = "2027-03-01";
  const original = (await call("calendar", { cookie: mobile })).data;
  assert.equal(original.today, "2028-03-01");
  assert.deepEqual(original.dates, ["2026-11-09"]);
  assert.deepEqual((await call("calendar", { cookie: other })).data.dates, []);
  await check("2026-11-09", mobile, "DELETE");
  assert.deepEqual((await check(date, mobile)).data.dates, [date]);
  assert.deepEqual((await check(date, mobile)).data.dates, [date]);
  assert.deepEqual((await call("calendar", { cookie: desktop })).data.dates, [date]);
  assert.deepEqual((await call("calendar", { cookie: other })).data.dates, []);
  assert.deepEqual((await check(date, other)).data.dates, [date]);
  assert.deepEqual((await check(date, desktop, "DELETE")).data.dates, []);
  assert.deepEqual((await call("calendar", { cookie: mobile })).data.dates, []);
  assert.deepEqual((await call("calendar", { cookie: other })).data.dates, [date]);
  for (const invalid of ["2028-03-02", "2027-02-30", "2026-10-31", "2027-12-01"]) {
    assert.equal((await check(invalid, mobile)).status, 400);
  }
  assert.equal((await call("checkins/" + date, { method: "DELETE", cookie: other, headers: { Origin: "https://elsewhere.example" } })).status, 403);
  const days = Array.from({ length: 36 }, (_, i) => new Date(Date.UTC(2026, 10, i + 1)).toISOString().slice(0, 10));
  for (const d of days.slice(0, 34)) assert.equal((await check(d, mobile)).status, 200);
  const last = await Promise.all([check(days[34], mobile), check(days[35], desktop)]);
  assert.deepEqual(last.map(r => r.status).sort(), [200, 409]);
  assert.equal((await check(days[0], mobile)).data.dates.length, 35);
  await check(days[0], desktop, "DELETE");
  assert.equal((await check(date, mobile)).data.dates.length, 35);
  const newPeriod = { first: "2027-12-01", last: "2028-05-31", total: 2 };
  const createCycle = (path, body, cookie = mobile) => call(path, { method: "POST", body, cookie });
  const coursePath = "courses/" + original.periods[0].courseId;
  assert.equal((await call(coursePath, { method: "PATCH", body: { name: "早教班" }, cookie: mobile })).status, 200);
  const renewal = await createCycle(coursePath + "/cycles", newPeriod);
  assert.equal(renewal.status, 201);
  assert.equal((await createCycle(coursePath + "/cycles", newPeriod)).status, 409);
  const otherClass = await createCycle("courses", { ...newPeriod, name: "体能班" });
  assert.equal(otherClass.status, 201);
  assert.equal(otherClass.data.startCourseGuide,true);
  assert.equal((await call("calendar",{cookie:desktop})).data.courseGuideDone,true);
  assert.equal((await createCycle("courses", { ...newPeriod, name: "体能班" })).status, 409);
  const cycleQuery = result => "?cycle=" + result.data.cycleId;
  const early = cycleQuery(renewal), fitness = cycleQuery(otherClass);
  assert.deepEqual((await call("calendar" + early, { cookie: mobile })).data.dates, []);
  const day = "2028-02-29";
  assert.deepEqual((await check(day + early, mobile)).data.dates, [day]);
  assert.deepEqual((await check(day + fitness, mobile)).data.dates, [day]);
  assert.equal((await check("2028-03-02" + early, mobile)).status, 400);
  assert.equal((await check("2027-11-30" + early, mobile)).status, 400);
  const currentStats = (await check("2028-03-01" + early, mobile)).data;
  assert.equal(currentStats.dates.length, 2);
  const earlyStats = currentStats.periods.find(p => p.id === renewal.data.cycleId);
  assert.deepEqual([earlyStats.thisMonth, earlyStats.total - earlyStats.done], [1, 0]);
  assert.equal(currentStats.periods.find(p => p.id === otherClass.data.cycleId).thisMonth, 0);
  assert.equal((await check("2028-02-28" + early, mobile)).status, 409);
  assert.deepEqual((await check(day + fitness, mobile, "DELETE")).data.dates, []);
  assert.equal((await call("calendar" + early, { cookie: desktop })).data.dates.length, 2);
  assert.equal((await call("calendar", { cookie: mobile })).data.dates.length, 35);
  assert.equal((await call("calendar" + early, { cookie: other })).status, 404);
  assert.equal((await check(day + early, other, "DELETE")).status, 404);
  assert.equal((await createCycle(coursePath + "/cycles", newPeriod, other)).status, 404);
  const overlap = await createCycle(coursePath + "/cycles", { ...newPeriod, last: "2028-06-30" });
  assert.equal((await check(day + cycleQuery(overlap), mobile)).status, 409);
  assert.equal((await createCycle("courses", { ...newPeriod, first: "2027-02-29", name: "无效" })).status, 400);
  for (const [candidate, status] of [["a!".repeat(3) + "1", 400], ["a!".repeat(8) + "1", 400],
    ["星🌻@!1234", 201], ["$!".repeat(8), 201]]) {
    const result = await call("register", { method: "POST", body: { username: "boundary" + candidate.length, password: candidate } });
    assert.equal(result.status, status);
  }
  const signup = await create("three");
  assert.equal(signup.status, 201);
  assert.match(signup.cookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await create("THREE")).status,409);
  const fresh = await login("three");
  const welcome = (await call("calendar", { cookie: fresh })).data;
  assert.equal(welcome.family, null);
  assert.deepEqual(welcome.families, []);
  assert.equal((await call("history", { cookie: fresh })).status, 403);
  assert.equal((await createCycle("courses", { ...newPeriod,name:"我的课程" }, fresh)).status,403);
  assert.equal((await createCycle("families", { name:"新家庭",role:"妈妈" }, fresh)).status,201);
  assert.equal((await createCycle("courses", { ...newPeriod, name: "早教班" }, fresh)).status, 201);
  assert.equal((await call(coursePath, { method: "DELETE", cookie: other })).status, 404);
  assert.equal((await call(coursePath, { method: "DELETE", cookie: mobile })).status, 200);
  assert.equal((await call("calendar" + early, { cookie: desktop })).status, 404);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM cycle_checkins WHERE course_id=?").bind(original.periods[0].courseId).first("n"), 0);
  assert.deepEqual((await call("calendar", { cookie: mobile })).data.periods.map(p => p.id), [otherClass.data.cycleId]);
  const lastCourse = (await call("calendar", { cookie: fresh })).data.periods[0];
  const lastPath = "courses/" + lastCourse.courseId;
  assert.equal((await call(lastPath, { method: "DELETE", cookie: fresh })).status, 200);
  assert.equal((await call("calendar", { cookie: fresh })).data.cycleId, null);
  const replacement = await createCycle("courses", { ...newPeriod, name: "新课" }, fresh);
  assert.ok(replacement.data.cycleId > lastCourse.id);
  assert.equal(replacement.data.startCourseGuide,false);
  assert.equal((await call(lastPath, { method: "DELETE", cookie: fresh })).status, 404);
  const made = await createCycle("families", { name: "小星星的家", role: "妈妈" });
  assert.equal(made.status, 201);
  const shared = (path, cookie, method = "GET", body) => call(path, { cookie, method, body, headers: { "X-Family-Id": String(made.data.familyId) } });
  assert.equal((await shared("calendar", other)).status, 403);
  assert.equal((await shared("members", mobile, "POST", { username: "two", role: "爸爸" })).status, 201);
  assert.equal((await shared("members", other, "POST", { username: "three", role: "小星星" })).status, 201);
  assert.equal((await shared("members", other, "POST", { username: "three", role: "小星星" })).status, 409);
  assert.equal((await shared("members", other, "PATCH", { username: "three", role: "小姨" })).status, 200);
  const together = await shared("courses", mobile, "POST", { ...newPeriod, name: "一起游泳" });
  const when = "checkins/" + day + cycleQuery(together);
  assert.equal((await shared(when, fresh, "PUT")).data.markedBy[day], "three");
  assert.equal((await shared(when, other, "PUT")).data.markedBy[day], "three");
  assert.equal((await shared(when, other, "DELETE")).status, 200);
  assert.equal((await shared(when, other, "DELETE")).status, 200);
  assert.equal((await shared("members", other, "DELETE", { username: "three" })).status, 403);
  assert.equal((await shared("members", mobile, "DELETE", { username: "three" })).status, 200);
  assert.equal((await shared("history", fresh)).status, 403);
  const events = (await shared("history", other)).data.entries;
  assert.deepEqual(events.filter(e => e.detail.startsWith("打卡")).map(e => [e.username, e.role]), [["three","小姨"]]);
  assert.deepEqual(events.filter(e => e.detail.startsWith("撤销")).map(e => e.username), ["two"]);
  assert.deepEqual(events.filter(e => e.detail.startsWith("添加成员")).map(e => e.username), ["two","one"]);
  assert.equal(events.find(e => e.detail.startsWith("移除成员")).username, "one");
  const invited = await call("register", {method:"POST",body:{username:"visitor",password:"Visitor!123"}});
  assert.equal(invited.status,201);
  const visitorCookie = invited.cookie.split(";")[0];
  const join = code => call("families/join", { method:"POST",cookie:visitorCookie,body:{code,role:"小姨"} });
  const code = (await shared("members",mobile)).data.code;
  assert.equal((await join("not-a-code")).status,400);
  assert.equal((await join(code.toUpperCase().match(/.{4}/g).join("-"))).data.familyId,made.data.familyId);
  assert.equal((await join(code)).status,200);
  assert.equal((await call("calendar",{cookie:visitorCookie})).data.families.length,1);
  assert.equal((await shared("history",mobile)).data.entries.filter(e=>e.username==="visitor" && e.detail==="通过邀请码加入家庭").length,1);
  assert.equal((await shared("members",mobile,"DELETE",{username:"visitor"})).status,200);
  assert.equal((await join(code)).status,404);
  assert.equal((await call("calendar",{cookie:visitorCookie})).data.family,null);
  assert.equal((await shared("members",mobile,"POST",{username:"@visitor",role:"小姨"})).status,400);
  assert.equal((await shared("invitations",visitorCookie,"POST")).status,403);
  const invite = (await shared("invitations",other,"POST")).data;
  assert.match(invite.code,/^[2-9A-HJ-NP-Z]{6}$/);
  assert.deepEqual((await shared("invitations",other,"POST")).data,invite);
  const inviteUrl = "https://test.local" + invite.path;
  const preview = await runtime.dispatchFetch(inviteUrl,{headers:{"User-Agent":"LinkPreview","Accept":"text/html"}});
  assert.equal(preview.status,200);
  const markup = await preview.text();
  assert.ok(markup.includes('<meta property="og:title" content="爸爸（@two）邀请你加入家庭「小星星的家」">'));
  assert.ok(markup.includes('<meta property="og:image" content="https://test.local/garden.jpg">'));
  assert.ok(markup.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(!markup.includes("一起游泳"));
  assert.equal((await call("calendar",{cookie:visitorCookie})).data.family,null);
  assert.equal((await join(invite.code.toLowerCase())).data.familyId,made.data.familyId);
  assert.equal((await runtime.dispatchFetch(inviteUrl,{headers:{Cookie:visitorCookie}})).status,200);
  assert.equal((await shared("members",mobile,"DELETE",{username:"visitor"})).status,200);
  assert.equal((await join(invite.code)).status,404);
  assert.equal((await runtime.dispatchFetch(inviteUrl)).status,404);
  const renewed = (await shared("invitations",other,"POST")).data;
  const acceptUrl = "https://test.local" + renewed.path;
  const accept = () => runtime.dispatchFetch(acceptUrl,{method:"POST",headers:{Cookie:visitorCookie,Origin:"https://test.local"},redirect:"manual"});
  const joined = await accept();
  assert.equal(joined.status,303);
  assert.equal(joined.headers.get("Location"),"/?family="+made.data.familyId);
  assert.equal((await accept()).status,303);
  assert.equal((await shared("history",other)).data.entries.filter(e=>e.username==="visitor" && e.detail==="通过 @two 的邀请加入家庭").length,2);
  await db.prepare("UPDATE family_invitations SET expires_at=0 WHERE short_code=?").bind(renewed.code).run();
  assert.equal((await runtime.dispatchFetch(acceptUrl)).status,404);
  assert.equal((await join(renewed.code)).status,404);
  await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1005)
    INSERT INTO family_events(family_id,actor_id,actor_role,detail) SELECT ?,?,'家人','测试记录 '||n FROM seq`).bind(original.family.id,original.userId).run();
  const recent = (await call("history",{cookie:desktop})).data.entries;
  assert.equal(recent.length, 100);
  assert.equal(recent[0].detail, "测试记录 1005");
  assert.equal(recent.at(-1).detail, "测试记录 906");
  assert.deepEqual((await call("history?limit=1000&before=1",{cookie:desktop})).data.entries, recent);
  assert.equal(original.guideDone,false);
  assert.equal((await call("guide",{cookie:mobile,method:"POST"})).status,200);
  assert.equal((await call("calendar",{cookie:desktop})).data.guideDone,true);
  assert.equal((await call("logout", { cookie: mobile, method: "POST" })).status, 200);
  assert.equal((await call("calendar", { cookie: mobile })).status, 401);
  assert.equal((await call("calendar", { cookie: desktop })).status, 200);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call("login", { method: "POST", body: { username: "one", password: "wrong" } })).status, 401);
  }
  assert.equal((await call("login", { method: "POST", body: account("one") })).status, 429);
});
