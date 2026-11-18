#!/usr/bin/env bash
# Updates the map data on the claude/map-data branch (see docs/map-spec.md).
# Never touches main or watchlist.txt. Used by the daily routine (ROUTINE.md).
#
#   pipeline/update_map.sh prepare   fetch the branch, add today's interactions and profiles, compute the map
#   pipeline/update_map.sh publish   recompute the map (with the one-liners Claude wrote), commit and push
#
# The data lives in map-data/graph/ (a git worktree of the claude/map-data branch), at the repository root.
set -uo pipefail
cd "$(dirname "$0")/.."

BRANCH="claude/map-data"
WT="map-data"
export GRAPH_DIR="$WT/graph"

log() { echo "[map] $*"; }

prepare() {
  if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
    if git fetch -q origin "$BRANCH" 2>/dev/null; then
      git worktree add -q -B "$BRANCH" "$WT" FETCH_HEAD || { log "ERROR: could not create the worktree"; exit 1; }
      log "branch $BRANCH fetched"
    else
      # first run: an orphan branch that only ever holds data
      git worktree add -q --detach "$WT" || { log "ERROR: could not create the worktree"; exit 1; }
      (cd "$WT" && git checkout -q --orphan "$BRANCH" && git rm -rqf . >/dev/null 2>&1; true)
      printf '# Map data\n\nData-only branch, updated every day by the routine.\nThe code is on `main` (see `pipeline/map_graph.py` and `docs/map-spec.md`).\n' > "$WT/README.md"
      log "branch $BRANCH created (orphan)"
    fi
  fi
  mkdir -p "$GRAPH_DIR"

  if [ ! -s "$GRAPH_DIR/interactions.jsonl" ]; then
    python3 pipeline/map_graph.py seed map_seed/discord_backfill.jsonl
  fi
  if [ -f data/tweets.json ]; then
    python3 pipeline/map_graph.py extract data/tweets.json
  else
    log "no data/tweets.json (did the fetch fail?): no interactions added today"
  fi
  if [ "${MAP_SKIP_PROFILES:-}" = "1" ]; then
    log "profiles skipped (MAP_SKIP_PROFILES=1)"
  else
    python3 pipeline/map_graph.py profiles || log "WARNING: profiles not fetched, will retry at the next run"
  fi
  python3 pipeline/map_graph.py build || { log "ERROR: build failed"; exit 1; }
  log "one-liners to write: $GRAPH_DIR/oneliners_todo.json"
}

publish() {
  [ -d "$WT" ] || { log "ERROR: run pipeline/update_map.sh prepare first"; exit 1; }
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$GRAPH_DIR/oneliners.json" 2>/dev/null \
    || { [ ! -f "$GRAPH_DIR/oneliners.json" ] || { log "ERROR: oneliners.json is not valid JSON"; exit 1; }; }
  python3 pipeline/map_graph.py build || { log "ERROR: build failed"; exit 1; }
  cd "$WT"
  git add -A
  if git diff --cached --quiet; then
    log "nothing new to publish"
    exit 0
  fi
  git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo 'map routine')}" \
      -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo 'map-routine@users.noreply.github.com')}" \
      commit -qm "Map data for $(date -u +%F)"
  for attempt in 1 2 3 4; do
    if git push -q -u origin "$BRANCH" 2>&1; then
      log "published to $BRANCH"
      exit 0
    fi
    # the remote moved (rare): merge, never force
    git fetch -q origin "$BRANCH" && { git merge -q --no-edit FETCH_HEAD || git merge --abort; }
    sleep $((attempt * 5))
  done
  log "ERROR: push failed after 4 attempts"
  exit 1
}

case "${1:-}" in
  prepare) prepare ;;
  publish) publish ;;
  *) echo "usage: $0 prepare|publish"; exit 2 ;;
esac
