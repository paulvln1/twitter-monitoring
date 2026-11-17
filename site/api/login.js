// GET /api/login : redirige vers GitHub pour vérifier l'identité (aucun scope : pas d'accès aux repos).
"use strict";
const crypto = require("crypto");
const { env, siteOrigin, cookie } = require("./_lib");

module.exports = (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env("GITHUB_OAUTH_CLIENT_ID"));
  url.searchParams.set("redirect_uri", `${siteOrigin()}/api/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  // SameSite=Lax : ce cookie doit revenir lors du retour depuis github.com
  res.setHeader("Set-Cookie", cookie("oauth_state", state, { maxAge: 600, sameSite: "Lax", path: "/api" }));
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(302, { Location: url.toString() }).end();
};
