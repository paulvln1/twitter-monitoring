// /api/watchlist (admin only)
//   GET  -> { accounts: [...], hidden: { handle: "YYYY-MM-DD" } }: watchlist.txt and hidden.txt on main
//   POST { action: "add" | "remove", handle } -> commits watchlist.txt through the GitHub App
//   POST { action: "hide" | "unhide", handle } -> commits hidden.txt (discovered accounts hidden from the map)
"use strict";
const {
  OWNER, REPO, FILE, HIDDEN_FILE, BRANCH, HANDLE_RE, currentAdmin, sameOrigin, gh, installationToken,
  readRepoFile, listHandles, editWatchlist, listHidden, editHidden,
} = require("./_lib");

const ACTIONS = {
  add: { file: FILE, verb: "Watchlist: add" },
  remove: { file: FILE, verb: "Watchlist: remove" },
  hide: { file: HIDDEN_FILE, verb: "Map: hide" },
  unhide: { file: HIDDEN_FILE, verb: "Map: show again" },
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const admin = currentAdmin(req);
  if (!admin) return res.status(401).json({ error: "not signed in" });

  try {
    if (req.method === "GET") {
      const token = await installationToken();
      const [w, h] = await Promise.all([readRepoFile(token, FILE), readRepoFile(token, HIDDEN_FILE)]);
      return res.status(200).json({ accounts: listHandles(w.text), hidden: listHidden(h.text) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
    if (!sameOrigin(req)) return res.status(403).json({ error: "forbidden" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    const action = body && body.action;
    const handle = body && typeof body.handle === "string" ? body.handle.trim().replace(/^@/, "") : "";
    if (!Object.hasOwn(ACTIONS, action) || !HANDLE_RE.test(handle)) {
      return res.status(400).json({ error: "invalid request" });
    }
    const { file, verb } = ACTIONS[action];
    const day = new Date().toISOString().slice(0, 10); // UTC, like the dates of the map data
    const edit = (text) => (file === FILE ? editWatchlist(text, action, handle) : editHidden(text, action, handle, day));

    const token = await installationToken();
    // Reply with both files, so the site always has the full picture after a write.
    const reply = async (changedText) => {
      const other = await readRepoFile(token, file === FILE ? HIDDEN_FILE : FILE);
      const [w, h] = file === FILE ? [changedText, other.text] : [other.text, changedText];
      return { accounts: listHandles(w), hidden: listHidden(h) };
    };
    // If the file changed between the read and the write, GitHub refuses (stale sha): read again and retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sha, text } = await readRepoFile(token, file);
      const next = edit(text);
      if (next === null) return res.status(200).json({ ok: true, changed: false, ...(await reply(text)) });
      const put = await gh(`/repos/${OWNER}/${REPO}/contents/${file}`, {
        token, method: "PUT",
        body: {
          message: `${verb} @${handle} (from the site, by @${admin})`,
          content: Buffer.from(next, "utf8").toString("base64"),
          ...(sha ? { sha } : {}), branch: BRANCH,
        },
      });
      if (put.status === 200 || put.status === 201) {
        return res.status(200).json({ ok: true, changed: true, ...(await reply(next)) });
      }
      if (put.status !== 409 && put.status !== 422) throw new Error(`write ${put.status}`);
    }
    return res.status(409).json({ error: `${file} keeps changing, try again` });
  } catch (e) {
    console.error("watchlist:", e.message);
    return res.status(502).json({ error: "GitHub is not reachable right now" });
  }
};
