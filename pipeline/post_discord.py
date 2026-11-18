#!/usr/bin/env python3
"""Post the digest to Discord as embeds, through one or more webhooks.

Usage:
  python3 pipeline/post_discord.py [file]       # data/digest.md by default
  python3 pipeline/post_discord.py --dry-run [f]  # print the payloads, send nothing

Environment:
  DISCORD_WEBHOOK_URL, DISCORD_WEBHOOK_URL_2  Discord webhook URLs (https://discord.com/api/webhooks/...)

Formatting:
  - each "##" / "###" section of the digest becomes an embed (title + color);
  - text before the first section (alerts, balance...) becomes a header embed;
  - Markdown links [text](url) become clickable; bare tweet URLs are turned
    into [@handle](url);
  - Discord limits are respected: 4096 characters per embed, 10 embeds and
    6000 characters per message (split on paragraphs, then on lines).
The digest itself is in French, so the Discord-facing strings below stay in French.
Webhook URLs are never printed.
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
USERNAME = "Veille Twitter"  # bot name shown in Discord (French, like the digest)
WEBHOOK_VARS = ("DISCORD_WEBHOOK_URL", "DISCORD_WEBHOOK_URL_2")
USER_AGENT = "DiscordBot (https://github.com/paulvln1/twitter-monitoring, 1.0)"

COLORS = [  # (keyword in the French section title, color)
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
    """Turn bare tweet URLs into masked links [@handle](url)."""
    def repl(m):
        url = m.group(0).rstrip(".,;:!?")
        tail = m.group(0)[len(url):]
        return f"[@{m.group(1)}]({url}){tail}"
    return BARE_TWEET_URL.sub(repl, text)


def clean_body(text):
    """Markdown subheadings (#### ...) -> bold, easier to read in an embed."""
    out = []
    for line in text.splitlines():
        m = re.match(r"^#{1,6}\s+(.*)$", line)
        out.append(f"**{m.group(1).strip()}**" if m else line)
    return "\n".join(out).strip()


def split_sections(md):
    """Return [(title or None, body)], split on ## / ### headings."""
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
    """Split into pieces <= limit: paragraphs, then lines, then a hard cut."""
    if len(text) <= limit:
        return [text]
    pieces, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        units = [para] if len(para) <= limit else para.split("\n")
        sep = "\n\n"
        for u in units:
            while len(u) > limit:  # huge line: hard cut
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
                e["title"] = f"{title} (suite)"[:TITLE_MAX]  # "continued"
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
    """Group embeds into messages (<= 10 embeds, <= 6000 characters)."""
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
            raise RuntimeError(f"HTTP {err.code}: {body}") from None
        except urllib.error.URLError as err:
            raise RuntimeError(f"network: {err.reason}") from None
    raise RuntimeError("too many rate limits (429)")


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    path = args[0] if args else "data/digest.md"

    try:
        with open(path, encoding="utf-8") as f:
            md = f.read()
    except OSError as err:
        print(f"Discord ERROR: cannot read {path} ({err.strerror}).", file=sys.stderr)
        return 1
    if not md.strip():
        print(f"Discord ERROR: {path} is empty.", file=sys.stderr)
        return 1

    messages = pack(build_embeds(md))

    if dry:
        for i, embeds in enumerate(messages, 1):
            print(f"--- message {i}/{len(messages)} ({len(embeds)} embeds) ---")
            print(json.dumps({"embeds": embeds}, ensure_ascii=False, indent=2))
        return 0

    # One or more webhooks: DISCORD_WEBHOOK_URL, DISCORD_WEBHOOK_URL_2
    targets = []
    for name in WEBHOOK_VARS:
        url = os.environ.get(name, "").strip()
        if not url:
            continue
        if not re.match(r"^https://(?:\w+\.)?discord(?:app)?\.com/api/webhooks/", url):
            print(f"Discord ERROR: {name} is not a Discord webhook URL.", file=sys.stderr)
            return 1
        targets.append((name, url))
    if not targets:
        print("Discord ERROR: DISCORD_WEBHOOK_URL is empty.", file=sys.stderr)
        return 1

    failed = False
    for name, url in targets:
        for i, embeds in enumerate(messages, 1):
            payload = {"username": USERNAME, "embeds": embeds, "allowed_mentions": {"parse": []}}
            try:
                post(url, payload)
            except RuntimeError as err:
                print(f"Discord ERROR ({name}): message {i}/{len(messages)} not sent ({err}).", file=sys.stderr)
                failed = True
                break  # move on to the next webhook
            if i < len(messages):
                time.sleep(1)
        else:
            print(f"Discord ({name}): digest sent ({len(messages)} message(s), "
                  f"{sum(len(m) for m in messages)} embed(s)).")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
