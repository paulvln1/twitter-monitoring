# Spec: the account map

How the map works: what is collected, the rules that decide who shows up, and how the site and the watchlist editor fit together.

## Goal

A public site that maps the accounts of the watchlist (`watchlist.txt`, the "sources") and the accounts they keep relaying (the "discovered" accounts). It surfaces new accounts worth following, and lets the admin move them into the watchlist straight from the site.

## 1. Collected data (daily run)

The daily run (`pipeline/fetch_tweets.py`) already fetches the tweets written by every watchlist account. From them, the pipeline extracts **interactions**:

| Type   | Source in the Mindcase data                                   |
|--------|---------------------------------------------------------------|
| RT     | `retweetedTweetUrl` → handle in `x.com/<handle>/status/…`      |
| Quote  | `quotedTweetUrl`                                              |
| Reply  | `isReply` / `replyToHandle` / `replyToTweetUrl`               |

Plain mentions do not count.

Each interaction is appended to `graph/interactions.jsonl`, **versioned in git on the `claude/map-data` branch** (see section 1 bis):

```json
{"date": "2026-11-17", "from": "source_handle", "to": "target_handle", "type": "rt|quote|reply", "target_tweet_url": "…", "source_tweet_url": "…"}
```

Rules:
- Handles are lowercased, without `@`.
- No duplicates: an interaction is identified by `(source_tweet_url, type, to)`. Running twice never counts anything twice.
- `target_tweet_url` (the relayed account's tweet) is required: it is what counts **distinct tweets** (section 2).
- Self-interactions are ignored (replies in one's own thread, self-RTs).
- The file keeps the whole history. The 30-day window only applies to what is shown.

## 1 bis. Where the data lives: the `claude/map-data` branch

- The routine **cannot push to `main`**: a Claude routine can only push to `claude/…` branches. **This is on purpose**: the routine reads outside content every day (tweets, web pages) and must not be able to change the code.
- All map data therefore lives in the `graph/` folder of a **dedicated `claude/map-data` branch**, which only ever holds data: `interactions.jsonl`, `profiles.json`, `oneliners.json`, `projects.json`, `graph.json`.
- **Every day**, the routine:
  1. reads `watchlist.txt` from `main`;
  2. fetches `claude/map-data` (and creates it as an orphan branch if it does not exist);
  3. adds the day's data, rebuilds `graph.json`, commits and pushes;
  4. if the push fails, retries after a fetch and a merge, never with a force push.
- The routine **never** touches `main` or `watchlist.txt`.

## 1 ter. The engine: `pipeline/map_graph.py`

| Command | Role |
|---|---|
| `extract [data/tweets.json]` | Reads the run's tweets and appends their interactions to `interactions.jsonl`, without duplicates. |
| `seed FILE.jsonl` | Imports seed interactions (the early Discord digests). |
| `profiles` | Fetches the missing profiles (sources + discovered accounts on the map) from Mindcase, in a single call. |
| `build` | Computes `graph.json` (read by the site) and `oneliners_todo.json` (the one-liners Claude must write). |

- Data folder: `$GRAPH_DIR` (default `graph/`).
- Run order: `extract` → `profiles` → `build` → Claude writes `oneliners.json` and `projects.json` → `build`. `pipeline/update_map.sh prepare|publish` wraps these steps.
- Tests: `python3 -m unittest discover tests`.
- Mindcase fields used (checked on 2026-11-17): `retweetedTweetUrl`/`retweetedTweetText`, `quotedTweetUrl`/`quotedTweetText`, `isReply`/`replyToHandle`/`replyToTweetUrl` (formatted as `x.com/i/status/<id>`, so the handle comes from `replyToHandle`). A single tweet can be both a quote and a reply, which gives 2 interactions.

## 2. Map rules (recomputed every day)

`map_graph.py build` reads `watchlist.txt` (today's version) and `interactions.jsonl`, then writes `graph/graph.json`.

- **Source nodes**: every account in `watchlist.txt` today.
- **Discovered nodes**: an account outside the watchlist joins the map if, over the **last 30 days** (rolling window), counting only interactions from the **current** watchlist:
  - at least **2 distinct tweets** of that account got an interaction (RT, quote or reply);
  - **and** at least **2 distinct sources** interacted with it.
- **Why**: the map rewards accounts that keep posting valuable content, not one viral tweet. A tweet relayed by 5 sources counts as **1 tweet**, and a single "fan" among the sources is not enough to bring an account in.
- **Examples**:
  - 1 tweet relayed by 3 sources → **not shown**.
  - 4 tweets, all relayed by the same source → **not shown**.
  - 3 tweets relayed by 3 different sources → **shown**.
- **Tunable thresholds**: `MIN_TWEETS=2`, `MIN_WL_ACCOUNTS=2`, `WINDOW_DAYS=30`, constants at the top of the script.
- **Bubble size** of a discovered account: number of distinct tweets relayed over 30 days.
- **Links**: only source → discovered. No source ↔ source links. Thickness follows the number of interactions.
- **Big accounts** (labs, CEOs...): no filter, they show up like everyone else.
- **Removed from `watchlist.txt`**: the account becomes a candidate again. Its outgoing links disappear, and it stays on the map only if it still meets the conditions above.
- **Added to `watchlist.txt`**: the account becomes a source at the next run. It **loses its incoming links** (no source ↔ source links) and reconnects once it relays discovered accounts itself. Its interactions are collected from then on.
- **No longer relayed**: a discovered account leaves the map as soon as it no longer meets the conditions over 30 days.
- **Handle changes, suspended or private accounts**: not handled; accounts are tracked by handle (a new handle is a new node).

## 3. Profiles

- Fields kept: `displayName`, `bio`, `followers`, `profilePicture` (shown in the bubble) and `profileUrl`.
- Call to the Mindcase `twitter/profiles` agent, with the same `MINDCASE_API_KEY`:
  ```
  POST https://api.mindcase.co/v1/data/twitter/profiles/run?wait=true
  {"params": {"inputs": ["simonw", "steipete"]}}
  ```
  Handles go without `@`, and one call can hold several. The response is in `data[]`, one row per account, matched on `username`.
- **Measured cost: $0.0005 per profile**, from `usd_charged`.
- **When the API is called**:
  - when a discovered account joins the map for the first time;
  - for every source that has no profile yet (all of them on the first run, then each new addition);
  - all the accounts of a run go into **one call**.
- Results are stored in `graph/profiles.json` and **never refreshed**: the follower count shown is the one from the day it was fetched.
- Photos: a `pbs.twimg.com` URL can break if the account changes its picture. The site then shows the initials.
- If a profile is not returned (suspended account, typo), the node shows the handle alone, and the run retries once.
- The profile cost is added to the digest's "run cost" section.

## 3 bis. Context one-liners (in English)

- **One one-liner per discovered account**, summing up its **latest relayed tweet**, the one embedded in the panel. For example: *"Tip on Fable 5.2's prompting guide ("This codebase is yours")."*
- **Written by Claude at the end of the run**, after the Discord digest: only for accounts whose latest relayed tweet changed that day.
- Stored in `graph/oneliners.json`: `{handle: {text, tweet_id, date}}`.
- The whole site is **in English**. The Discord digest stays in French.

## 4. Site (`web/`)

- **Hosting**: Vercel, deployed from `main`, Root Directory `web`.
- **Data**: on load, the site reads `graph.json` straight from the `claude/map-data` branch (`raw.githubusercontent.com`, the repo is public). The daily run updates the map **without a redeploy**. GitHub's cache can delay updates by a few minutes.
- **Layout**: a single screen. A thin top bar (`signal/ who's worth following in AI`, search, `GitHub · Log in · Updated`) and the map everywhere else.
- **Bubbles**: round profile photo. **Discovered** accounts are large, in color, with a thick blue ring. **Sources** are small, black and white and faded, and turn to color on hover or selection. If a photo does not load, the bubble shows the initials.
- **Click on a bubble → side panel** with:
  - display name, @handle, bio, followers;
  - the context **one-liner**;
  - the sources that relayed it, with the interaction type;
  - an **official X embed** of the **latest** relayed tweet;
  - an **"Open on X"** button.
- Clicking a **source** shows its profile and its discoveries, with its links in blue on the map.
- Deep link to an account: `/#simonw`.
- The panel works on mobile too.

### Today's projects

- Left of the map: the titles of the digest's "Nouveaux projets" section, **in English**.
- After the Discord digest, Claude writes `graph/projects.json` (title, tag, tweet URL, links, and the digest's 4 paragraphs translated: what / how / who / try). `map_graph.py build` copies it into `graph.json` (`projects` key) and attaches each project's accounts: the tweet's author, the sources that relayed it, and the quoted account if the tweet is a quote or a reply.
- These accounts get a **green halo** on the map (and so do the links between them). On hover or click of a project, only its accounts stay visible. A project posted by a discovered account lights that account and the sources that relayed it.
- On click, the panel shows the summary (What it is, How it works, Who it's for, Try it), the Repo / Site / Paper links, the map accounts involved, and "Open the tweet on X".
- On mobile, the list is collapsed under the top bar.

### Visual design

- Name: **signal**, tagline "who's worth following in AI", lowercase.
- Colors: cream `#EEECE7`, ink `#1A1A18`, blue `#2B3BD0` (links, discovered accounts, highlights, admin controls), thin lines `#CBC8C0`. Green `#1C9A55` is reserved for today's projects. Nothing else.
- Font: Inter Tight (300/400/500). Very clean: thin lines, small caps, ↘ arrows.
- No live numbers in the copy ("our sources", not "our 19 sources").

## 5. Editing the watchlist from the site

- **Log in with GitHub** (GitHub OAuth App) through a Vercel serverless function. The **Log in** link sits in the top bar; once signed in it shows `@login · Log out`.
- Allowed users: `ADMIN_GITHUB_LOGINS` (comma-separated).
- Signed in, the panel shows **+ Add to watchlist** on a discovered account and **Remove from watchlist** on a source. Removing asks for a **confirmation** (Confirm / Cancel); adding is one click.
- The server commits `watchlist.txt` on `main` through the GitHub API, with credentials stored on Vercel and never sent to the browser. The commit message names the action and the account.
- **Add by hand**: a **+ Add an account** button (blue border) under the top bar, on the right (bottom right on mobile), opens a small "Add to the watchlist" dialog. It takes `@handle`, `handle` or an `x.com/handle` URL, at any time of day, and writes to `watchlist.txt` like the panel button.
- **Backlog**: signed in, a "Backlog · Will be in the next run" box sits under the button, flush with the right edge of the map (black border, no right border). It lists the accounts waiting for the next run: *joining* (added) and *leaving* (removed). A click opens the account's panel, with the button to undo.
  - An **added** account leaves the map right away (bubble and links) and only lives in the backlog. A **removed** account stays on the map, marked "pending", until the run.
  - An account that is not on the map yet (added by hand, or straight on GitHub) shows its initials; its panel says "added by hand" and offers "Undo: remove from watchlist", to fix a typo. Its profile arrives at the next run.
- The change shows up on the map **at the next run**. Until then, the site compares `watchlist.txt` on `main` with the watchlist in `graph.json`, and only the signed-in admin sees the difference.
- Conflicts: the commit uses the file's `sha`. If the file changed in the meantime, the server reads it again and retries.
- Code: `web/api/` (Vercel functions, no dependencies). Tests: `node --test tests/web_api.test.js`. Setup: [`docs/admin-setup.md`](admin-setup.md).

### Security

- **No personal access token is stored.**
- **GitHub login only checks identity.** It asks for the minimal scope (no repo access). The OAuth token is used to read the login, then revoked. The browser gets a signed session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, time-limited), signed with a key stored on Vercel.
- **Writes go through a dedicated GitHub App**, installed on this repo only, with a single permission: `Contents: write`. Its private key lives in Vercel's encrypted environment variables, is never sent to the browser and can be rotated at any time.
- **The server only changes `watchlist.txt`**: the file path is hard-coded.
- **Handle validation**: `^[A-Za-z0-9_]{1,15}$`. Anything else is rejected, so no extra lines or arbitrary text can be injected.
- **CSRF protection**: write routes only accept `POST` requests from the site's own origin (`Origin` header checked).
- **Admin list on the server** (`ADMIN_GITHUB_LOGINS`): the login is checked on every write, not only at sign-in.
- **Vercel**: GitHub connection limited to selected repositories. 2FA on Vercel and GitHub.
- **Accepted residual risk**: code and watchlist live in the same repo. If the GitHub App key leaked, an attacker could change the code the routine runs, and the routine holds `MINDCASE_API_KEY` and the Discord webhooks. Moving `watchlist.txt` to a separate repo would remove that risk; it was left out for simplicity.

## 6. Seeding

- The map was seeded from the first 11 Discord digests (`map_seed/discord_backfill.jsonl`, imported with `map_graph.py seed`):
  - one digest per day, in order, from 2026-11-06 to 2026-11-16;
  - interactions are tagged `"source": "discord_backfill"`;
  - "2 RTs of X" = 2 distinct tweets;
  - mentions are ignored;
  - interactions from accounts no longer in the watchlist do not count.
- Limits: the digests do not give tweet URLs. The counts are approximate, these interactions have no embed, and their one-liner comes from the digest text, already translated in the file (Claude has nothing to write for them).
- The seed leaves the 30-day window on its own, around mid-December.
