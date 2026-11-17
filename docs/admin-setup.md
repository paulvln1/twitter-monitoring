# Mise en place du login et des boutons Add / Remove

Une seule fois, environ 15 minutes. Le site est sur https://twitter-monitoring-site.vercel.app.

Il faut créer deux applications GitHub. Elles ont chacune un rôle limité :

| | Sert à | Accès |
|---|---|---|
| **OAuth App** « signal login » | vérifier que c'est bien toi qui te connectes | aucun accès aux repos |
| **GitHub App** « signal watchlist » | écrire dans `accounts.txt` | `Contents: write` sur ce seul repo |

## 1. OAuth App (le login)

1. Va sur https://github.com/settings/developers, onglet **OAuth Apps**, puis **New OAuth App**.
2. Remplis :
   - Application name : `signal login`
   - Homepage URL : `https://twitter-monitoring-site.vercel.app`
   - Authorization callback URL : `https://twitter-monitoring-site.vercel.app/api/callback`
3. **Register application**.
4. Note le **Client ID**.
5. Clique sur **Generate a new client secret** et copie-le tout de suite : GitHub ne le montre qu'une fois.

## 2. GitHub App (l'écriture dans accounts.txt)

1. Va sur https://github.com/settings/apps, puis **New GitHub App**.
2. Remplis :
   - GitHub App name : `signal-watchlist-paulvln1`. Le nom doit être unique sur GitHub ; ajoute un suffixe s'il est pris.
   - Homepage URL : `https://twitter-monitoring-site.vercel.app`
   - **Webhook** : décoche **Active**.
   - **Permissions → Repository permissions → Contents : Read and write**. Laisse tout le reste sur « No access ». Metadata passe en lecture seule automatiquement, c'est normal.
   - Where can this GitHub App be installed : **Only on this account**.
3. **Create GitHub App**.
4. Note l'**App ID**, affiché en haut de la page.
5. Tout en bas de la page, clique sur **Generate a private key**. Un fichier `.pem` se télécharge.
6. Dans le menu de gauche, **Install App** → **Install** → **Only select repositories** → `twitter-monitoring` → **Install**.

## 3. Variables sur Vercel

Ouvre le projet Vercel, puis **Settings → Environment Variables**. Ajoute ces variables en environnement **Production**, et coche **Sensitive** pour les secrets :

| Nom | Valeur |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | le Client ID de l'étape 1 |
| `GITHUB_OAUTH_CLIENT_SECRET` | le client secret de l'étape 1 (sensitive) |
| `GH_APP_ID` | l'App ID de l'étape 2 |
| `GH_APP_PRIVATE_KEY` | tout le contenu du fichier `.pem`, de `-----BEGIN` à `-----END-----` inclus (sensitive) |
| `SESSION_SECRET` | une longue chaîne aléatoire (sensitive). Sur Mac, dans le Terminal : `openssl rand -hex 32` |
| `ADMIN_GITHUB_LOGINS` | `paulvln1` (pour ajouter Julien plus tard : `paulvln1,sonlogin`) |
| `SITE_ORIGIN` | `https://twitter-monitoring-site.vercel.app` |

Ensuite :
1. **Deployments** → menu `…` du dernier déploiement → **Redeploy**. Les variables ne s'appliquent qu'aux nouveaux déploiements.
2. **Supprime le fichier `.pem`** de ton dossier Téléchargements : il est maintenant stocké sur Vercel.

## 4. Vérifier

1. Ouvre le site et clique sur **Log in** en haut. GitHub te demande d'autoriser « signal login », sans aucune permission.
2. De retour sur le site, tu dois voir `@paulvln1 · Log out`.
3. Clique sur une découverte : le panneau affiche **+ Add to watchlist**.
4. Clique sur une source : le panneau affiche **Remove from watchlist**, puis une demande de confirmation.

Chaque action crée un commit sur `accounts.txt`, sur `main`. Le compte apparaît comme « pending » jusqu'au prochain run de la routine.

## En cas de souci

- **« Access denied »** : ton login n'est pas dans `ADMIN_GITHUB_LOGINS`.
- **« Login failed »** : vérifie la callback URL de l'OAuth App et les deux variables `GITHUB_OAUTH_*`.
- **« Could not save: GitHub is not reachable right now »** : la GitHub App n'est pas installée sur le repo, ou `GH_APP_ID` / `GH_APP_PRIVATE_KEY` est faux. Les logs Vercel (Functions) donnent le détail.
- **Clé compromise** : sur la page de la GitHub App, supprime la private key et génère-en une nouvelle. Pour couper toutes les sessions ouvertes, change `SESSION_SECRET`.
