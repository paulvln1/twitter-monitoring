// GET /api/me: who is signed in ({ login } or { login: null }).
"use strict";
const { currentAdmin } = require("./_lib");

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ login: currentAdmin(req) });
};
