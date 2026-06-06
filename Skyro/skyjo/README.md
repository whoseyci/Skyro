# Skyjo Pro — deploy to Cloudflare from GitHub (dashboard, no CLI)

Real-time multiplayer Skyjo. The server runs on **Cloudflare Workers + Durable
Objects** (via PartyServer); the same Worker also serves the game client. Push to
GitHub → Cloudflare auto-builds and deploys. No `wrangler login`, no CLI required.

## Project layout

| Path | What it is |
|------|------------|
| `public/index.html` | The entire client (UI + local game + online client). One file. |
| `src/server.ts` | Worker entry: `Room` + `Lobby` Durable Objects + fetch router. |
| `src/engine.ts` | Authoritative game logic (single source of truth). |
| `wrangler.jsonc` | Worker config (DO bindings, migrations, static assets). **Source of truth.** |
| `package.json` / `package-lock.json` / `tsconfig.json` | Tooling (commit the lockfile). |

> A standalone `skyjo-pro.html` also exists at the workspace root for **offline/local
> play only**. Online play uses the deployed Worker below.

---

## Step 1 — Push this folder to GitHub

You said the repo already exists. From inside the `skyjo/` folder:

```bash
git init                      # if not already a repo
git add .
git commit -m "Skyjo Pro (Cloudflare Workers + PartyServer)"
git branch -M main
git remote add origin https://github.com/<you>/<your-repo>.git   # skip if already added
git push -u origin main
```

Make sure these are committed: `src/`, `public/`, `wrangler.jsonc`, `package.json`,
`package-lock.json`, `tsconfig.json`. (`node_modules/` and `.wrangler/` are git-ignored.)

---

## Step 2 — Create the Worker from Git in the Cloudflare dashboard

> ⚠️ **MOST COMMON MISTAKE:** if `wrangler.jsonc` lives in a `skyjo/` subfolder of
> your repo (it does, in this project), you **must** set **Root directory = `skyjo`**.
> Otherwise the build runs at the repo root, can't find `wrangler.jsonc` or `public/`,
> and fails with *"Could not detect a directory containing static files."*

1. Go to **dash.cloudflare.com** → **Workers & Pages**.
2. Click **Create application** → **Workers** tab → **Import a repository**
   (a.k.a. *Connect to Git*). Authorize GitHub if prompted and pick your repo.
3. On the build settings screen set:
   - **Project / Worker name:** `skyjo-pro`
     *(must match `name` in `wrangler.jsonc`)*
   - **Root directory:** **`skyjo`**  ← the folder that contains `wrangler.jsonc`
     *(leave as `/` only if you committed `wrangler.jsonc` at the repo root)*
   - **Build command:** `npm install`
   - **Deploy command:** `npx wrangler deploy`
4. Click **Save and Deploy**.

### Already created the Worker and it failed?
Don't recreate it. Go to your Worker → **Settings → Build → Build configuration →
Edit**, set **Root directory = `skyjo`**, **Build command = `npm install`**,
**Deploy command = `npx wrangler deploy`**, save, then **Retry deployment**.

**Alternative** (if you can't/won't change Root directory): keep root `/` and set the
**Deploy command** to run from the subfolder instead:

```
cd skyjo && npm install && npx wrangler deploy
```

Either way, `npm install` must run so your pinned wrangler from `package-lock.json` is
used — if you see the build *installing* `wrangler@4.x` on the fly, install didn't run.

Cloudflare runs the build, reads `wrangler.jsonc`, creates the two Durable Object
namespaces (`Room`, `Lobby`) with the SQLite migration, uploads `public/` as static
assets, and deploys. First build takes ~1–2 min.

When it finishes you get a URL like **`https://skyjo-pro.<your-subdomain>.workers.dev`**.
Open it — that's the game. Because the client uses `location.host`, websockets and the
page share that origin automatically; **nothing to configure**.

> **Every future `git push` to `main` auto-deploys.** Pull requests get preview URLs.

---

## Step 3 — Play

- Open the `*.workers.dev` URL on two devices/tabs.
- **Host a Room** → choose 🌍 Public or 🔒 Private → pick a code (e.g. `CUTE`).
- On the other device, **Join a Room** → type `CUTE`, or pick it from the live
  **Public Rooms** list (public rooms only).
- Host taps **Start Game** once ≥2 players are seated.

---

## How the URLs map (for reference)

PartyServer routes `/parties/<binding-kebab>/<name>`:

| Binding (wrangler.jsonc) | URL the client opens | Purpose |
|---|---|---|
| `Room`  | `wss://HOST/parties/room/<CODE>` | one game per code |
| `Lobby` | `wss://HOST/parties/lobby/public-lobby` | public-room discovery |

Anything that isn't `/parties/*` falls through to the `ASSETS` binding → `index.html`.

---

## Local development (optional)

```bash
npm install
npm run dev        # wrangler dev — runs Worker + DOs + static client locally
# open the printed http://localhost:8787
npm run typecheck  # tsc --noEmit
```

`npx wrangler deploy --dry-run` validates the build without deploying (no login needed).

---

## Troubleshooting

- **Build fails "name mismatch":** the dashboard Worker name must equal `name` in
  `wrangler.jsonc` (`skyjo-pro`). Rename one to match.
- **"Cannot create Durable Object … migration":** ensure the `migrations` block in
  `wrangler.jsonc` is committed; it's required to create `Room`/`Lobby` the first time.
- **Two people with the same code land in different rooms (the old bug):** that was the
  MQTT version. With this setup a code maps to exactly one Durable Object, so it can't
  happen. If you *do* see it, you're probably still opening the old `skyjo-pro.html`
  standalone file instead of the deployed `*.workers.dev` URL.
- **Public rooms don't show:** the lister drops rooms after 30 s of no host activity;
  make sure the host still has the tab open and that they chose **Public**.
- **Root directory:** if your GitHub repo root is the *workspace* (with `skyjo/` inside),
  set **Root directory = `skyjo`** in the dashboard build settings.
