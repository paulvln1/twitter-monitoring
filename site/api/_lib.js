// Outils partagés des fonctions serveur Vercel (les fichiers qui commencent par _ ne sont pas des routes).
// Aucune dépendance : uniquement les modules natifs de Node.
"use strict";
const crypto = require("crypto");

const OWNER = "paulvln1";
const REPO = "twitter-monitoring";
const FILE = "accounts.txt"; // le seul fichier que le serveur a le droit de modifier
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

// ---------- cookies & session signée ----------
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

// Login de l'admin connecté, ou null. La liste des admins est revérifiée à chaque requête.
function currentAdmin(req) {
  const login = readSession(parseCookies(req)[SESSION_COOKIE]);
  return isAdmin(login) ? login : null;
}

function cookie(name, value, { maxAge, sameSite = "Strict", path = "/" } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

// Anti-CSRF : les écritures doivent venir du site lui-même.
function sameOrigin(req) {
  return req.headers.origin === siteOrigin();
}

// ---------- GitHub App (écriture de accounts.txt) ----------
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

// Jeton d'installation, limité à ce repo et à Contents: write.
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

async function readAccountsFile(token) {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${BRANCH}`, { token });
  if (r.status !== 200) throw new Error(`read ${r.status}`);
  return { sha: r.data.sha, text: Buffer.from(r.data.content, "base64").toString("utf8") };
}

// ---------- édition de accounts.txt (logique pure, testée) ----------
const norm = (line) => line.trim().replace(/^@/, "").toLowerCase();
const isEntry = (line) => line.trim() !== "" && !line.trim().startsWith("#");

function listHandles(text) {
  return text.split("\n").filter(isEntry).map((l) => l.trim().replace(/^@/, ""));
}

// Renvoie le nouveau texte, ou null si rien ne change.
function editAccounts(text, action, handle) {
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

module.exports = {
  OWNER, REPO, FILE, BRANCH, SESSION_COOKIE, SESSION_DAYS, HANDLE_RE,
  env, siteOrigin, parseCookies, safeEqual, signSession, readSession, isAdmin, currentAdmin,
  cookie, sameOrigin, gh, installationToken, readAccountsFile, listHandles, editAccounts,
};
