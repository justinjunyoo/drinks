# 🍻 Drink Counter

A shared, live drink counter for you and your friends. Global count, per-user
leaderboard, a race to 1,000 drinks with milestone hype, and a time-series chart
of when drinks were logged — all synced across devices via **Cloud Run +
Firestore**.

- **Shared state** — everyone in the same *room* sees the same numbers, updated every ~2 seconds.
- **Room code = shared secret** — friends join with a code; strangers who find the URL can't see or touch your room without it.
- **Atomic counts** — drinks are incremented inside Firestore transactions, so simultaneous taps never clobber each other.
- **Free at this scale** — Cloud Run scales to zero and Firestore's free tier easily covers a weekend.

---

## Deploy it (one time, ~5 minutes)

You need the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) installed
and a GCP project with **billing enabled** (still free at this usage).

```bash
# 1. Point gcloud at your project
gcloud config set project YOUR_PROJECT_ID

# 2. Enable the APIs we use
gcloud services enable run.googleapis.com firestore.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com

# 3. Create the Firestore database (Native mode). Pick a location near you:
#    nam5 = US multi-region, eur3 = Europe, or a single region like us-central1
gcloud firestore databases create --location=nam5

# 4. Deploy the app (run this from THIS folder)
gcloud run deploy drink-counter \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

When the deploy finishes it prints a **Service URL** like
`https://drink-counter-xxxxxxxx-uc.a.run.app`. That's your app.

### 5. Give Cloud Run permission to use Firestore

The service runs as your project's default compute service account. Grant it
Firestore access (once):

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.user"
```

> If a newer project uses a dedicated Cloud Run service account instead, grant
> `roles/datastore.user` to that account. If drinks fail to save, this is almost
> always the cause — check the Cloud Run logs.

---

## Auto-deploy from GitHub (CI/CD)

Instead of running `gcloud` by hand, you can have **GitHub Actions** deploy every
push to `main`. Authentication uses **Workload Identity Federation** — GitHub
proves its identity to GCP over OIDC, so there is **no service-account key** to
store or rotate.

**One-time setup** (run locally or in Cloud Shell, from an account with
Owner/Editor on the project):

```bash
PROJECT_ID=your-project-id ./scripts/setup-wif.sh
```

The script enables the APIs, creates a least-privilege deployer service account,
sets up the Workload Identity Pool/provider **restricted to this repo**, and
prints the exact values to add under
**GitHub → repo Settings → Secrets and variables → Actions**:

| Kind     | Name                | Value |
|----------|---------------------|-------|
| Secret   | `GCP_WIF_PROVIDER`  | `projects/…/workloadIdentityPools/…/providers/…` |
| Secret   | `GCP_DEPLOY_SA`     | `github-deployer@PROJECT_ID.iam.gserviceaccount.com` |
| Variable | `GCP_PROJECT_ID`    | your project id |
| Variable | `GCP_REGION`        | e.g. `us-central1` |
| Variable | `CLOUD_RUN_SERVICE` | e.g. `drink-counter` |

Once those are set, pushing to `main` (or running **Deploy to Cloud Run** from
the **Actions** tab) builds from source and deploys. The workflow lives at
`.github/workflows/deploy.yml`.

---

## Use it this weekend

1. Open your Service URL.
2. Type a **room code** — pick something only your group knows, e.g. `mikes-bday-2026`. (3–40 letters, numbers, `-` or `_`.)
3. Hit **Copy invite link** and send it to your friends. It looks like:
   `https://your-service-url/#room=mikes-bday-2026`
4. Everyone who opens that link is in the same room, counting toward the same global total.

Anyone in the room can add drinkers, tap **+ Drink**, and watch the leaderboard
and progress bar move live.

---

## Options (optional env vars)

Set these on deploy with `--set-env-vars KEY=value`:

| Variable     | Default | What it does |
|--------------|---------|--------------|
| `DRINK_GOAL` | `1000`  | The target the progress bar counts toward. |
| `CREATE_KEY` | *(none)* | If set, creating a **brand-new** room requires this key (typed into the extra field on the join screen). Existing rooms stay open to anyone with the code. Use it to stop strangers from spawning rooms on your service. |

Example:

```bash
gcloud run deploy drink-counter --source . --region us-central1 \
  --allow-unauthenticated --set-env-vars DRINK_GOAL=500,CREATE_KEY=letmein
```

To change these later, just re-run the deploy command with the new values.

---

## Run it locally (optional)

Requires Node 18+, plus the Firestore emulator
(`gcloud components install cloud-firestore-emulator`).

```bash
npm install

# Terminal 1 — emulator
gcloud emulators firestore start --host-port=127.0.0.1:8085

# Terminal 2 — app pointed at the emulator
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 \
GOOGLE_CLOUD_PROJECT=demo-drinkcounter \
PORT=8080 npm start
```

Open http://localhost:8080. (Emulator data is in-memory and resets when it stops.)

---

## Security: no keys reach the browser

This app is designed so your Google account is **never** exposed to visitors:

- **No credentials in the frontend.** `public/index.html` contains zero API keys, tokens, or Firebase config. The browser only ever talks to this app's own `/api/*` endpoints — it never talks to Google/Firestore directly, so there's nothing to leak.
- **Server-side auth only.** On Cloud Run, the server authenticates to Firestore using the service account's short-lived tokens fetched from the GCP metadata server. Those tokens live in the container's memory and are used server-side only — they are never serialized into any API response or HTML.
- **No key files anywhere.** There is no service-account JSON in the repo or the container image. The Dockerfile copies only `server.js` and `public/` — not the whole folder. `.gitignore` and `.gcloudignore` also block common key/`.env` filenames from ever being committed or uploaded.
- **No secrets in error output.** API errors return generic codes (`server_error`, etc.); stack traces are logged server-side only.
- **HTTPS everywhere.** Cloud Run serves only over TLS, so the room code and any create key are encrypted in transit.

**What a room code protects:** the room code is a shared secret (not a login). Anyone who knows a room's code can view and edit that room — that's the intended "share the link with friends" model. It is **not** access to your Google account, your project, or any other room. Pick non-obvious room codes, and set a `CREATE_KEY` (below) if you don't want strangers creating new rooms on your public URL.

## How it's built

- **`server.js`** — Express server. Serves the static frontend and a small JSON API (`/api/state`, `/api/users`, `/api/drink`, `/api/remove`, `/api/reset`). All writes run in Firestore transactions.
- **`public/index.html`** — the whole frontend (no build step): room gate, global count, progress bar with milestone messages, canvas time-series chart, and leaderboard. Polls `/api/state` every 2s (pauses when the tab is hidden to save reads).
- **`Dockerfile`** — used by Cloud Run's `--source` deploy.

### Data model

One Firestore document per room at `rooms/{roomCode}`:

```jsonc
{
  "goal": 1000,
  "users": [ { "id": "...", "name": "Alice", "count": 12 } ],
  "events": [ 1725400000000, 1725400005000, ... ],  // drink timestamps (ms)
  "createdAt": 1725399990000
}
```

The global count is the sum of user counts; the chart is built from `events`.
