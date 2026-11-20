const encoder = new TextEncoder();
const SESSION_AGE = 30 * 24 * 60 * 60;
const COOKIE = "__Host-class_session";
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
const randomHex = length => hex(crypto.getRandomValues(new Uint8Array(length)));
const digest = async value => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

function equal(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-512", salt: encoder.encode(salt), iterations: 100000
  }, key, 256));
}

function json(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...extra } });
}
const error = (message, status) => json({ error: message }, status);
const cookie = (token, age) => COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + age;

async function fields(request) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") return {};
  const data = await request.json().catch(() => null);
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function usernameKey(value) {
  return typeof value === "string" ? value.trim().normalize("NFC").toLowerCase() : "";
}

async function allowAttempt(db, key, now) {
  await db.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").bind(now).run();
  return db.prepare(
    "INSERT INTO login_attempts VALUES (?, 1, ?) ON CONFLICT(client) DO UPDATE SET attempts=attempts+1 WHERE attempts < 10 RETURNING expires_at"
  ).bind(key, now + 600).first();
}

function familyName(value) {
  return typeof value === "string" && value.trim().length <= 70 ? value.trim() : "";
}

function familyRole(value) {
  return typeof value === "string" && value.trim().length <= 20 ? value.trim() : "";
}

async function register(request, db, now) {
  const { username, password, role = "家人" } = await fields(request);
  const name = usernameKey(username);
  const length = typeof password === "string" ? [...password].length : 0;
  if (length < 8 || length > 16) return error("密码需要 8–16 个字符，可以使用特殊符号。", 400);
  if (!/^[\p{L}\p{N}._-]{1,48}$/u.test(name) || !familyRole(role)) {
    return error("账号限 1–48 个字母、汉字、数字、点、短横线或下划线，称呼限 20 个字符。", 400);
  }
  const client = await digest(request.headers.get("CF-Connecting-IP") || "local");
  if (!await allowAttempt(db, "signup-" + client, now)) return error("注册次数过多，请稍后再试", 429);
  const salt = randomHex(16), token = randomHex(32);
  try {
    await db.batch([
      db.prepare("INSERT INTO users(username,display_name,password_hash,salt,preferred_role) VALUES (?,?,?,?,?)")
        .bind(name, name, await passwordHash(password, salt), salt, familyRole(role)),
      db.prepare("INSERT INTO sessions SELECT ?,id,? FROM users WHERE username=?").bind(await digest(token), now + SESSION_AGE, name)
    ]);
  } catch (err) {
    if (String(err.message).includes("UNIQUE constraint failed: users.username")) return error("这个账号已被使用", 409);
    throw err;
  }
  return json({ ok: true }, 201, { "Set-Cookie": cookie(token, SESSION_AGE) });
}

async function login(request, env, now) {
  const { username, password } = await fields(request);
  const name = usernameKey(username);
  if (!name || name.length > 96 || typeof password !== "string" || !password || password.length > 256) {
    return error("请输入有效的账号和密码", 400);
  }
  const client = await digest(request.headers.get("CF-Connecting-IP") || "local");
  const db = env.DB;
  const attempt = await allowAttempt(db, client, now);
  if (!attempt) return error("尝试次数过多，请稍后再试", 429);
  const user = await db.prepare("SELECT id, salt, password_hash FROM users WHERE username=?").bind(name).first();
  const hash = await passwordHash(password, user?.salt || "00000000000000000000000000000000");
  if (!user || !equal(hash, user.password_hash)) return error("账号或密码有误", 401);
  const token = randomHex(32);
  await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE client=?").bind(client),
    db.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").bind(await digest(token), user.id, now + SESSION_AGE)
  ]);
  return json({ ok: true }, 200, { "Set-Cookie": cookie(token, SESSION_AGE) });
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const inviteAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const inviteTTL = 7 * 24 * 60 * 60;

async function issueInvitation(db, familyId, inviterId, now) {
  const read = db.prepare("SELECT short_code AS code,link_token,expires_at AS expiresAt FROM family_invitations WHERE family_id=? AND inviter_id=? AND expires_at>?").bind(familyId, inviterId, now);
  let invite = await read.first();
  for (let attempt = 0; !invite && attempt < 4; attempt++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), n => inviteAlphabet[n % inviteAlphabet.length]).join("");
    try {
      const [, result] = await db.batch([
        db.prepare(`INSERT INTO family_invitations(family_id,inviter_id,short_code,link_token,expires_at)
          SELECT family_id,user_id,?,?,? FROM family_members WHERE family_id=? AND user_id=?
          ON CONFLICT(family_id,inviter_id) DO UPDATE SET short_code=excluded.short_code,link_token=excluded.link_token,
          expires_at=excluded.expires_at WHERE family_invitations.expires_at<=?`)
          .bind(code, randomHex(16), now + inviteTTL, familyId, inviterId, now), read
      ]);
      invite = result.results[0];
      if (!invite) return error("你已不在这个家庭中", 403);
    } catch (err) {
      if (!String(err.message).includes("UNIQUE constraint failed")) throw err;
    }
  }
  if (!invite) return error("暂时无法生成邀请，请重试", 503);
  return json({ code: invite.code, path: "/invite/" + invite.link_token, expiresAt: invite.expiresAt });
}

const invitationSource = `FROM family_invitations i JOIN users u ON u.id=i.inviter_id
  JOIN families f ON f.id=i.family_id JOIN family_members m ON m.family_id=i.family_id AND m.user_id=i.inviter_id`;

async function acceptInvitation(db, user, role, kind, key, now) {
  const legacy = kind === "legacy";
  const source = legacy ? "FROM family_codes i WHERE i.code=?" :
    invitationSource + (kind === "link" ? " WHERE i.link_token=?" : " WHERE i.short_code=?") + " AND i.expires_at>?";
  const args = legacy ? [key] : [key, now];
  const detail = legacy ? "'通过邀请码加入家庭'" : "'通过 @'||u.username||' 的邀请加入家庭'";
  const [, , found] = await db.batch([
    db.prepare(`INSERT INTO family_members(family_id,user_id,role) SELECT i.family_id,?,? ${source} ON CONFLICT DO NOTHING`).bind(user.id,role,...args),
    db.prepare(`INSERT INTO family_events(family_id,actor_id,actor_role,detail) SELECT i.family_id,?,?,${detail} ${source} AND changes()>0`).bind(user.id,role,...args),
    db.prepare(`SELECT i.family_id AS familyId ${source}`).bind(...args)
  ]);
  return found.results[0];
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function invitePage(request, db, user, token, now) {
  const post = request.method === "POST";
  if (!post && !["GET","HEAD"].includes(request.method)) return error("接口不存在",405);
  const valid = /^[0-9a-f]{32}$/.test(token);
  const invite = valid && await db.prepare(`SELECT i.family_id AS familyId,f.name,u.username,m.role,
    EXISTS(SELECT 1 FROM family_members viewer WHERE viewer.family_id=i.family_id AND viewer.user_id=?) AS alreadyMember
    ${invitationSource} WHERE i.link_token=? AND i.expires_at>?`).bind(user?.id ?? null, token, now).first();
  const authPath = "/?invite=" + token;
  const redirect = location => new Response(null, { status:303,headers:{ Location:location,"Cache-Control":"no-store","Referrer-Policy":"no-referrer" } });
  let active = !!invite;
  if (post && active) {
    if (!user) return redirect(authPath);
    const joined = await acceptInvitation(db,user,user.preferred_role,"link",token,now);
    if (joined) return redirect("/?family=" + joined.familyId);
    active = false;
  }
  const title = active ? invite.role + "（@" + invite.username + "）邀请你加入家庭「" + invite.name + "」" : "这份家庭邀请已失效";
  const copy = active ? (invite.alreadyMember ? "你已经是这个家庭的一员了。" : user ? "将以 @" + user.username + " 的账号加入，家庭称呼是「" + user.preferred_role + "」。" : "登录或注册后，就能和家人一起记录上课日。") : "请家人重新分享邀请链接。";
  let action = '<a class="primary" href="/">返回手账</a>';
  if (active) {
    if (invite.alreadyMember) action = '<a class="primary" href="/?family=' + invite.familyId + '">打开家庭手账</a>';
    else if (!user) action = '<a class="primary" href="' + authPath + '">登录或注册后加入</a>';
    else action = '<form method="post"><button class="primary">确认加入家庭</button></form>';
  }
  const previewTitle = escapeHTML(title);
  const description = active ? "打开家庭邀请，和家人一起记录孩子的上课日、查看剩余课时。" : "请家人重新分享有效的邀请链接。";
  const image = escapeHTML(new URL("/garden.jpg",request.url).href);
  const canonical = escapeHTML(new URL("/invite/" + token, request.url).href);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${previewTitle} · 小小上课日历</title><meta name="description" content="${description}">
    <meta property="og:type" content="website"><meta property="og:site_name" content="小小上课日历"><meta property="og:locale" content="zh_CN">
    <meta property="og:title" content="${previewTitle}"><meta property="og:description" content="${description}"><meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${image}"><meta property="og:image:type" content="image/jpeg">
    <meta property="og:image:width" content="1080"><meta property="og:image:height" content="720"><meta property="og:image:alt" content="小兔子背着书包走在上学的花园小路上">
    <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${previewTitle}">
    <meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${image}">
    <link rel="icon" href="/rabbit-icon.png"><link rel="stylesheet" href="/style.css"></head>
    <body><header><div class="top wrap"><div class="brand"><img class="brand-rabbit" src="/rabbit-icon.png" alt="">小小上课日历</div></div></header>
    <main class="wrap"><article class="welcome-note invite-letter"><img src="/rabbit-icon.png" width="64" height="64" alt="">
    <h1>${escapeHTML(title)}</h1><p>${escapeHTML(copy)}</p>${action}</article></main></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, { status:active ? 200 : 404,headers:{
    "Content-Type":"text/html; charset=utf-8","Cache-Control":"private, no-store","Referrer-Policy":"same-origin",
    "X-Robots-Tag":"noindex, nofollow","X-Content-Type-Options":"nosniff",
    "Content-Security-Policy":"default-src 'self'; script-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  } });
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const invitation = path.startsWith("/invite/");
  if (!invitation && !path.startsWith("/api/")) return env.ASSETS.fetch(request);
  const origin = request.headers.get("Origin");
  if (method !== "GET" && origin && origin !== url.origin) return error("请求来源无效", 403);
  const now = Math.floor(Date.now() / 1000);
  if (path === "/api/register" && method === "POST") return register(request, env.DB, now);
  if (path === "/api/login" && method === "POST") return login(request, env, now);

  const token = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)__Host-class_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  const tokenHash = token && await digest(token);
  const db = env.DB;
  const user = tokenHash && await db.prepare(
    "SELECT u.id, u.username, u.display_name, u.guide_done, u.course_guide_done, u.preferred_role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?"
  ).bind(tokenHash, now).first();
  if (invitation) return invitePage(request, db, user, path.slice("/invite/".length), now);
  if (!user) return error("请先登录", 401);
  if (path === "/api/logout" && method === "POST") {
    await db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.CLASS_TIME_ZONE || "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  if (path === "/api/guide" && method === "POST") {
    const { stage } = await fields(request);
    const update = stage === "course" ? "UPDATE users SET guide_done=1,course_guide_done=1 WHERE id=?" : "UPDATE users SET guide_done=1 WHERE id=?";
    await db.prepare(update).bind(user.id).run();
    return json({ ok: true });
  }
  if (path === "/api/families" && method === "POST") {
    const body = await fields(request);
    const name = familyName(body.name), role = familyRole(body.role);
    if (!name || !role) return error("请填写家庭名称和你的称呼", 400);
    try {
      const [created] = await db.batch([
        db.prepare("INSERT INTO families(name,owner_id) VALUES (?,?) RETURNING id").bind(name, user.id),
        db.prepare("INSERT INTO family_codes(family_id) SELECT id FROM families WHERE owner_id=? AND name=?").bind(user.id, name),
        db.prepare("INSERT INTO family_members SELECT id,owner_id,? FROM families WHERE owner_id=? AND name=?").bind(role, user.id, name),
        db.prepare("INSERT INTO family_events(family_id,actor_id,actor_role,detail) SELECT id,owner_id,?,? FROM families WHERE owner_id=? AND name=?")
          .bind(role, "创建家庭「" + name + "」", user.id, name)
      ]);
      return json({ familyId: created.results[0].id }, 201);
    } catch (err) {
      if (String(err.message).includes("UNIQUE constraint failed")) return error("你已经创建了同名家庭", 409);
      throw err;
    }
  }
  if (path === "/api/families/join" && method === "POST") {
    const body = await fields(request);
    const code = typeof body.code === "string" ? body.code.replace(/[-\s]/g, "").toLowerCase() : "";
    const role = familyRole(body.role ?? user.preferred_role);
    const legacy = /^[a-f0-9]{16}$/.test(code);
    if (!role || (!legacy && !/^[2-9A-HJ-NP-Z]{6}$/i.test(code))) return error("请输入 6 位邀请码和你的称呼", 400);
    if (!legacy) {
      const client = await digest(request.headers.get("CF-Connecting-IP") || "local");
      if (!await allowAttempt(db,"invite-ip-" + client,now) || !await allowAttempt(db,"invite-user-" + user.id,now)) return error("尝试次数过多，请稍后再试",429);
    }
    const joined = await acceptInvitation(db,user,role,legacy ? "legacy" : "short",legacy ? code : code.toUpperCase(),now);
    return joined ? json(joined) : error("邀请码已失效，请向家人确认最新的邀请码", 404);
  }
  const families = (await db.prepare(`SELECT f.id,f.name,f.owner_id AS ownerId,m.role FROM family_members m
    JOIN families f ON f.id=m.family_id WHERE m.user_id=? ORDER BY (f.owner_id=?) DESC,f.id`).bind(user.id,user.id).all()).results;
  const chosen = request.headers.get("X-Family-Id");
  const family = chosen === null ? families[0] : families.find(f => String(f.id) === chosen);
  const context = { userId: user.id, displayName: user.display_name, username: user.username, guideDone: !!user.guide_done, courseGuideDone: !!user.course_guide_done, preferredRole: user.preferred_role, family: family || null, families, today };
  if (!family && !chosen && !families.length && path === "/api/calendar" && method === "GET" && !url.searchParams.has("cycle")) {
    return json({ ...context, periods: [], cycleId: null });
  }
  if (!family) return error("你已不在这个家庭中", 403);
  const scope = [family.id, user.id];
  const allowed = "EXISTS (SELECT 1 FROM family_members WHERE family_id=? AND user_id=?)";
  // Place this statement immediately after the mutation in the same D1 batch.
  const audit = detail => db.prepare(`INSERT INTO family_events(family_id,actor_id,actor_role,detail)
    SELECT ?,?,?,? WHERE changes()>0`).bind(family.id, user.id, family.role, detail);

  if (path === "/api/invitations" && method === "POST") return issueInvitation(db,family.id,user.id,now);
  if (path === "/api/members" && method === "GET") {
    const members = await db.prepare(`SELECT u.id,u.username,m.role FROM family_members m JOIN users u ON u.id=m.user_id
      WHERE m.family_id=? AND ${allowed} ORDER BY (m.user_id=?) DESC,m.user_id`).bind(family.id, ...scope, family.ownerId).all();
    const code = await db.prepare(`SELECT code FROM family_codes WHERE family_id=? AND ${allowed}`).bind(family.id,...scope).first("code");
    return json({ members: members.results, families, code });
  }
  if (path === "/api/history" && method === "GET") {
    const rows = (await db.prepare(`SELECT e.id,e.actor_role AS role,u.username,e.detail,e.happened_at AS time
      FROM family_events e JOIN users u ON u.id=e.actor_id WHERE e.family_id=? AND ${allowed}
      ORDER BY e.id DESC LIMIT 100`).bind(family.id, ...scope).all()).results;
    return json({ entries: rows });
  }
  if (path === "/api/members" && ["POST","PATCH","DELETE"].includes(method)) {
    const body = await fields(request);
    const role = familyRole(body.role);
    if (method !== "DELETE" && !role) return error("称呼限 1–20 个字符", 400);
    if (typeof body.username !== "string" || /[@＠]/.test(body.username)) return error("只需填写账号本身", 400);
    const target = await db.prepare("SELECT id,username FROM users WHERE username=?").bind(usernameKey(body.username)).first();
    if (!target) return error("没有找到这个账号，请家人先注册", 404);
    const member = await db.prepare("SELECT role FROM family_members WHERE family_id=? AND user_id=?").bind(family.id,target.id).first();
    let change, detail;
    if (method === "POST") {
      change = db.prepare(`INSERT INTO family_members SELECT ?,?,? WHERE ${allowed} ON CONFLICT DO NOTHING`).bind(family.id,target.id,role,...scope);
      detail = "添加成员 " + role + "（" + target.username + "）";
    } else {
      if (!member) return error("这个账号不在当前家庭", 404);
      if (method === "DELETE") {
        if (target.id === family.ownerId || (user.id !== family.ownerId && user.id !== target.id)) return error("仅创建人可移除其他成员，创建人需保留在家庭中", 403);
        change = db.prepare(`DELETE FROM family_members WHERE family_id=? AND user_id=? AND ${allowed}`).bind(family.id,target.id,...scope);
        detail = "移除成员 " + member.role + "（" + target.username + "）";
      } else {
        if (role === member.role) return json({ ok: true });
        change = db.prepare(`UPDATE family_members SET role=? WHERE family_id=? AND user_id=? AND role=? AND ${allowed}`).bind(role,family.id,target.id,member.role,...scope);
        detail = "将 " + target.username + " 的称呼从「" + member.role + "」改为「" + role + "」";
      }
    }
    const statements = [change, audit(detail)];
    if (method === "DELETE") {
      statements.push(
        db.prepare("UPDATE family_codes SET code=lower(hex(randomblob(8))) WHERE family_id=? AND changes()>0").bind(family.id),
        db.prepare("DELETE FROM family_invitations WHERE family_id=? AND changes()>0").bind(family.id)
      );
    }
    const [write] = await db.batch(statements);
    if (!write.meta.changes) return error(method === "POST" ? "该账号已在家庭中，或成员权限已更新" : "家庭成员已变更，请重新打开", 409);
    return json({ ok: true }, method === "POST" ? 201 : 200);
  }
  const catalog = db.prepare(
    `SELECT p.id, c.id AS courseId, c.name, p.first, p.last, p.total,
       COUNT(a.class_date) AS done, COUNT(CASE WHEN substr(a.class_date,1,7)=? THEN 1 END) AS thisMonth
     FROM courses c JOIN cycles p ON p.course_id=c.id
     LEFT JOIN cycle_checkins a ON a.cycle_id=p.id WHERE c.family_id=? AND ${allowed}
     GROUP BY p.id ORDER BY c.id, p.first, p.id`
  ).bind(today.slice(0, 7), family.id, ...scope);

  const courseRoute = path.match(/^\/api\/courses\/(\d+)(\/cycles)?$/);
  if ((path === "/api/courses" && method === "POST") || courseRoute) {
    const courseId = courseRoute ? Number(courseRoute[1]) : null;
    const course = courseId === null ? null : await db.prepare("SELECT id,name FROM courses WHERE id=? AND family_id=?").bind(courseId, family.id).first();
    if (courseId !== null && !course) return error("找不到这门课程", 404);
    if (courseRoute && !courseRoute[2] && method === "DELETE") {
      const [removed] = await db.batch([
        db.prepare(`DELETE FROM courses WHERE id=? AND family_id=? AND ${allowed}`).bind(courseId,family.id,...scope),
        audit("删除课程「" + course.name + "」")
      ]);
      return removed.meta.changes ? json({ ok: true }) : error("找不到这门课程",404);
    }
    const body = await fields(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if ((!courseRoute || method === "PATCH") && (!name || name.length > 60)) return error("请输入 1–60 个字符的课程名称", 400);
    try {
      if (courseRoute && !courseRoute[2] && method === "PATCH") {
        const [updated] = await db.batch([db.prepare(`UPDATE courses SET name=? WHERE id=? AND family_id=? AND ${allowed}`).bind(name,courseId,family.id,...scope),
          audit("将课程「" + course.name + "」改名为「" + name + "」")]);
        if (!updated.meta.changes) return error("找不到这门课程", 404);
        return json({ ok: true });
      }
      if (method !== "POST" || (courseRoute && !courseRoute[2])) return error("接口不存在", 404);
      const { first, last, total } = body;
      if (!validDate(first) || !validDate(last) || first > last || !Number.isSafeInteger(total) || total < 1) {
        return error("请填写有效的起止日期和正整数课时", 400);
      }
      if (courseId !== null) {
        const [cycle] = await db.batch([db.prepare(`INSERT INTO cycles(course_id,first,last,total) SELECT id,?,?,? FROM courses WHERE id=? AND family_id=? AND ${allowed} RETURNING id`)
          .bind(first,last,total,courseId,family.id,...scope),audit("给「" + course.name + "」续课 " + total + " 节 · " + first + " 至 " + last)]);
        if (!cycle.results.length) return error("找不到这门课程",404);
        return json({ cycleId: cycle.results[0].id }, 201);
      }
      const [, cycle, , milestone] = await db.batch([
        db.prepare(`INSERT INTO courses(family_id,name) SELECT ?,? WHERE ${allowed}`).bind(family.id,name,...scope),
        db.prepare(`INSERT INTO cycles(course_id,first,last,total)
          SELECT id,?,?,? FROM courses WHERE family_id=? AND name=? AND ${allowed} RETURNING id`).bind(first,last,total,family.id,name,...scope),
        audit("添加课程「" + name + "」 · " + total + " 节"),
        db.prepare("UPDATE users SET course_guide_done=1 WHERE id=? AND course_guide_done=0 AND changes()>0").bind(user.id)
      ]);
      if (!cycle.results.length) return error("家庭权限已更新",403);
      return json({ cycleId: cycle.results[0].id, startCourseGuide: milestone.meta.changes > 0 }, 201);
    } catch (err) {
      if (String(err.message).includes("UNIQUE constraint failed")) return error("课程名称或周期日期已存在", 409);
      throw err;
    }
  }

  const requested = url.searchParams.get("cycle");
  // Unscoped clients keep using the original period, even after renewal.
  const lookup = `SELECT p.id, c.name, p.course_id AS courseId, p.first, p.last, p.total
    FROM cycles p JOIN courses c ON c.id=p.course_id WHERE c.family_id=?`;
  const period = requested === null
    ? await db.prepare(lookup + " ORDER BY p.id LIMIT 1").bind(family.id).first()
    : await db.prepare(lookup + " AND p.id=?").bind(family.id, requested).first();
  if (!period) {
    if (requested === null && path === "/api/calendar" && method === "GET") return json({ ...context, periods: [], cycleId: null });
    return error("找不到这个课程周期", 404);
  }
  const readDates = db.prepare(`SELECT a.class_date,u.username FROM cycle_checkins a JOIN users u ON u.id=a.marked_by WHERE cycle_id=? AND ${allowed} ORDER BY class_date`).bind(period.id,...scope);
  const calendar = (snapshot, courses) => ({
    ...context, periods: courses.results, cycleId: period.id, first: period.first, last: period.last, total: period.total,
    markedBy: Object.fromEntries(snapshot.results.map(row => [row.class_date,row.username])), dates: snapshot.results.map(row => row.class_date)
  });
  if (path === "/api/calendar" && method === "GET") {
    const [snapshot, courses] = await db.batch([readDates, catalog]);
    if (!courses.results.some(p => p.id === period.id)) return error("找不到这个课程周期", 404);
    return json(calendar(snapshot, courses));
  }

  const date = path.match(/^\/api\/checkins\/(\d{4}-\d{2}-\d{2})$/)?.[1];
  if (!date || !["PUT", "DELETE"].includes(method)) return error("接口不存在", 404);
  if (!validDate(date) || date < period.first || date > period.last || date > today) return error("请选择本周期内今天或更早的日期", 400);
  const change = method === "DELETE"
    ? db.prepare(`DELETE FROM cycle_checkins WHERE cycle_id=? AND class_date=? AND ${allowed}`).bind(period.id,date,...scope)
    : db.prepare(`INSERT INTO cycle_checkins (course_id,cycle_id,class_date,marked_by) SELECT course_id,id,?,? FROM cycles WHERE id=? AND ${allowed}
        AND (SELECT COUNT(*) FROM cycle_checkins WHERE cycle_id=?) < ? ON CONFLICT DO NOTHING`)
      .bind(date,user.id,period.id,...scope,period.id,period.total);
  const [, , snapshot, updatedCatalog] = await db.batch([change,
    audit((method === "PUT" ? "打卡" : "撤销打卡") + " · " + period.name + " · " + date), readDates, catalog]);
  if (!updatedCatalog.results.some(p => p.id === period.id)) return error("找不到这个课程周期", 404);
  const result = calendar(snapshot, updatedCatalog);
  if (method === "PUT" && !result.dates.includes(date)) {
    return error(result.dates.length >= period.total ? "本周期课时已用完" : "这门课当天已记在其他周期", 409);
  }
  return json(result);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error("请求处理失败", err.name, new URL(request.url).pathname.split("/").slice(0,2).join("/"));
      return error("暂时无法保存或读取手账，请稍后重试", 500);
    }
  }
};
