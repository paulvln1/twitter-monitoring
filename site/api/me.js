// GET /api/me : qui est connecté ({ login } ou { login: null }).
"use strict";
const { currentAdmin } = require("./_lib");

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ login: currentAdmin(req) });
};
