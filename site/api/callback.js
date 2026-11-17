// GET /api/callback : retour de GitHub. On lit le login, on jette le jeton OAuth, on pose un cookie de session signé.
"use strict";
const {
  env, siteOrigin, parseCookies, safeEqual, signSession, isAdmin, cookie, SESSION_COOKIE, SESSION_DAYS,
} = require("./_lib");

const back = (res, cookies, query = "") => {
  res.setHeader("Set-Cookie", cookies);
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(302, { Location: `${siteOrigin()}/${query}` }).end();
};

module.exports = async (req, res) => {
  const clearState = cookie("oauth_state", "", { maxAge: 0, sameSite: "Lax", path: "/api" });
  const { code, state } = req.query || {};
  const saved = parseCookies(req).oauth_state;
  if (!code || !state || !saved || !safeEqual(state, saved)) return back(res, [clearState], "?login=failed");

  const clientId = env("GITHUB_OAUTH_CLIENT_ID");
  const secret = env("GITHUB_OAUTH_CLIENT_SECRET");
  let login = null;
  try {
    const t = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "signal-site" },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, code, redirect_uri: `${siteOrigin()}/api/callback` }),
    }).then((r) => r.json());
    if (!t.access_token) return back(res, [clearState], "?login=failed");

    const u = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${t.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "signal-site" },
    }).then((r) => r.json());
    login = typeof u.login === "string" ? u.login : null;

    // Le jeton ne sert plus à rien : on le révoque tout de suite.
    await fetch(`https://api.github.com/applications/${clientId}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "signal-site",
      },
      body: JSON.stringify({ access_token: t.access_token }),
    }).catch(() => {});
  } catch {
    return back(res, [clearState], "?login=failed");
  }

  if (!isAdmin(login)) return back(res, [clearState], "?login=denied");
  back(res, [clearState, cookie(SESSION_COOKIE, signSession(login), { maxAge: SESSION_DAYS * 86400 })]);
};
