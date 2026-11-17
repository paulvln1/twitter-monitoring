# Spec — Map des comptes

Statut : **brouillon, en discussion** (rien n'est codé).

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

Chaque interaction est ajoutée à `graph/interactions.jsonl`, **versionné dans git** :

```json
{"date": "2026-11-17", "from": "wl_handle", "to": "target_handle", "type": "rt|quote|reply", "target_tweet_url": "…", "source_tweet_url": "…"}
```

Règles :
- Les handles sont normalisés en minuscules, sans `@`.
- Pas de doublons : une interaction est identifiée par `(from, type, source_tweet_url)`. Relancer un run ne compte rien deux fois.
- On ignore les interactions d'un compte avec lui-même (reply dans son propre thread, auto-RT).
- On garde tout l'historique dans le fichier. La fenêtre de 30 jours ne s'applique qu'à l'affichage.

## 2. Règles de la map (recalculées chaque jour)

`build_graph.py` lit `accounts.txt` (version du jour) et `interactions.jsonl`, puis produit `graph/graph.json`.

- **Nœuds whitelist** : tous les comptes présents dans `accounts.txt` aujourd'hui.
- **Nœuds candidats** : tout compte hors whitelist relayé par **≥ 3 comptes différents** de la whitelist **actuelle** sur les **30 derniers jours** (fenêtre glissante). 10 RT par la même personne comptent pour 1.
- **Liens** : uniquement whitelist → candidat. Pas de liens whitelist ↔ whitelist. L'épaisseur dépend du nombre d'interactions.
- **Gros comptes** (@OpenAI, @sama…) : aucun filtre, ils apparaissent comme les autres.
- **Retrait de `accounts.txt`** : le compte redevient candidat. Ses liens sortants disparaissent, il reste affiché s'il est encore relayé par ≥ 3 comptes de la whitelist sur 30 j, sinon il disparaît.
- **Ajout à `accounts.txt`** : le compte devient un nœud whitelist dès le run suivant, et ses propres interactions sont collectées à partir de là (voir la question ouverte A).
- **Candidat qui n'est plus relayé** : il sort de la map quand il passe sous 3 comptes différents sur 30 j.
- **Changement de handle, compte suspendu ou privé** : non géré, on suit les comptes par handle (un nouveau handle = un nouveau nœud).

## 3. Profils

- Champs récupérés : **display name**, **bio**, **nombre de followers**. Pas d'avatar.
- On fait un appel à l'agent Mindcase `twitter/profiles` (même clé `MINDCASE_API_KEY` ; console : `console.mindcase.co/agents/twitter/profiles`) **uniquement quand un compte entre sur la map pour la première fois**. Le résultat est stocké dans `graph/profiles.json`.
- Endpoint probable, par analogie avec celui des tweets : `api.mindcase.co/v1/data/twitter/profiles/run?wait=true` (format des paramètres et coût à vérifier).
- Le profil n'est jamais rafraîchi : le nombre de followers affiché est donc celui du jour d'entrée sur la map.
- Les comptes de la whitelist ont aussi besoin d'une bio (voir la question ouverte B).

## 4. Site

- **Hébergement** : Vercel, déployé automatiquement à chaque push sur `main`. Le commit quotidien de `graph/` rafraîchit donc la map.
- **Map publique** : graphe interactif (force-directed). Les nœuds whitelist et candidats ont deux couleurs différentes, et la taille d'un candidat dépend du nombre de comptes de la whitelist qui l'ont relayé.
- **Clic sur une bulle → panneau latéral** avec :
  - display name, @handle, bio, nombre de followers ;
  - les comptes de la whitelist qui l'ont relayé, avec le type d'interaction ;
  - un **embed officiel X** du tweet relayé **le plus récent** ;
  - un bouton **« Ouvrir sur X »** (`x.com/<handle>`).
- Le panneau fonctionne aussi sur mobile.

## 5. Gestion de la watchlist depuis le site

- Connexion **« Login with GitHub »** (GitHub OAuth App) via une fonction serveur Vercel.
- Un seul utilisateur autorisé pour l'instant : variable `ADMIN_GITHUB_LOGINS=paulvln1` (pour ajouter Julien plus tard, il suffira de l'ajouter à cette variable).
- Une fois connecté, le panneau affiche **« Ajouter à la watchlist »** sur un candidat ou **« Retirer »** sur un compte de la whitelist.
- Le serveur commit directement dans `accounts.txt` sur `main` via l'API GitHub, avec un token stocké côté Vercel et jamais exposé au navigateur. Le message de commit indique l'action et le compte.
- Le changement apparaît sur la map **au run suivant**. En attendant, le nœud porte un badge « en attente ».
- Conflits : le commit utilise le `sha` du fichier. Si le fichier a changé entre-temps, le serveur relit et réessaie.

## 6. Démarrage

- On amorce la map avec les ~8-9 digests Discord passés, que Paul collera dans le chat. Limite connue : ces digests ne contiennent que les 5-6 comptes « à suivre » de chaque jour, donc l'amorce est partielle. Elle sort de la fenêtre de 30 jours d'elle-même.

## 7. Points à vérifier avant de coder

- [ ] Le champ « reply » dans la réponse Mindcase : y a-t-il le handle ou l'URL du tweet parent ?
- [ ] Format des paramètres et coût de l’agent Mindcase `twitter/profiles`.
- [ ] La routine cloud a-t-elle le droit de push sur `main` pour commiter `graph/` ?
- [ ] Le repo passe en public : vérifier l'historique git (aucun secret).

## Questions ouvertes

- **A.** Comme il n'y a pas de liens whitelist ↔ whitelist, un compte promu depuis la map perd ses liens entrants et se retrouve isolé jusqu'à ce qu'il relaie lui-même des candidats.
- **B.** Bio des comptes de la whitelist : on la récupère une fois, quand le compte est ajouté ?
