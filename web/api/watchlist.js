// /api/watchlist (admin only)
//   GET  -> { accounts: [...] }: the current content of watchlist.txt on main
//   POST { action: "add" | "remove", handle } -> commits watchlist.txt through the GitHub App
"use strict";
const {
  OWNER, REPO, FILE, BRANCH, HANDLE_RE, currentAdmin, sameOrigin, gh, installationToken,
  readWatchlistFile, listHandles, editWatchlist,
} = require("./_lib");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const admin = currentAdmin(req);
  if (!admin) return res.status(401).json({ error: "not signed in" });

  try {
    if (req.method === "GET") {
      const token = await installationToken();
      const { text } = await readWatchlistFile(token);
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
    // If watchlist.txt changed between the read and the write, GitHub refuses (stale sha): read again and retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sha, text } = await readWatchlistFile(token);
      const next = editWatchlist(text, action, handle);
      if (next === null) return res.status(200).json({ ok: true, changed: false, accounts: listHandles(text) });
      const verb = action === "add" ? "Add" : "Remove";
      const put = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}`, {
        token, method: "PUT",
        body: {
          message: `Watchlist: ${verb.toLowerCase()} @${handle} (from the site, by @${admin})`,
          content: Buffer.from(next, "utf8").toString("base64"),
          sha, branch: BRANCH,
        },
      });
      if (put.status === 200 || put.status === 201) {
        return res.status(200).json({ ok: true, changed: true, accounts: listHandles(next) });
      }
      if (put.status !== 409 && put.status !== 422) throw new Error(`write ${put.status}`);
    }
    return res.status(409).json({ error: "watchlist.txt keeps changing, try again" });
  } catch (e) {
    console.error("watchlist:", e.message);
    return res.status(502).json({ error: "GitHub is not reachable right now" });
  }
};
