# twitter-monitoring

Digest quotidien des tweets d'une liste de comptes, généré par une routine Claude Code (cloud) via l'API Mindcase.

- `fetch_tweets.py` : tous les appels API (un par compte, filtre 24h obligatoire, garde-fous de coût). Python 3, sans dépendance.
- `PROMPT.md` : les consignes du digest (filtrage, vulgarisation, comptes à suivre, coût du run).
- `post_discord.py` : envoie le digest (`data/digest.md`) sur Discord via un webhook, une section par embed, liens cliquables. `--dry-run` affiche les payloads sans rien envoyer.
- `map_graph.py` + `update_map.sh` : la map des comptes (whitelist + comptes qu'ils relaient). Les données vivent sur la branche `claude/map-data`, mise à jour par la routine après chaque digest. Spec : `docs/map-spec.md`. Tests : `python3 -m unittest discover tests`.

## Variables d'environnement (environnement cloud de la routine)

```
MINDCASE_API_KEY=mk_live_...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_URL_2=https://discord.com/api/webhooks/...   # optionnel : second salon (serveur commun avec Julien)
```

Le digest est envoyé sur chaque webhook défini ; si l'un échoue, l'autre est quand même servi.

## Comptes suivis

La liste est dans `accounts.txt` (un handle par ligne, `#` pour commenter). Chacun peut l'éditer directement sur GitHub ; la routine lit la version de `main` à chaque run. Si le fichier est absent, le script se rabat sur la variable `TWITTER_ACCOUNTS`.

Domaines réseau à autoriser : `api.mindcase.co`, `discord.com`.

## Lancer à la main

```bash
MINDCASE_API_KEY=... python3 fetch_tweets.py
```
