// Tests des fonctions serveur du site : node --test tests/site_api.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, {
  SESSION_SECRET: "test-secret", ADMIN_GITHUB_LOGINS: "paulvln1", SITE_ORIGIN: "https://signal.test",
  GH_APP_ID: "1", GH_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
  GITHUB_OAUTH_CLIENT_ID: "cid", GITHUB_OAUTH_CLIENT_SECRET: "csecret",
});
const lib = require("../site/api/_lib");
const watchlist = require("../site/api/watchlist");
const callback = require("../site/api/callback");

const FILE = "# commentaire\nalice\n@Bob\n\ncarol\n";

test("editAccounts : ajout, doublon, retrait, commentaires préservés", () => {
  assert.strictEqual(lib.editAccounts(FILE, "add", "dave"), FILE + "dave\n");
  assert.strictEqual(lib.editAccounts("alice", "add", "dave"), "alice\ndave\n");
  assert.strictEqual(lib.editAccounts(FILE, "add", "ALICE"), null);
  assert.strictEqual(lib.editAccounts(FILE, "remove", "bob"), "# commentaire\nalice\n\ncarol\n");
  assert.strictEqual(lib.editAccounts(FILE, "remove", "commentaire"), null);
  assert.strictEqual(lib.editAccounts(FILE, "remove", "zed"), null);
  assert.deepStrictEqual(lib.listHandles(FILE), ["alice", "Bob", "carol"]);
});

test("session signée : valide, falsifiée, expirée, admin retiré", () => {
  const tok = lib.signSession("paulvln1");
  assert.strictEqual(lib.readSession(tok), "paulvln1");
  const [body] = tok.split(".");
  const forged = Buffer.from(JSON.stringify({ l: "paulvln1", e: Date.now() + 1e9 })).toString("base64url");
  assert.strictEqual(lib.readSession(`${forged}.${tok.split(".")[1]}`), null);
  assert.strictEqual(lib.readSession(`${body}.x`), null);
  assert.strictEqual(lib.readSession(tok, Date.now() + 8 * 864e5), null);
  assert.strictEqual(lib.currentAdmin({ headers: { cookie: `signal_session=${tok}` } }), "paulvln1");
  process.env.ADMIN_GITHUB_LOGINS = "someone";
  assert.strictEqual(lib.currentAdmin({ headers: { cookie: `signal_session=${tok}` } }), null);
  process.env.ADMIN_GITHUB_LOGINS = "paulvln1";
});

// ---- faux GitHub ----
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.writeHead = (c, h) => { r.statusCode = c; Object.assign(r.headers, Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))); return r; };
  r.end = () => r;
  return r;
}
function fakeGitHub({ conflicts = 0 } = {}) {
  const state = { text: FILE, sha: "s0", puts: [] };
  global.fetch = async (url, opt = {}) => {
    const u = new URL(url), m = opt.method || "GET";
    const reply = (status, data) => ({ status, json: async () => data });
    if (u.pathname.endsWith("/installation")) return reply(200, { id: 7 });
    if (u.pathname.endsWith("/access_tokens")) return reply(201, { token: "inst" });
    if (u.pathname.endsWith("/contents/accounts.txt") && m === "GET")
      return reply(200, { sha: state.sha, content: Buffer.from(state.text).toString("base64") });
    if (u.pathname.endsWith("/contents/accounts.txt") && m === "PUT") {
      const b = JSON.parse(opt.body);
      state.puts.push(b);
      if (conflicts-- > 0) { state.sha += "x"; return reply(409, {}); }
      if (b.sha !== state.sha) return reply(409, {});
      state.text = Buffer.from(b.content, "base64").toString(); state.sha += "1";
      return reply(200, {});
    }
    throw new Error(`unexpected ${m} ${url}`);
  };
  return state;
}
const authed = (extra = {}) => ({
  headers: { cookie: `signal_session=${lib.signSession("paulvln1")}`, origin: "https://signal.test", ...extra },
});

test("watchlist : refuse sans session, mauvaise origine, handle invalide", async () => {
  fakeGitHub();
  let res = fakeRes();
  await watchlist({ method: "POST", headers: {}, body: { action: "add", handle: "dave" } }, res);
  assert.strictEqual(res.statusCode, 401);
  res = fakeRes();
  await watchlist({ method: "POST", ...authed({ origin: "https://evil.test" }), body: { action: "add", handle: "dave" } }, res);
  assert.strictEqual(res.statusCode, 403);
  for (const handle of ["dave\nmallory", "../x", "a".repeat(16), ""]) {
    res = fakeRes();
    await watchlist({ method: "POST", ...authed(), body: { action: "add", handle } }, res);
    assert.strictEqual(res.statusCode, 400, handle);
  }
});

test("watchlist : ajout puis retrait, commit sur main, réessai après conflit", async () => {
  const gh = fakeGitHub({ conflicts: 1 });
  let res = fakeRes();
  await watchlist({ method: "POST", ...authed(), body: { action: "add", handle: "@Dave" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(gh.text, FILE + "Dave\n");
  assert.strictEqual(gh.puts.length, 2);
  assert.strictEqual(gh.puts[1].branch, "main");
  assert.match(gh.puts[1].message, /@Dave .*@paulvln1/);

  res = fakeRes();
  await watchlist({ method: "POST", ...authed(), body: JSON.stringify({ action: "remove", handle: "bob" }) }, res);
  assert.deepStrictEqual(res.body.accounts, ["alice", "carol", "Dave"]);

  res = fakeRes();
  await watchlist({ method: "GET", headers: authed().headers }, res);
  assert.deepStrictEqual(res.body.accounts, ["alice", "carol", "Dave"]);
});

test("callback : state invalide refusé, non-admin refusé, admin connecté", async () => {
  let res = fakeRes();
  await callback({ query: { code: "c", state: "a" }, headers: { cookie: "oauth_state=b" } }, res);
  assert.strictEqual(res.headers.location, "https://signal.test/?login=failed");

  for (const [login, expectSession] of [["intruder", false], ["paulvln1", true]]) {
    const calls = [];
    global.fetch = async (url, opt = {}) => {
      calls.push(`${opt.method || "GET"} ${url}`);
      if (url.includes("access_token")) return { json: async () => ({ access_token: "gho_x" }) };
      if (url.endsWith("/user")) return { json: async () => ({ login }) };
      return { status: 204, json: async () => null };
    };
    res = fakeRes();
    await callback({ query: { code: "c", state: "s" }, headers: { cookie: "oauth_state=s" } }, res);
    const cookies = res.headers["set-cookie"].join("\n");
    assert.strictEqual(/signal_session=[^;]+\./.test(cookies), expectSession, login);
    assert.ok(calls.some((c) => c.startsWith("DELETE") && c.includes("/applications/cid/token")), "jeton révoqué");
    if (expectSession) assert.match(cookies, /HttpOnly; Secure; SameSite=Strict/);
    else assert.strictEqual(res.headers.location, "https://signal.test/?login=denied");
  }
});

test("le JWT de la GitHub App est signé RS256 et vérifiable", async () => {
  let jwt;
  global.fetch = async (url, opt) => {
    jwt = opt.headers.Authorization.split(" ")[1];
    return { status: 500, json: async () => ({}) };
  };
  await assert.rejects(lib.installationToken());
  const [h, b, sig] = jwt.split(".");
  const pub = crypto.createPublicKey(privateKey);
  assert.ok(crypto.createVerify("RSA-SHA256").update(`${h}.${b}`).verify(pub, sig, "base64url"));
  assert.strictEqual(JSON.parse(Buffer.from(b, "base64url")).iss, "1");
});
