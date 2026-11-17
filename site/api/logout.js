// POST /api/logout : efface le cookie de session.
"use strict";
const { cookie, sameOrigin, SESSION_COOKIE } = require("./_lib");

module.exports = (req, res) => {
  if (req.method !== "POST" || !sameOrigin(req)) return res.status(403).json({ error: "forbidden" });
  res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", { maxAge: 0 }));
  res.status(200).json({ ok: true });
};
