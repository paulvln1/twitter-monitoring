# Setting up login and the Add / Remove buttons

A one-time setup, about 15 minutes. The site runs on https://twitter-monitoring-site.vercel.app, from the `web/` folder (Vercel: **Settings → Build and Deployment → Root Directory** = `web`).

You need two GitHub applications, each with a narrow role:

| | Used to | Access |
|---|---|---|
| **OAuth App** "signal login" | check that it really is you signing in | no access to any repo |
| **GitHub App** "signal watchlist" | write to `watchlist.txt` | `Contents: write` on this repo only |

## 1. OAuth App (login)

1. Go to https://github.com/settings/developers, **OAuth Apps** tab, then **New OAuth App**.
2. Fill in:
   - Application name: `signal login`
   - Homepage URL: `https://twitter-monitoring-site.vercel.app`
   - Authorization callback URL: `https://twitter-monitoring-site.vercel.app/api/callback`
3. **Register application**.
4. Copy the **Client ID**.
5. Click **Generate a new client secret** and copy it right away: GitHub only shows it once.

## 2. GitHub App (writes to watchlist.txt)

1. Go to https://github.com/settings/apps, then **New GitHub App**.
2. Fill in:
   - GitHub App name: `signal-watchlist-<your-login>`. The name must be unique on GitHub; add a suffix if it is taken.
   - Homepage URL: `https://twitter-monitoring-site.vercel.app`
   - **Webhook**: uncheck **Active**.
   - **Permissions → Repository permissions → Contents: Read and write**. Leave everything else on "No access". Metadata switches to read-only on its own, that is expected.
   - Where can this GitHub App be installed: **Only on this account**.
3. **Create GitHub App**.
4. Copy the **App ID** shown at the top of the page.
5. At the bottom of the page, click **Generate a private key**. A `.pem` file downloads.
6. In the left menu, **Install App** → **Install** → **Only select repositories** → this repository → **Install**.

## 3. Vercel environment variables

Open the Vercel project, then **Settings → Environment Variables**. Add these to the **Production** environment, and tick **Sensitive** for the secrets:

| Name | Value |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | the Client ID from step 1 |
| `GITHUB_OAUTH_CLIENT_SECRET` | the client secret from step 1 (sensitive) |
| `GH_APP_ID` | the App ID from step 2 |
| `GH_APP_PRIVATE_KEY` | the whole `.pem` file, from `-----BEGIN` to `-----END-----` included (sensitive) |
| `SESSION_SECRET` | a long random string (sensitive). On a Mac, in Terminal: `openssl rand -hex 32` |
| `ADMIN_GITHUB_LOGINS` | your GitHub login; several logins are comma-separated |
| `SITE_ORIGIN` | `https://twitter-monitoring-site.vercel.app` |

Then:
1. **Deployments** → `…` menu of the latest deployment → **Redeploy**. Variables only apply to new deployments.
2. **Delete the `.pem` file** from your Downloads folder: it now lives on Vercel.

## 4. Check

1. Open the site and click **Log in** at the top. GitHub asks you to authorize "signal login", with no permissions.
2. Back on the site, you should see `@<your-login> · Log out`, and a **+ Add an account** button under the top bar.
3. Click a discovered account: the panel shows **+ Add to watchlist**.
4. Click a source: the panel shows **Remove from watchlist**, then asks for confirmation.

Each action creates a commit on `watchlist.txt`, on `main`. The account sits in the **Backlog** box until the next routine run.

## Troubleshooting

- **"Access denied"**: your login is not in `ADMIN_GITHUB_LOGINS`.
- **"Login failed"**: check the OAuth App's callback URL and both `GITHUB_OAUTH_*` variables.
- **"Could not save: GitHub is not reachable right now"**: the GitHub App is not installed on the repo, or `GH_APP_ID` / `GH_APP_PRIVATE_KEY` is wrong. The Vercel logs (Functions) have the details.
- **Leaked key**: on the GitHub App's page, delete the private key and generate a new one. To end every open session, change `SESSION_SECRET`.
