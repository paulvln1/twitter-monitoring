// /api/watchlist (admin uniquement)
//   GET  -> { accounts: [...] } : le contenu actuel de accounts.txt sur main
//   POST { action: "add" | "remove", handle } -> commit sur accounts.txt via la GitHub App
"use strict";
const {
  OWNER, REPO, FILE, BRANCH, HANDLE_RE, currentAdmin, sameOrigin, gh, installationToken,
  readAccountsFile, listHandles, editAccounts,
} = require("./_lib");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const admin = currentAdmin(req);
  if (!admin) return res.status(401).json({ error: "not signed in" });

  try {
    if (req.method === "GET") {
      const token = await installationToken();
      const { text } = await readAccountsFile(token);
      return res.status(200).json({ accounts: listHandles(text) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
    if (!sameOrigin(req)) return res.status(403).json({ error: "forbidden" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    const action = body && body.action;
    const handle = body && typeof body.handle === "string" ? body.handle.trim().replace(/^@/, "") : "";
    if (!["add", "remove"].includes(action) || !HANDLE_RE.test(handle)) {
      return res.status(400).json({ error: "invalid request" });
    }

    const token = await installationToken();
    // Si accounts.txt a changé entre la lecture et l'écriture, GitHub refuse (sha périmé) : on relit et on réessaie.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sha, text } = await readAccountsFile(token);
      const next = editAccounts(text, action, handle);
      if (next === null) return res.status(200).json({ ok: true, changed: false, accounts: listHandles(text) });
      const verb = action === "add" ? "Ajoute" : "Retire";
      const put = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}`, {
        token, method: "PUT",
        body: {
          message: `Watchlist : ${verb.toLowerCase()} @${handle} (depuis le site, par @${admin})`,
          content: Buffer.from(next, "utf8").toString("base64"),
          sha, branch: BRANCH,
        },
      });
      if (put.status === 200 || put.status === 201) {
        return res.status(200).json({ ok: true, changed: true, accounts: listHandles(next) });
      }
      if (put.status !== 409 && put.status !== 422) throw new Error(`write ${put.status}`);
    }
    return res.status(409).json({ error: "accounts.txt keeps changing, try again" });
  } catch (e) {
    console.error("watchlist:", e.message);
    return res.status(502).json({ error: "GitHub is not reachable right now" });
  }
};
