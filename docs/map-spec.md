# Spec — Map des comptes

Statut : **spec validée, prête à coder** (rien n'est codé).

## Objectif

Un site public qui affiche une map des comptes de la whitelist (`accounts.txt`) et des comptes qu'ils relaient. Elle sert à repérer de nouveaux comptes intéressants et à les faire passer dans la watchlist directement depuis le site.

## 1. Données collectées (run quotidien)

Le run quotidien existant (`fetch_tweets.py`) récupère déjà les tweets écrits par chaque compte de la whitelist. On en extrait les **interactions** :

| Type   | Source dans les données Mindcase                             |
|--------|--------------------------------------------------------------|
| RT     | `retweetedTweetUrl` → handle dans `x.com/<handle>/status/…`   |
| Quote  | `quotedTweetUrl`                                             |
| Reply  | champ « en réponse à » (**à vérifier dans la réponse brute**) |

Les mentions simples ne comptent pas.

Chaque interaction est ajoutée à `graph/interactions.jsonl`, **versionné dans git sur la branche `claude/map-data`** (voir section 1 bis) :

```json
{"date": "2026-11-17", "from": "wl_handle", "to": "target_handle", "type": "rt|quote|reply", "target_tweet_url": "…", "source_tweet_url": "…"}
```

Règles :
- Les handles sont normalisés en minuscules, sans `@`.
- Pas de doublons : une interaction est identifiée par `(from, type, source_tweet_url)`. Relancer un run ne compte rien deux fois.
- `target_tweet_url` (le tweet du compte relayé) est indispensable : c'est lui qui permet de compter les **tweets différents** (section 2).
- On ignore les interactions d'un compte avec lui-même (reply dans son propre thread, auto-RT).
- On garde tout l'historique dans le fichier. La fenêtre de 30 jours ne s'applique qu'à l'affichage.

## 1 ter. Le moteur : `map_graph.py`

| Commande | Rôle |
|---|---|
| `extract [data/tweets.json]` | Lit les tweets du cron et ajoute les interactions à `interactions.jsonl`, sans doublon. |
| `seed FICHIER.jsonl` | Importe une amorce (digests Discord). |
| `profiles` | Récupère via Mindcase, en un seul appel, les profils manquants (whitelist + candidats de la map). |
| `build` | Calcule `graph.json` (lu par le site) et `oneliners_todo.json` (les one-liners que Claude doit écrire). |

- Données dans `$GRAPH_DIR` (défaut `graph/`).
- Ordre d'un run : `extract` → `profiles` → `build` → Claude écrit `oneliners.json` → `build`.
- Tests : `python3 -m unittest discover tests`.
- Champs Mindcase utilisés (vérifiés le 17/11/2026) : `retweetedTweetUrl`/`retweetedTweetText`, `quotedTweetUrl`/`quotedTweetText`, `isReply`/`replyToHandle`/`replyToTweetUrl` (au format `x.com/i/status/<id>` : le handle vient de `replyToHandle`). Un même tweet peut être à la fois un quote et une reply, ce qui donne 2 interactions.

## 1 bis. Où vivent les données : la branche `claude/map-data`

- La routine **n'a pas le droit de pousser sur `main`** : une routine Claude ne peut pousser que sur des branches `claude/…`. **C'est voulu** : la routine lit chaque jour du contenu externe (tweets, pages web) et ne doit pas pouvoir modifier le code.
- Toutes les données de la map vivent donc dans le dossier `graph/` d'une **branche dédiée `claude/map-data`**, qui ne contient que des données : `interactions.jsonl`, `profiles.json`, `oneliners.json`, `graph.json`.
- **Chaque jour**, la routine :
  1. lit `accounts.txt` depuis `main` ;
  2. récupère `claude/map-data` (et la crée comme branche orpheline si elle n'existe pas) ;
  3. ajoute les données du jour, recalcule `graph.json`, commit et pousse ;
  4. si le push échoue, réessaie après un `fetch` et un merge, sans jamais faire de force-push.
- La routine ne touche **jamais** à `main` ni à `accounts.txt`.

## 2. Règles de la map (recalculées chaque jour)

`map_graph.py build` lit `accounts.txt` (version du jour) et `interactions.jsonl`, puis produit `graph/graph.json`.

- **Nœuds whitelist** : tous les comptes présents dans `accounts.txt` aujourd'hui.
- **Nœuds candidats** : un compte hors whitelist entre sur la map si, sur les **30 derniers jours** (fenêtre glissante), en ne comptant que les interactions venant de la whitelist **actuelle** :
  - au moins **2 tweets différents** de ce compte ont reçu une interaction (RT, quote ou reply) ;
  - **et** au moins **2 comptes différents** de la whitelist ont interagi avec lui.
- **Pourquoi** : on récompense les comptes qui postent régulièrement du contenu de valeur, pas un seul tweet viral. Un tweet relayé par 5 comptes de la whitelist compte pour **1 tweet**, et un seul « fan » dans la whitelist ne suffit pas à faire apparaître un compte.
- **Exemples** :
  - @trq212 : 1 tweet relayé par 3 comptes → **n'apparaît pas**.
  - @vitalflux : 4 tweets, mais relayés uniquement par @hwchase17 → **n'apparaît pas**.
  - @Steve_Yegge : 3 tweets relayés par dexhorthy, swyx et GeoffreyHuntley → **apparaît**.
- **Seuils réglables** : `MIN_TWEETS=2`, `MIN_WL_ACCOUNTS=2`, `WINDOW_DAYS=30`, définis en constantes en haut du script.
- **Taille d'une bulle candidat** : nombre de tweets différents relayés sur 30 j.
- **Liens** : uniquement whitelist → candidat. Pas de liens whitelist ↔ whitelist. L'épaisseur dépend du nombre d'interactions.
- **Gros comptes** (@OpenAI, @sama…) : aucun filtre, ils apparaissent comme les autres.
- **Retrait de `accounts.txt`** : le compte redevient candidat. Ses liens sortants disparaissent, et il reste affiché s'il remplit encore les conditions ci-dessus, sinon il disparaît.
- **Ajout à `accounts.txt`** : le compte devient un nœud whitelist dès le run suivant. Il **perd ses liens entrants** (pas de liens whitelist ↔ whitelist) et devient une entité à part, qui se reconnectera quand il relaiera lui-même des candidats. Ses interactions sont collectées à partir de là.
- **Candidat qui n'est plus relayé** : il sort de la map dès qu'il ne remplit plus les conditions sur 30 j.
- **Changement de handle, compte suspendu ou privé** : non géré, on suit les comptes par handle (un nouveau handle = un nouveau nœud).

## 3. Profils

- Champs gardés : `displayName`, `bio`, `followers`, `profilePicture` (photo de profil, affichée dans la bulle) et `profileUrl`.
- Appel à l'agent Mindcase `twitter/profiles`, avec la même clé `MINDCASE_API_KEY` :
  ```
  POST https://api.mindcase.co/v1/data/twitter/profiles/run?wait=true
  {"params": {"inputs": ["simonw", "steipete"]}}
  ```
  Les handles sont passés sans `@`, et un seul appel peut en contenir plusieurs. La réponse est dans `data[]`, une ligne par compte, avec `username` pour la correspondance.
- **Coût mesuré : 0,0005 $ par profil**, à partir de `usd_charged` (test du 17/11/2026 sur @simonw).
- **Quand on appelle l'API** :
  - quand un candidat entre sur la map pour la première fois ;
  - pour chaque compte de la whitelist qui n'a pas encore de profil : les ~22 comptes actuels au premier run (≈ 0,01 $), puis chaque nouvel ajout.
  - Tous les comptes concernés d'un même run passent dans **un seul appel**.
- Les résultats sont stockés dans `graph/profiles.json` et **jamais rafraîchis** : le nombre de followers affiché est donc celui du jour de la récupération.
- Photo : l'URL `pbs.twimg.com` peut casser si le compte change de photo. Dans ce cas, le site affiche les initiales sur un rond de couleur.
- Si un profil n'est pas renvoyé (compte suspendu, faute de frappe), le nœud s'affiche avec le handle seul, et on réessaie au run suivant, une seule fois.
- Le coût des profils est ajouté à la section « Coût du run » du digest.

## 3 bis. One-liner de contexte (en anglais)

- **Un one-liner par candidat**, qui résume le **dernier tweet relayé**, celui de l'embed du panneau. Par ex. : *"Tip on Fable 5.2's prompting guide ("This codebase is yours"), RT by @steipete."*
- **Écrit par Claude à la fin du cron**, après l'envoi Discord : il ne réécrit que les candidats dont le dernier tweet relayé a changé ce jour-là.
- Stocké dans `graph/oneliners.json` : `{handle: {text, tweet_url, date}}`.
- Tout le contenu du site est **en anglais**. Le digest Discord reste en français.

## 4. Site

- **Hébergement** : Vercel, déployé depuis `main`, qui ne contient que le code du site.
- **Données** : au chargement, le site lit `graph.json` directement depuis la branche `claude/map-data` (`raw.githubusercontent.com`, le repo étant public). Le run quotidien met donc la map à jour **sans redéploiement**. Le cache de GitHub peut retarder la mise à jour de quelques minutes.
- **Bulles** : photo de profil ronde, avec une bordure dont la couleur distingue whitelist et candidats.
- **Map publique, en anglais** : graphe interactif (force-directed). Les nœuds whitelist et candidats ont deux couleurs différentes, et la taille d'un candidat dépend du nombre de tweets différents relayés.
- **Clic sur une bulle → panneau latéral** avec :
  - display name, @handle, bio, nombre de followers ;
  - le **one-liner** de contexte ;
  - les comptes de la whitelist qui l'ont relayé, avec le type d'interaction ;
  - un **embed officiel X** du tweet relayé **le plus récent** ;
  - un bouton **« Ouvrir sur X »** (`x.com/<handle>`).
- Le panneau fonctionne aussi sur mobile.

### DA (validée le 17/11/2026)

- Nom : **signal**, sous-titre « who's worth following in AI. », en minuscules et en très grand, dans l'esprit de la référence « unlock the Unexpected » de Paul.
- Couleurs : crème `#EEECE7`, encre `#1A1A18`, bleu `#2B3BD0` (liens, comptes découverts, surbrillance), traits fins `#CBC8C0`.
- Police : Inter Tight (300/400/500). Très épuré : traits fins, petites capitales, flèches ↘.
- Photos de profil en noir et blanc, en couleur au survol ou à la sélection. Si une photo ne charge pas, la bulle affiche les initiales.
- Sections :
  - hero ;
  - intro ;
  - nav ↘ (The Map / Discovered / Sources) ;
  - **Map** avec recherche @handle et panneau au clic ;
  - **Discovered**, une liste façon « News » avec un badge « new » pour les comptes entrés sur la map depuis moins de 7 jours (champ `since`) ;
  - **Sources** ;
  - footer façon adresse (↘ GitHub, ↘ graph.json).
- Clic sur une **source** (compte de la whitelist) : profil + ses découvertes, avec ses liens en bleu sur la map.
- Lien direct vers un compte : `/#simonw`.

## 5. Gestion de la watchlist depuis le site

- Connexion **« Login with GitHub »** (GitHub OAuth App) via une fonction serveur Vercel.
- Un seul utilisateur autorisé pour l'instant : variable `ADMIN_GITHUB_LOGINS=paulvln1` (pour ajouter Julien plus tard, il suffira de l'ajouter à cette variable).
- Une fois connecté, le panneau affiche **« Ajouter à la watchlist »** sur un candidat ou **« Retirer »** sur un compte de la whitelist.
- Le serveur commit directement dans `accounts.txt` sur `main` via l'API GitHub, avec un token stocké côté Vercel et jamais exposé au navigateur. Le message de commit indique l'action et le compte.
- Le changement apparaît sur la map **au run suivant**. En attendant, le nœud porte un badge « en attente » : le site compare `accounts.txt` sur `main` avec la whitelist de `graph.json`.
- Conflits : le commit utilise le `sha` du fichier. Si le fichier a changé entre-temps, le serveur relit et réessaie.

### Sécurité

- **Aucun token personnel de Paul n'est stocké.**
- **Login GitHub = vérification d'identité uniquement.** On demande le scope minimal (aucun accès aux repos). Le token OAuth sert à lire le login, puis il est jeté. Le navigateur reçoit un cookie de session signé (`HttpOnly`, `Secure`, `SameSite=Strict`, durée limitée), avec une clé de signature stockée côté Vercel.
- **Écriture via une GitHub App dédiée**, installée sur ce seul repo, avec une seule permission : `Contents: write`. Sa clé privée est stockée dans les variables d'environnement chiffrées de Vercel, n'est jamais envoyée au navigateur et peut être renouvelée à tout moment.
- **Le serveur ne modifie que `accounts.txt`** : le chemin du fichier est écrit en dur dans le code.
- **Validation des handles** : `^[A-Za-z0-9_]{1,15}$`. Tout le reste est refusé, ce qui empêche d'injecter des lignes ou du texte arbitraire.
- **Protection CSRF** : les routes d'écriture n'acceptent que des requêtes `POST` venant du domaine du site (en-tête `Origin` vérifié).
- **Liste des admins** côté serveur (`ADMIN_GITHUB_LOGINS`) : on vérifie le login à chaque requête d'écriture, pas seulement à la connexion.
- **Vercel** : connexion GitHub en « Only select repositories ». 2FA activée sur Vercel et GitHub.
- **Risque résiduel accepté** : code et watchlist sont dans le même repo. Si la clé de la GitHub App fuitait, un attaquant pourrait modifier le code exécuté par la routine, qui dispose de `MINDCASE_API_KEY` et des webhooks Discord. Pour réduire ce risque, il faudrait mettre `accounts.txt` dans un repo séparé, option écartée pour l'instant par souci de simplicité.

## 6. Démarrage

- On amorce la map avec les 11 digests Discord collés par Paul dans le chat le 17/11/2026 (`map_seed/discord_backfill.jsonl`, importé avec `map_graph.py seed`), de la façon suivante :
  - on suppose un digest par jour, dans l'ordre, du 06/11 au 16/11 ;
  - les interactions sont marquées `"source": "discord_backfill"` ;
  - « 2 RT de X » = 2 tweets différents ;
  - les mentions sont ignorées ;
  - les interactions venant de comptes qui ne sont plus dans la whitelist (jerryjliu0) ne comptent pas.
- Limites : les digests ne donnent pas les URLs des tweets. Le décompte est donc approximatif, ces interactions n'ont pas d'embed, et leur one-liner vient du texte du digest, déjà traduit dans le fichier (Claude n'a rien à écrire pour elles).
- Cette amorce sort de la fenêtre de 30 jours d'elle-même, vers mi-décembre.

## 7. Points à vérifier avant de coder

- [x] Format et coût de l'agent `twitter/profiles` (voir section 3).
- [x] Push de la routine : pas d'accès à `main`. Elle pousse sur `claude/map-data` (section 1 bis).
- [x] Historique git vérifié le 17/11/2026 (25 commits, toutes branches) : aucun secret, seulement les exemples du README (`mk_live_...`).
- [x] Les replies Mindcase indiquent le tweet parent (confirmé par Paul).
