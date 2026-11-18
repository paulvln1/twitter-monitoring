#!/usr/bin/env python3
"""Account map engine (see docs/map-spec.md). Python 3, no dependencies.

Commands:
  python3 pipeline/map_graph.py extract [data/tweets.json]   append today's interactions to interactions.jsonl
  python3 pipeline/map_graph.py seed FILE.jsonl              import seed interactions (e.g. from Discord digests)
  python3 pipeline/map_graph.py profiles                     fetch missing profiles of map nodes from Mindcase
  python3 pipeline/map_graph.py build                        compute graph.json and oneliners_todo.json
                                                             (with today's projects from projects.json, if any)

Data folder: $GRAPH_DIR (default: graph/). In production it is the graph/ folder
of the claude/map-data branch, never main.

Daily run order: extract -> profiles -> build -> (Claude writes oneliners.json) -> build.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

# --- Settings (spec, section 2) ---
MIN_TWEETS = 2        # distinct tweets of the account relayed by the watchlist
MIN_WL_ACCOUNTS = 2   # distinct watchlist accounts that relayed it
WINDOW_DAYS = 30      # rolling window
PROFILE_MAX_ATTEMPTS = 2  # first try + one retry if Mindcase returns no profile
TEXT_MAX = 600        # max length of stored texts (used for one-liners)

PROFILES_URL = "https://api.mindcase.co/v1/data/twitter/profiles/run?wait=true"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repository root
GRAPH_DIR = os.environ.get("GRAPH_DIR", "graph")
HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
STATUS_RE = re.compile(r"(?:x|twitter)\.com/([^/?#]+)/status(?:es)?/(\d+)", re.I)


def path(name):
    return os.path.join(GRAPH_DIR, name)


def today():
    """Today's date (UTC). MAP_TODAY=YYYY-MM-DD pins it, for tests."""
    forced = os.environ.get("MAP_TODAY")
    return date.fromisoformat(forced) if forced else datetime.now(timezone.utc).date()


def norm(handle):
    return (handle or "").strip().lstrip("@").lower()


def load_json(name, default):
    try:
        with open(path(name), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(name, obj):
    os.makedirs(GRAPH_DIR, exist_ok=True)
    tmp = path(name) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path(name))


def load_whitelist():
    """Same parsing as fetch_tweets.py: one handle per line, # starts a comment."""
    accounts_file = os.environ.get("WATCHLIST_FILE", os.path.join(ROOT, "watchlist.txt"))
    with open(accounts_file, encoding="utf-8") as f:
        raw = "\n".join(line.split("#", 1)[0] for line in f)
    return list(dict.fromkeys(norm(a) for a in re.split(r"[\s,;]+", raw) if norm(a)))


def load_interactions():
    out = []
    try:
        with open(path("interactions.jsonl"), encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    out.append(json.loads(line))
    except FileNotFoundError:
        pass
    return out


def interaction_key(it):
    return (it["source_tweet_url"], it["type"], it["to"])


def append_interactions(new):
    """Append without duplicates. Returns how many were actually added."""
    seen = {interaction_key(it) for it in load_interactions()}
    added = []
    for it in new:
        k = interaction_key(it)
        if k not in seen:
            seen.add(k)
            added.append(it)
    if added:
        os.makedirs(GRAPH_DIR, exist_ok=True)
        with open(path("interactions.jsonl"), "a", encoding="utf-8") as f:
            for it in added:
                f.write(json.dumps(it, ensure_ascii=False, sort_keys=True) + "\n")
    return len(added)


def clip(text):
    if not text:
        return None
    text = str(text).strip()
    return text if len(text) <= TEXT_MAX else text[:TEXT_MAX - 1] + "…"


def tweet_date(t):
    s = t.get("postedDate") or t.get("createdAt")
    if not s:
        return today().isoformat()
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(timezone.utc).date().isoformat()
    except ValueError:
        try:
            return datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y").astimezone(timezone.utc).date().isoformat()
        except ValueError:
            return today().isoformat()


def interactions_from_tweet(t):
    """One tweet from a watchlist account -> 0 to 2 interactions (a tweet can be both a reply and a quote)."""
    src = norm(t.get("account") or (t.get("author") or {}).get("handle"))
    source_url = t.get("tweetUrl")
    if not src or not source_url:
        return []
    d = tweet_date(t)
    found = []

    def add(kind, to, tweet_id, text):
        to = norm(to)
        if not to or to == "i" or to == src or not HANDLE_RE.match(to) or not tweet_id:
            return  # unknown handle, self-interaction, or incomplete data
        found.append({
            "date": d, "from": src, "to": to, "type": kind,
            "target_tweet_id": str(tweet_id),
            "target_tweet_url": f"https://x.com/{to}/status/{tweet_id}",
            "target_text": clip(text),
            "source_tweet_url": source_url,
            "source_text": clip(t.get("tweetText")) if kind != "rt" else None,
            "source": "api",
        })

    rt = STATUS_RE.search(t.get("retweetedTweetUrl") or "")
    if rt:
        add("rt", rt.group(1), rt.group(2), t.get("retweetedTweetText"))
        return found  # a native RT has no content of its own

    qt = STATUS_RE.search(t.get("quotedTweetUrl") or "")
    if qt:
        add("quote", qt.group(1), qt.group(2), t.get("quotedTweetText"))

    if t.get("isReply") or t.get("replyToHandle"):
        rp = STATUS_RE.search(t.get("replyToTweetUrl") or "")
        if rp:
            add("reply", t.get("replyToHandle"), rp.group(2), None)
    return found


def cmd_extract(args):
    src = args[0] if args else "data/tweets.json"
    with open(src, encoding="utf-8") as f:
        tweets = json.load(f)
    new = [it for t in tweets if isinstance(t, dict) for it in interactions_from_tweet(t)]
    n = append_interactions(new)
    print(json.dumps({"tweets": len(tweets), "interactions_found": len(new), "added": n}))


def cmd_seed(args):
    if not args:
        sys.exit("usage: map_graph.py seed FILE.jsonl")
    with open(args[0], encoding="utf-8") as f:
        items = [json.loads(l) for l in f if l.strip() and not l.lstrip().startswith("//")]
    for it in items:
        it["from"], it["to"] = norm(it["from"]), norm(it["to"])
        it.setdefault("source", "seed")
    print(json.dumps({"seed_items": len(items), "added": append_interactions(items)}))


# --- Map computation ---

def compute_map(whitelist, interactions, ref_day):
    """Apply the rules of section 2. Returns {handle: interactions} for the accounts that make the map."""
    wl = set(whitelist)
    start = (ref_day - timedelta(days=WINDOW_DAYS - 1)).isoformat()
    end = ref_day.isoformat()
    per = {}
    for it in interactions:
        if not (start <= it["date"] <= end):
            continue
        if it["from"] not in wl or it["to"] in wl:
            continue  # source no longer in the watchlist, or a watchlist <-> watchlist link
        per.setdefault(it["to"], []).append(it)

    kept = {}
    for handle, its in per.items():
        tweets = {it["target_tweet_id"] for it in its}
        relayers = {it["from"] for it in its}
        if len(tweets) >= MIN_TWEETS and len(relayers) >= MIN_WL_ACCOUNTS:
            kept[handle] = its
    return kept


def qualified_since(its):
    """First day (within the window) the account met both conditions: drives the "new" badge."""
    tweets, relayers = set(), set()
    for it in sorted(its, key=lambda x: x["date"]):
        tweets.add(it["target_tweet_id"])
        relayers.add(it["from"])
        if len(tweets) >= MIN_TWEETS and len(relayers) >= MIN_WL_ACCOUNTS:
            return it["date"]
    return None


def latest_relayed(its):
    """Latest relayed tweet: most recent date, then highest ID (X IDs are chronological).
    A tweet with a real URL wins (Discord seeds have none)."""
    def rank(it):
        real = it.get("target_tweet_url") is not None
        tid = int(it["target_tweet_id"]) if it["target_tweet_id"].isdigit() else 0
        return (real, it["date"], tid)
    best = max(its, key=rank)
    same = [it for it in its if it["target_tweet_id"] == best["target_tweet_id"]]
    return {
        "tweet_id": best["target_tweet_id"],
        "tweet_url": best.get("target_tweet_url"),
        "date": best["date"],
        "by": sorted({it["from"] for it in same}),
        "types": sorted({it["type"] for it in same}),
        "target_text": next((it.get("target_text") for it in same if it.get("target_text")), None),
        "source_texts": [it["source_text"] for it in same if it.get("source_text")][:3],
        "digest_note": next((it.get("note") for it in same if it.get("note")), None),
    }


def map_handles():
    wl = load_whitelist()
    kept = compute_map(wl, load_interactions(), today())
    return wl, kept


def cmd_profiles(_args):
    wl, kept = map_handles()
    profiles = load_json("profiles.json", {})
    attempts = load_json("profiles_missing.json", {})
    wanted = [h for h in wl + sorted(kept)
              if h not in profiles and attempts.get(h, 0) < PROFILE_MAX_ATTEMPTS]
    if not wanted:
        print(json.dumps({"requested": 0}))
        return
    key = re.sub(r"^bearer\s+", "", os.environ.get("MINDCASE_API_KEY", "").strip(), flags=re.I)
    if not key:
        sys.exit("MINDCASE_API_KEY is empty.")
    body = json.dumps({"params": {"inputs": wanted}}).encode()
    req = urllib.request.Request(PROFILES_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            payload = json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"Mindcase profiles: HTTP {e.code} {e.read().decode(errors='replace')[:300]}")

    got = set()
    for row in payload.get("data") or []:
        h = norm(row.get("username"))
        if h not in wanted:
            continue
        got.add(h)
        profiles[h] = {
            "handle": row.get("username"),
            "display_name": row.get("displayName"),
            "bio": row.get("bio"),
            "followers": row.get("followers"),
            "photo": row.get("profilePicture"),
            "profile_url": row.get("profileUrl") or f"https://x.com/{h}",
            "fetched_at": today().isoformat(),
        }
    for h in wanted:
        if h in got:
            attempts.pop(h, None)
        else:
            attempts[h] = attempts.get(h, 0) + 1
    save_json("profiles.json", profiles)
    save_json("profiles_missing.json", attempts)
    print(json.dumps({"requested": len(wanted), "received": len(got),
                      "missing": sorted(set(wanted) - got), "usd_charged": payload.get("usd_charged")}))


def node_profile(h, profiles):
    p = profiles.get(h) or {}
    return {
        "handle": p.get("handle") or h,
        "display_name": p.get("display_name"), "bio": p.get("bio"),
        "followers": p.get("followers"), "photo": p.get("photo"),
        "profile_url": p.get("profile_url") or f"https://x.com/{h}",
    }


PROJECT_TEXTS = ("what", "how", "who", "try")
PROJECT_TEXT_MAX = 700
PROJECTS_MAX = 8


def short(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[:n - 1] + "…"


def build_projects(interactions):
    """Today's projects written by Claude (projects.json), enriched with the accounts involved.

    For each project, `accounts` = the tweet's author, the watchlist accounts that relayed it
    (RT, quote, reply) and, if the tweet itself quotes or replies to someone, that account.
    The site lights these accounts in green. Returns None if projects.json does not exist.
    """
    raw = load_json("projects.json", None)
    if not isinstance(raw, dict):
        return None
    items = []
    for p in raw.get("projects") or []:
        if not isinstance(p, dict) or len(items) >= PROJECTS_MAX:
            continue
        title = short(p.get("title"), 120)
        m = STATUS_RE.search(str(p.get("tweet_url") or ""))
        if not title or not m or not HANDLE_RE.match(m.group(1)):
            continue
        author, tid = norm(m.group(1)), m.group(2)
        accounts = [author]
        for it in interactions:
            src = STATUS_RE.search(it.get("source_tweet_url") or "")
            if it["target_tweet_id"] == tid:
                accounts.append(it["from"])
            elif src and src.group(2) == tid:
                accounts.append(it["to"])
        links = []
        for link in p.get("links") or []:
            url = str((link or {}).get("url") or "") if isinstance(link, dict) else ""
            if url.startswith("https://") and len(links) < 4:
                links.append({"label": short(link.get("label") or "Link", 20), "url": url})
        items.append({
            "title": title,
            "tag": short(p.get("tag"), 30) or None,
            "tweet_url": f"https://x.com/{m.group(1)}/status/{tid}",
            "author": author,
            "accounts": list(dict.fromkeys(accounts)),
            "links": links,
            **{k: short(p.get(k), PROJECT_TEXT_MAX) or None for k in PROJECT_TEXTS},
        })
    return {"date": str(raw.get("date") or today().isoformat())[:10], "items": items}


def cmd_build(_args):
    wl, kept = map_handles()
    profiles = load_json("profiles.json", {})
    oneliners = load_json("oneliners.json", {})
    nodes, edges, todo = [], [], []

    for h in wl:
        nodes.append({"id": h, "kind": "whitelist", **node_profile(h, profiles)})

    for h in sorted(kept):
        its = kept[h]
        latest = latest_relayed(its)
        ol = oneliners.get(h)
        if (not ol or ol.get("tweet_id") != latest["tweet_id"]) and latest["digest_note"]:
            # Discord seed: the one-liner (already in English) comes from the digest, no need for Claude
            ol = {"text": latest["digest_note"], "tweet_id": latest["tweet_id"]}
        if not ol or ol.get("tweet_id") != latest["tweet_id"]:
            todo.append({"handle": h, **latest})
            ol = None  # never show a stale one-liner for a new tweet
        nodes.append({
            "id": h, "kind": "candidate", **node_profile(h, profiles),
            "tweets": len({it["target_tweet_id"] for it in its}),
            "relayed_by": sorted({it["from"] for it in its}),
            "interactions": len(its),
            "since": qualified_since(its),
            "latest": {k: latest[k] for k in ("tweet_url", "date", "by", "types")},
            "oneliner": ol.get("text") if ol else None,
        })
        by_src = {}
        for it in its:
            e = by_src.setdefault(it["from"], {"source": it["from"], "target": h, "weight": 0, "types": set()})
            e["weight"] += 1
            e["types"].add(it["type"])
        edges += [{**e, "types": sorted(e["types"])} for e in by_src.values()]

    graph = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "as_of": today().isoformat(),
        "rules": {"min_tweets": MIN_TWEETS, "min_wl_accounts": MIN_WL_ACCOUNTS, "window_days": WINDOW_DAYS},
        "whitelist": wl,
        "nodes": nodes,
        "edges": edges,
    }
    projects = build_projects(load_interactions())
    if projects is not None:
        graph["projects"] = projects
    save_json("graph.json", graph)
    save_json("oneliners_todo.json", todo)
    print(json.dumps({"whitelist": len(wl), "candidates": len(kept), "edges": len(edges),
                      "oneliners_todo": [t["handle"] for t in todo],
                      "missing_profiles": [n["id"] for n in nodes if n["display_name"] is None]}))


COMMANDS = {"extract": cmd_extract, "seed": cmd_seed, "profiles": cmd_profiles, "build": cmd_build}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.exit(__doc__)
    COMMANDS[sys.argv[1]](sys.argv[2:])
