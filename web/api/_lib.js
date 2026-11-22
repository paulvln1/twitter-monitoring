// Shared helpers for the Vercel serverless functions (files starting with _ are not routes).
// No dependencies: Node built-in modules only.
"use strict";
const crypto = require("crypto");

const OWNER = "paulvln1";
const REPO = "twitter-monitoring";
const FILE = "watchlist.txt";     // the only two files the server is allowed to change
const HIDDEN_FILE = "hidden.txt";  // discovered accounts hidden from the map: "handle YYYY-MM-DD" per line
const BRANCH = "main";
const SESSION_COOKIE = "signal_session";
const SESSION_DAYS = 7;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const siteOrigin = () => env("SITE_ORIGIN").replace(/\/+$/, "");

// ---------- cookies & signed session ----------
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hmac(data) {
  return crypto.createHmac("sha256", env("SESSION_SECRET")).update(data).digest("base64url");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function signSession(login, now = Date.now()) {
  const body = b64url(JSON.stringify({ l: login, e: now + SESSION_DAYS * 864e5 }));
  return `${body}.${hmac(body)}`;
}

function readSession(token, now = Date.now()) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  try {
    const { l, e } = JSON.parse(Buffer.from(body, "base64url").toString());
    return typeof l === "string" && e > now ? l : null;
  } catch { return null; }
}

function admins() {
  return (process.env.ADMIN_GITHUB_LOGINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const isAdmin = (login) => !!login && admins().includes(login.toLowerCase());

// Login of the signed-in admin, or null. The admin list is checked again on every request.
function currentAdmin(req) {
  const login = readSession(parseCookies(req)[SESSION_COOKIE]);
  return isAdmin(login) ? login : null;
}

function cookie(name, value, { maxAge, sameSite = "Strict", path = "/" } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

// CSRF guard: writes must come from the site itself.
function sameOrigin(req) {
  return req.headers.origin === siteOrigin();
}

// ---------- GitHub App (writes watchlist.txt) ----------
async function gh(path, { token, auth = "token", method = "GET", body } = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `${auth === "jwt" ? "Bearer" : "token"} ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "signal-site",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  return { status: r.status, data };
}

function appJwt(now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env("GH_APP_ID") }));
  const key = env("GH_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${body}`).sign(key, "base64url");
  return `${head}.${body}.${sig}`;
}

// Installation token, limited to this repo and to Contents: write.
async function installationToken() {
  const jwt = appJwt();
  const inst = await gh(`/repos/${OWNER}/${REPO}/installation`, { token: jwt, auth: "jwt" });
  if (inst.status !== 200) throw new Error(`installation ${inst.status}`);
  const tok = await gh(`/app/installations/${inst.data.id}/access_tokens`, {
    token: jwt, auth: "jwt", method: "POST",
    body: { repositories: [REPO], permissions: { contents: "write" } },
  });
  if (tok.status !== 201) throw new Error(`access_token ${tok.status}`);
  return tok.data.token;
}

// file is FILE or HIDDEN_FILE, never anything else. hidden.txt may not exist yet: empty, no sha (the PUT creates it).
async function readRepoFile(token, file) {
  if (file !== FILE && file !== HIDDEN_FILE) throw new Error("file not allowed");
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${file}?ref=${BRANCH}`, { token });
  if (r.status === 404 && file === HIDDEN_FILE) return { sha: undefined, text: "" };
  if (r.status !== 200) throw new Error(`read ${r.status}`);
  return { sha: r.data.sha, text: Buffer.from(r.data.content, "base64").toString("utf8") };
}
const readWatchlistFile = (token) => readRepoFile(token, FILE);

// ---------- editing watchlist.txt (pure logic, tested) ----------
const norm = (line) => line.trim().replace(/^@/, "").toLowerCase();
const isEntry = (line) => line.trim() !== "" && !line.trim().startsWith("#");

function listHandles(text) {
  return text.split("\n").filter(isEntry).map((l) => l.trim().replace(/^@/, ""));
}

// Returns the new text, or null if nothing changes.
function editWatchlist(text, action, handle) {
  const h = handle.toLowerCase();
  const present = text.split("\n").some((l) => isEntry(l) && norm(l) === h);
  if (action === "add") {
    if (present) return null;
    return (text === "" || text.endsWith("\n") ? text : text + "\n") + handle + "\n";
  }
  if (action === "remove") {
    if (!present) return null;
    return text.split("\n").filter((l) => !(isEntry(l) && norm(l) === h)).join("\n");
  }
  throw new Error("bad action");
}

// ---------- editing hidden.txt (pure logic, tested) ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const hiddenEntry = (line) => {
  const [h, d] = line.split("#")[0].trim().split(/\s+/);
  return h && HANDLE_RE.test(h.replace(/^@/, "")) && DATE_RE.test(d || "") ? { h: h.replace(/^@/, "").toLowerCase(), d } : null;
};

// { handle: "YYYY-MM-DD" }
function listHidden(text) {
  const out = {};
  for (const line of text.split("\n")) { const e = hiddenEntry(line); if (e) out[e.h] = e.d; }
  return out;
}

// "hide" writes (or moves) "handle day"; "unhide" removes it. Returns the new text, or null if nothing changes.
function editHidden(text, action, handle, day) {
  const h = handle.toLowerCase();
  const lines = text.split("\n");
  const mine = (l) => { const e = hiddenEntry(l); return !!e && e.h === h; };
  if (action === "hide") {
    if (!DATE_RE.test(day)) throw new Error("bad day");
    if (lines.some((l) => mine(l) && hiddenEntry(l).d === day)) return null;
    const rest = lines.filter((l) => !mine(l)).join("\n");
    return (rest === "" || rest.endsWith("\n") ? rest : rest + "\n") + `${h} ${day}\n`;
  }
  if (action === "unhide") {
    if (!lines.some(mine)) return null;
    return lines.filter((l) => !mine(l)).join("\n");
  }
  throw new Error("bad action");
}

module.exports = {
  OWNER, REPO, FILE, HIDDEN_FILE, BRANCH, SESSION_COOKIE, SESSION_DAYS, HANDLE_RE,
  env, siteOrigin, parseCookies, safeEqual, signSession, readSession, isAdmin, currentAdmin,
  cookie, sameOrigin, gh, installationToken, readRepoFile, readWatchlistFile, listHandles, editWatchlist, listHidden, editHidden,
};
