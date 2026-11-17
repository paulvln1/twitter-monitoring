#!/usr/bin/env bash
# Met à jour les données de la map sur la branche claude/map-data (voir docs/map-spec.md).
# Ne touche jamais à main ni à accounts.txt. Utilisé par la routine quotidienne (PROMPT.md).
#
#   ./update_map.sh prepare   récupère la branche, ajoute les interactions du jour, les profils, calcule la map
#   ./update_map.sh publish   recalcule la map (avec les one-liners écrits par Claude), commit et pousse
#
# Les données sont dans map-data/graph/ (un worktree git de la branche claude/map-data).
set -uo pipefail
cd "$(dirname "$0")"

BRANCH="claude/map-data"
WT="map-data"
export GRAPH_DIR="$WT/graph"

log() { echo "[map] $*"; }

prepare() {
  if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
    if git fetch -q origin "$BRANCH" 2>/dev/null; then
      git worktree add -q -B "$BRANCH" "$WT" FETCH_HEAD || { log "ERREUR : worktree impossible"; exit 1; }
      log "branche $BRANCH récupérée"
    else
      # premier run : branche orpheline qui ne contiendra que des données
      git worktree add -q --detach "$WT" || { log "ERREUR : worktree impossible"; exit 1; }
      (cd "$WT" && git checkout -q --orphan "$BRANCH" && git rm -rqf . >/dev/null 2>&1; true)
      printf '# Données de la map\n\nBranche de données uniquement, mise à jour chaque jour par la routine.\nLe code est sur `main` (voir `map_graph.py` et `docs/map-spec.md`).\n' > "$WT/README.md"
      log "branche $BRANCH créée (orpheline)"
    fi
  fi
  mkdir -p "$GRAPH_DIR"

  if [ ! -s "$GRAPH_DIR/interactions.jsonl" ]; then
    python3 map_graph.py seed map_seed/discord_backfill.jsonl
  fi
  if [ -f data/tweets.json ]; then
    python3 map_graph.py extract data/tweets.json
  else
    log "pas de data/tweets.json (fetch échoué ?) : aucune interaction ajoutée aujourd'hui"
  fi
  if [ "${MAP_SKIP_PROFILES:-}" = "1" ]; then
    log "profils ignorés (MAP_SKIP_PROFILES=1)"
  else
    python3 map_graph.py profiles || log "AVERTISSEMENT : profils non récupérés, on réessaiera au prochain run"
  fi
  python3 map_graph.py build || { log "ERREUR : build"; exit 1; }
  log "one-liners à écrire : $GRAPH_DIR/oneliners_todo.json"
}

publish() {
  [ -d "$WT" ] || { log "ERREUR : lance d'abord ./update_map.sh prepare"; exit 1; }
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$GRAPH_DIR/oneliners.json" 2>/dev/null \
    || { [ ! -f "$GRAPH_DIR/oneliners.json" ] || { log "ERREUR : oneliners.json n'est pas du JSON valide"; exit 1; }; }
  python3 map_graph.py build || { log "ERREUR : build"; exit 1; }
  cd "$WT"
  git add -A
  if git diff --cached --quiet; then
    log "rien de nouveau à publier"
    exit 0
  fi
  git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo 'map routine')}" \
      -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo 'map-routine@users.noreply.github.com')}" \
      commit -qm "Map : données du $(date -u +%F)"
  for attempt in 1 2 3 4; do
    if git push -q -u origin "$BRANCH" 2>&1; then
      log "publié sur $BRANCH"
      exit 0
    fi
    # le remote a bougé (rare) : on fusionne sans jamais forcer
    git fetch -q origin "$BRANCH" && { git merge -q --no-edit FETCH_HEAD || git merge --abort; }
    sleep $((attempt * 5))
  done
  log "ERREUR : push impossible après 4 essais"
  exit 1
}

case "${1:-}" in
  prepare) prepare ;;
  publish) publish ;;
  *) echo "usage : $0 prepare|publish"; exit 2 ;;
esac
