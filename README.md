# twitter-monitoring

Digest quotidien des tweets d'une liste de comptes, généré par une routine Claude Code (cloud) via l'API Mindcase.

- `fetch_tweets.py` : tous les appels API (un par compte, filtre 24h obligatoire, garde-fous de coût). Python 3, sans dépendance.
- `PROMPT.md` : les consignes du digest (filtrage, vulgarisation, comptes à suivre, coût du run).
- `post_discord.py` : envoie le digest (`data/digest.md`) sur Discord via un webhook, une section par embed, liens cliquables. `--dry-run` affiche les payloads sans rien envoyer.

## Variables d'environnement (environnement cloud de la routine)

```
MINDCASE_API_KEY=mk_live_...
TWITTER_ACCOUNTS=handle1,handle2,handle3
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_URL_2=https://discord.com/api/webhooks/...   # optionnel : second salon
```

Le digest est envoyé sur chaque webhook défini ; si l'un échoue, l'autre est quand même servi.

La liste des comptes n'est volontairement **pas** dans le repo : elle vit uniquement dans `TWITTER_ACCOUNTS`.
Domaines réseau à autoriser : `api.mindcase.co`, `discord.com`.

## Lancer à la main

```bash
MINDCASE_API_KEY=... TWITTER_ACCOUNTS=handle1,handle2 python3 fetch_tweets.py
```
