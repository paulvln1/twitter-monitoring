// GET /api/login: redirect to GitHub to check who you are (no scope: no access to any repo).
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
  // SameSite=Lax: this cookie must come back on the redirect from github.com
  res.setHeader("Set-Cookie", cookie("oauth_state", state, { maxAge: 600, sameSite: "Lax", path: "/api" }));
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(302, { Location: url.toString() }).end();
};
