#!/usr/bin/env python3
"""Fetch the last 24 hours of tweets from the Mindcase API.

Run from the repository root: python3 pipeline/fetch_tweets.py

Inputs:
  MINDCASE_API_KEY  Mindcase key (with or without a "Bearer " prefix)
  watchlist.txt     handles to follow, one per line (fallback: TWITTER_ACCOUNTS if the file is missing)
  HOURS             (optional) window in hours, 24 by default

Outputs (data/ folder, ignored by git):
  data/raw_<n>.json   raw API response for the n-th account
  data/tweets.json    tweets kept (inside the window), each with an "account" field
  data/run.json       summary: calls, errors, billed tweets, estimated cost
The summary is also printed to stdout.

Cost guards:
  - always a date filter in `query` (never a call without one);
  - the first account is called alone; if it returns > 100 tweets or tweets
    older than 48h, the filter did not work and everything stops;
  - a 4xx error stops all calls (no retry without the filter).
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API_URL = "https://api.mindcase.co/v1/data/twitter/tweets/run?wait=true"
PRICE_PER_TWEET = 0.00025  # $
MAX_FIRST_CALL = 100
STALE_HOURS = 48

os.makedirs("data", exist_ok=True)  # relative to the working directory: run from the repository root


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


key = os.environ.get("MINDCASE_API_KEY", "").strip()
key = re.sub(r"^bearer\s+", "", key, flags=re.I)
if not key:
    die("MINDCASE_API_KEY is empty.")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repository root
WATCHLIST_FILE = os.path.join(ROOT, "watchlist.txt")
try:
    with open(WATCHLIST_FILE, encoding="utf-8") as f:
        raw_accounts = "\n".join(line.split("#", 1)[0] for line in f)
except OSError:
    raw_accounts = os.environ.get("TWITTER_ACCOUNTS", "")  # fallback if watchlist.txt is missing
accounts = list(dict.fromkeys(a.lstrip("@") for a in re.split(r"[\s,;]+", raw_accounts) if a.lstrip("@")))
if not accounts:
    die("No accounts: fill in watchlist.txt (one handle per line).")

hours = int(os.environ.get("HOURS", "24"))
now = time.time()
since = int(now - hours * 3600)


def extract_rows(payload):
    """Find the list of tweets in the response, whatever its key."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ("data", "results", "rows", "items", "records", "tweets"):
            v = payload.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                inner = extract_rows(v)
                if inner:
                    return inner
    return []


def find_cost(payload):
    """Return a real cost field if the response has one."""
    if isinstance(payload, dict):
        for k, v in payload.items():
            if k.lower() in ("cost", "credits", "credits_used", "billed", "billed_rows", "usage", "price") and not isinstance(v, list):
                return {k: v}
            if isinstance(v, dict):
                found = find_cost(v)
                if found:
                    return found
    return None


def find_notices(payload, path=""):
    """Collect the notices (low balance, warnings) found in the response."""
    out = []
    if isinstance(payload, dict):
        for k, v in payload.items():
            kl = k.lower()
            if any(w in kl for w in ("balance", "notice", "warning", "message")) and not isinstance(v, list):
                out.append({f"{path}{k}": v})
            elif isinstance(v, dict):
                out += find_notices(v, f"{path}{k}.")
    return out


def parse_date(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        pass
    for fmt in ("%a %b %d %H:%M:%S %z %Y",):
        try:
            return datetime.strptime(s, fmt).timestamp()
        except ValueError:
            pass
    return None


def call(handle):
    body = json.dumps({"params": {"query": f"from:{handle} since_time:{since} include:nativeretweets"}}).encode()
    req = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")[:500]
        return e.code, {"error": text}
    except Exception as e:  # network, timeout, invalid JSON
        return 0, {"error": f"{type(e).__name__}: {e}"}


summary = {"calls": 0, "ok": 0, "failed": 0, "billed_tweets": 0, "kept_tweets": 0,
           "real_cost_fields": [], "notices": [], "errors": [], "stopped": None, "per_account": []}
kept = []

for i, handle in enumerate(accounts):
    status, payload = call(handle)
    summary["calls"] += 1
    with open(f"data/raw_{i + 1}.json", "w") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    if status != 200:
        summary["failed"] += 1
        err = payload.get("error") if isinstance(payload, dict) else payload
        summary["errors"].append({"account": handle, "status": status, "error": err})
        if 400 <= status < 500:
            summary["stopped"] = f"error {status} on {handle}: calls stopped (no retry without the filter)"
            break
        continue

    summary["ok"] += 1
    for n in find_notices(payload):
        if n not in summary["notices"]:
            summary["notices"].append(n)
    rows = extract_rows(payload)
    cost = find_cost(payload)
    if cost:
        summary["real_cost_fields"].append({"account": handle, **cost})
    summary["billed_tweets"] += len(rows)

    dates = [parse_date(r.get("postedDate") or r.get("createdAt")) for r in rows if isinstance(r, dict)]
    stale = [d for d in dates if d and d < now - STALE_HOURS * 3600]
    if i == 0 and (len(rows) > MAX_FIRST_CALL or stale):
        summary["stopped"] = (f"the first account returned {len(rows)} tweets, {len(stale)} of them older than "
                              f"{STALE_HOURS}h: the date filter is not working, calls stopped")
        break

    n_kept = 0
    for r, d in zip([r for r in rows if isinstance(r, dict)], dates):
        if d is None or d >= since:
            kept.append({"account": handle, **r})
            n_kept += 1
    summary["per_account"].append({"account": handle, "returned": len(rows), "kept": n_kept})

summary["kept_tweets"] = len(kept)
summary["estimated_cost_usd"] = round(summary["billed_tweets"] * PRICE_PER_TWEET, 5)
summary["estimated_cost_cents"] = round(summary["billed_tweets"] * PRICE_PER_TWEET * 100, 3)
summary["window"] = {"hours": hours, "since_utc": datetime.fromtimestamp(since, timezone.utc).isoformat()}

with open("data/tweets.json", "w") as f:
    json.dump(kept, f, ensure_ascii=False, indent=1)
with open("data/run.json", "w") as f:
    json.dump(summary, f, ensure_ascii=False, indent=1)

print(json.dumps(summary, ensure_ascii=False, indent=1))
sys.exit(2 if summary["stopped"] or (summary["calls"] and not summary["ok"]) else 0)
