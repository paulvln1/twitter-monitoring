#!/usr/bin/env python3
"""Envoie le digest sur Discord, sous forme d'embeds, via un webhook.

Usage :
  python3 post_discord.py [fichier]       # par défaut data/digest.md
  python3 post_discord.py --dry-run [f]   # affiche les payloads sans rien envoyer

Variable d'environnement :
  DISCORD_WEBHOOK_URL  URL du webhook Discord (https://discord.com/api/webhooks/...)

Mise en forme :
  - chaque section « ## » / « ### » du digest devient un embed (titre + couleur) ;
  - le texte avant la première section (alertes, solde…) devient un embed d'en-tête ;
  - les liens Markdown [texte](url) deviennent des liens cliquables ; les URL
    de tweets laissées « nues » sont converties en [@handle](url) ;
  - limites Discord respectées : 4096 caractères par embed, 10 embeds et
    6000 caractères par message (découpage aux paragraphes, puis aux lignes).
L'URL du webhook n'est jamais affichée.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DESC_MAX = 4096
TITLE_MAX = 256
MSG_EMBEDS_MAX = 10
MSG_CHARS_MAX = 6000
USERNAME = "Veille Twitter"
WEBHOOK_VARS = ("DISCORD_WEBHOOK_URL", "DISCORD_WEBHOOK_URL_2")
USER_AGENT = "DiscordBot (https://github.com/paulvln1/twitter-monitoring, 1.0)"

COLORS = [  # (mot-clé dans le titre de section, couleur)
    ("projet", 0x5865F2),
    ("concept", 0x57F287),
    ("take", 0xFEE75C),
    ("compte", 0xEB459E),
    ("coût", 0x95A5A6),
    ("cout", 0x95A5A6),
]
DEFAULT_COLOR = 0x5865F2
ALERT_COLOR = 0xED4245

BARE_TWEET_URL = re.compile(
    r"(?<![(<\[])\bhttps?://(?:www\.)?(?:x|twitter)\.com/(\w+)/status/(\d+)[^\s)\]>]*"
)


def color_for(title):
    t = title.lower()
    for word, color in COLORS:
        if word in t:
            return color
    return DEFAULT_COLOR


def linkify(text):
    """Transforme les URL de tweets nues en liens masqués [@handle](url)."""
    def repl(m):
        url = m.group(0).rstrip(".,;:!?")
        tail = m.group(0)[len(url):]
        return f"[@{m.group(1)}]({url}){tail}"
    return BARE_TWEET_URL.sub(repl, text)


def clean_body(text):
    """Sous-titres Markdown (#### …) → gras, plus lisible dans un embed."""
    out = []
    for line in text.splitlines():
        m = re.match(r"^#{1,6}\s+(.*)$", line)
        out.append(f"**{m.group(1).strip()}**" if m else line)
    return "\n".join(out).strip()


def split_sections(md):
    """Renvoie [(titre ou None, corps)] en coupant sur les titres ## / ###."""
    sections, title, buf = [], None, []
    for line in md.splitlines():
        m = re.match(r"^#{1,3}\s+(.*)$", line)
        if m:
            if title is not None or "".join(buf).strip():
                sections.append((title, "\n".join(buf)))
            title, buf = m.group(1).strip(), []
        else:
            buf.append(line)
    if title is not None or "".join(buf).strip():
        sections.append((title, "\n".join(buf)))
    return sections


def chunk(text, limit):
    """Découpe en morceaux ≤ limit : paragraphes, puis lignes, puis coupe dure."""
    if len(text) <= limit:
        return [text]
    pieces, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        units = [para] if len(para) <= limit else para.split("\n")
        sep = "\n\n"
        for u in units:
            while len(u) > limit:  # ligne gigantesque : coupe dure
                if cur:
                    pieces.append(cur)
                    cur = ""
                pieces.append(u[:limit])
                u = u[limit:]
            if not cur:
                cur = u
            elif len(cur) + len(sep) + len(u) <= limit:
                cur += sep + u
            else:
                pieces.append(cur)
                cur = u
            sep = "\n"
    if cur:
        pieces.append(cur)
    return [p for p in pieces if p.strip()]


def build_embeds(md):
    embeds = []
    for title, body in split_sections(md):
        body = linkify(clean_body(body))
        if title is None:
            color, title = ALERT_COLOR if body else DEFAULT_COLOR, None
        else:
            title = linkify(title)[:TITLE_MAX]
            color = color_for(title)
        parts = chunk(body, DESC_MAX) if body else [""]
        for i, part in enumerate(parts):
            e = {"color": color}
            if title and i == 0:
                e["title"] = title
            elif title:
                e["title"] = f"{title} (suite)"[:TITLE_MAX]
            if part:
                e["description"] = part
            if "title" in e or "description" in e:
                embeds.append(e)
    if embeds:
        embeds[-1]["footer"] = {"text": "Veille Twitter quotidienne"}
        embeds[-1]["timestamp"] = datetime.now(timezone.utc).isoformat()
    return embeds


def embed_size(e):
    return len(e.get("title", "")) + len(e.get("description", "")) + len(
        e.get("footer", {}).get("text", "")
    )


def pack(embeds):
    """Regroupe les embeds en messages (≤ 10 embeds, ≤ 6000 caractères)."""
    msgs, cur, size = [], [], 0
    for e in embeds:
        s = embed_size(e)
        if cur and (len(cur) >= MSG_EMBEDS_MAX or size + s > MSG_CHARS_MAX):
            msgs.append(cur)
            cur, size = [], 0
        cur.append(e)
        size += s
    if cur:
        msgs.append(cur)
    return msgs


def post(url, payload):
    data = json.dumps(payload).encode()
    for attempt in range(3):
        req = urllib.request.Request(
            url + ("&" if "?" in url else "?") + "wait=true",
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status
        except urllib.error.HTTPError as err:
            body = err.read().decode(errors="replace")[:300]
            if err.code == 429 and attempt < 2:
                try:
                    wait = float(json.loads(body).get("retry_after", 2))
                except ValueError:
                    wait = 2
                time.sleep(min(wait, 30) + 0.5)
                continue
            raise RuntimeError(f"HTTP {err.code} : {body}") from None
        except urllib.error.URLError as err:
            raise RuntimeError(f"réseau : {err.reason}") from None
    raise RuntimeError("trop de rate limits (429)")


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    path = args[0] if args else "data/digest.md"

    try:
        with open(path, encoding="utf-8") as f:
            md = f.read()
    except OSError as err:
        print(f"ERREUR Discord : impossible de lire {path} ({err.strerror}).", file=sys.stderr)
        return 1
    if not md.strip():
        print(f"ERREUR Discord : {path} est vide.", file=sys.stderr)
        return 1

    messages = pack(build_embeds(md))

    if dry:
        for i, embeds in enumerate(messages, 1):
            print(f"--- message {i}/{len(messages)} ({len(embeds)} embeds) ---")
            print(json.dumps({"embeds": embeds}, ensure_ascii=False, indent=2))
        return 0

    # Un ou plusieurs webhooks : DISCORD_WEBHOOK_URL, DISCORD_WEBHOOK_URL_2, ...
    targets = []
    for name in WEBHOOK_VARS:
        url = os.environ.get(name, "").strip()
        if not url:
            continue
        if not re.match(r"^https://(?:\w+\.)?discord(?:app)?\.com/api/webhooks/", url):
            print(f"ERREUR Discord : {name} n'est pas une URL de webhook Discord.", file=sys.stderr)
            return 1
        targets.append((name, url))
    if not targets:
        print("ERREUR Discord : DISCORD_WEBHOOK_URL est vide.", file=sys.stderr)
        return 1

    failed = False
    for name, url in targets:
        for i, embeds in enumerate(messages, 1):
            payload = {"username": USERNAME, "embeds": embeds, "allowed_mentions": {"parse": []}}
            try:
                post(url, payload)
            except RuntimeError as err:
                print(f"ERREUR Discord ({name}) : message {i}/{len(messages)} non envoyé ({err}).", file=sys.stderr)
                failed = True
                break  # on passe au webhook suivant
            if i < len(messages):
                time.sleep(1)
        else:
            print(f"Discord ({name}) : digest envoyé ({len(messages)} message(s), "
                  f"{sum(len(m) for m in messages)} embed(s)).")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
