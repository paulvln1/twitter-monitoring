# twitter-monitoring

Digest quotidien des tweets d'une liste de comptes, généré par une routine Claude Code (cloud) via l'API Mindcase.

- `fetch_tweets.py` : tous les appels API (un par compte, filtre 24h obligatoire, garde-fous de coût). Python 3, sans dépendance.
- `PROMPT.md` : les consignes du digest (filtrage, vulgarisation, comptes à suivre, coût du run).

## Variables d'environnement (environnement cloud de la routine)

```
MINDCASE_API_KEY=mk_live_...
TWITTER_ACCOUNTS=handle1,handle2,handle3
```

La liste des comptes n'est volontairement **pas** dans le repo : elle vit uniquement dans `TWITTER_ACCOUNTS`.
Domaine réseau à autoriser : `api.mindcase.co`.

## Lancer à la main

```bash
MINDCASE_API_KEY=... TWITTER_ACCOUNTS=handle1,handle2 python3 fetch_tweets.py
```
