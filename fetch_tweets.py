#!/usr/bin/env python3
"""Récupère les tweets des dernières 24h via l'API Mindcase.

Variables d'environnement :
  MINDCASE_API_KEY  clé Mindcase (avec ou sans préfixe "Bearer ")
  TWITTER_ACCOUNTS  handles à suivre, séparés par des virgules ou des espaces
  HOURS             (optionnel) fenêtre en heures, 24 par défaut

Sorties (dossier data/, ignoré par git) :
  data/raw_<n>.json   réponse brute de l'API pour le n-ième compte
  data/tweets.json    tweets gardés (fenêtre respectée), avec le champ "account"
  data/run.json       résumé : appels, erreurs, tweets facturés, coût estimé
Le résumé est aussi affiché sur stdout.

Garde-fous coût :
  - toujours un filtre de date dans `query` (jamais d'appel sans) ;
  - le premier compte est appelé seul ; s'il renvoie > 100 tweets ou des
    tweets de plus de 48h, le filtre n'a pas marché et on arrête tout ;
  - une erreur 4xx arrête tous les appels (pas de réessai sans filtre).
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

os.makedirs("data", exist_ok=True)


def die(msg):
    print(f"ERREUR : {msg}", file=sys.stderr)
    sys.exit(1)


key = os.environ.get("MINDCASE_API_KEY", "").strip()
key = re.sub(r"^bearer\s+", "", key, flags=re.I)
if not key:
    die("MINDCASE_API_KEY est vide.")

accounts = [a.lstrip("@") for a in re.split(r"[\s,;]+", os.environ.get("TWITTER_ACCOUNTS", "")) if a]
if not accounts:
    die("TWITTER_ACCOUNTS est vide (ex. TWITTER_ACCOUNTS=handle1,handle2).")

hours = int(os.environ.get("HOURS", "24"))
now = time.time()
since = int(now - hours * 3600)


def extract_rows(payload):
    """Trouve la liste de tweets dans la réponse, quelle que soit la clé."""
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
    """Renvoie un champ de coût réel s'il existe dans la réponse."""
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
    """Récupère les notices (solde bas, avertissements) présentes dans la réponse."""
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
    except Exception as e:  # réseau, timeout, JSON invalide
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
            summary["stopped"] = f"erreur {status} sur {handle} : appels arrêtés (pas de réessai sans filtre)"
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
        summary["stopped"] = (f"le premier compte a renvoyé {len(rows)} tweets dont {len(stale)} de plus de "
                              f"{STALE_HOURS}h : le filtre de date ne marche pas, appels arrêtés")
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
