#!/usr/bin/env python3
"""Moteur de la map des comptes (voir docs/map-spec.md). Python 3, sans dépendance.

Commandes :
  python3 map_graph.py extract [data/tweets.json]   ajoute les interactions du jour à interactions.jsonl
  python3 map_graph.py seed FICHIER.jsonl           importe des interactions d'amorce (ex. digests Discord)
  python3 map_graph.py profiles                     récupère via Mindcase les profils manquants des nœuds de la map
  python3 map_graph.py build                        calcule graph.json et oneliners_todo.json

Dossier des données : $GRAPH_DIR (défaut : graph/). En production c'est le dossier
graph/ de la branche claude/map-data, jamais main.

Ordre d'un run quotidien : extract -> profiles -> build -> (Claude écrit oneliners.json) -> build.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

# --- Réglages (section 2 de la spec) ---
MIN_TWEETS = 2        # tweets différents du compte relayés par la whitelist
MIN_WL_ACCOUNTS = 2   # comptes différents de la whitelist qui l'ont relayé
WINDOW_DAYS = 30      # fenêtre glissante
PROFILE_MAX_ATTEMPTS = 2  # 1er essai + 1 réessai si Mindcase ne renvoie pas le profil
TEXT_MAX = 600        # longueur max des textes stockés (pour les one-liners)

PROFILES_URL = "https://api.mindcase.co/v1/data/twitter/profiles/run?wait=true"
HERE = os.path.dirname(os.path.abspath(__file__))
GRAPH_DIR = os.environ.get("GRAPH_DIR", "graph")
HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
STATUS_RE = re.compile(r"(?:x|twitter)\.com/([^/?#]+)/status(?:es)?/(\d+)", re.I)


def path(name):
    return os.path.join(GRAPH_DIR, name)


def today():
    """Date du jour (UTC). MAP_TODAY=AAAA-MM-JJ la fixe, pour les tests."""
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
    """Même lecture que fetch_tweets.py : un handle par ligne, # = commentaire."""
    accounts_file = os.environ.get("ACCOUNTS_FILE", os.path.join(HERE, "accounts.txt"))
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
    """Ajoute sans doublon. Renvoie le nombre réellement ajouté."""
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
    """Un tweet d'un compte de la whitelist -> 0 à 2 interactions (un tweet peut être reply ET quote)."""
    src = norm(t.get("account") or (t.get("author") or {}).get("handle"))
    source_url = t.get("tweetUrl")
    if not src or not source_url:
        return []
    d = tweet_date(t)
    found = []

    def add(kind, to, tweet_id, text):
        to = norm(to)
        if not to or to == "i" or to == src or not HANDLE_RE.match(to) or not tweet_id:
            return  # handle inconnu, interaction avec soi-même, ou donnée incomplète
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
        return found  # un RT natif n'a pas d'autre contenu propre

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
        sys.exit("usage : map_graph.py seed FICHIER.jsonl")
    with open(args[0], encoding="utf-8") as f:
        items = [json.loads(l) for l in f if l.strip() and not l.lstrip().startswith("//")]
    for it in items:
        it["from"], it["to"] = norm(it["from"]), norm(it["to"])
        it.setdefault("source", "seed")
    print(json.dumps({"seed_items": len(items), "added": append_interactions(items)}))


# --- Calcul de la map ---

def compute_map(whitelist, interactions, ref_day):
    """Applique les règles de la section 2. Renvoie {handle: stats} des candidats retenus."""
    wl = set(whitelist)
    start = (ref_day - timedelta(days=WINDOW_DAYS - 1)).isoformat()
    end = ref_day.isoformat()
    per = {}
    for it in interactions:
        if not (start <= it["date"] <= end):
            continue
        if it["from"] not in wl or it["to"] in wl:
            continue  # source retirée de la whitelist, ou lien whitelist <-> whitelist
        per.setdefault(it["to"], []).append(it)

    kept = {}
    for handle, its in per.items():
        tweets = {it["target_tweet_id"] for it in its}
        relayers = {it["from"] for it in its}
        if len(tweets) >= MIN_TWEETS and len(relayers) >= MIN_WL_ACCOUNTS:
            kept[handle] = its
    return kept


def latest_relayed(its):
    """Dernier tweet relayé : date la plus récente, puis ID le plus grand (les IDs X sont chronologiques).
    On préfère un tweet avec une vraie URL (les amorces Discord n'en ont pas)."""
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
        sys.exit("MINDCASE_API_KEY est vide.")
    body = json.dumps({"params": {"inputs": wanted}}).encode()
    req = urllib.request.Request(PROFILES_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            payload = json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"Mindcase profils : HTTP {e.code} {e.read().decode(errors='replace')[:300]}")

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
        "display_name": p.get("display_name"), "bio": p.get("bio"),
        "followers": p.get("followers"), "photo": p.get("photo"),
        "profile_url": p.get("profile_url") or f"https://x.com/{h}",
    }


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
            # amorce Discord : le one-liner (déjà traduit) vient du digest, pas besoin de Claude
            ol = {"text": latest["digest_note"], "tweet_id": latest["tweet_id"]}
        if not ol or ol.get("tweet_id") != latest["tweet_id"]:
            todo.append({"handle": h, **latest})
            ol = None  # pas de one-liner périmé affiché pour un nouveau tweet
        nodes.append({
            "id": h, "kind": "candidate", **node_profile(h, profiles),
            "tweets": len({it["target_tweet_id"] for it in its}),
            "relayed_by": sorted({it["from"] for it in its}),
            "interactions": len(its),
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
