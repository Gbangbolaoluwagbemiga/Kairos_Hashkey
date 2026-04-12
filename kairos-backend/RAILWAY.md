# Deploy Kairos backend on Railway

## After you have a public URL (e.g. `*.up.railway.app`)

1. **`curl https://YOUR-URL/health`** — should return JSON with `"status":"ok"`.
2. Railway **port** (e.g. `8880`) is internal; browsers use **HTTPS on port 443** only — your public URL has no `:8880` in it.
3. Set **`ALLOWED_ORIGINS`** on the service to your real frontend origin(s), comma-separated.
4. On the **frontend** host (Vercel, Netlify, or another Railway service), set **`VITE_API_URL=https://YOUR-URL`** (no trailing slash), then redeploy the frontend.

---

Your error **`Error creating build plan with Railpack`** almost always means Railway is building from the **Git repo root**, where there is **no `package.json`**. This repo is a **monorepo**: the API lives in **`kairos-backend/`**.

You can fix it in one of two ways: **(A) Root Directory + Dockerfile (recommended)** or **(B) Root Directory + Nixpacks**.

---

## A. Recommended: Docker build from `kairos-backend`

This repo includes `Dockerfile` and `railway.toml` in **`kairos-backend/`**.

### 1. Create the service

1. Railway → **New Project** → **Deploy from GitHub** → select your repo.
2. Railway may create a service automatically. Open the service → **Settings**.

### 2. Set Root Directory (critical)

1. **Settings** → **Service** (or **Source**).
2. **Root Directory** → set to: **`kairos-backend`**
3. Save.

Without this, Railway looks at the repo root, finds no Node app, and Railpack fails.

### 3. Confirm build uses Docker

With `railway.toml` in `kairos-backend`, the builder should be **Dockerfile**.  
If Railway still shows Railpack:

1. **Settings** → **Build** → set **Builder** to **Dockerfile** (or “Docker”).
2. **Dockerfile path**: `Dockerfile` (default when root is `kairos-backend`).

### 4. Set environment variables

In **Variables**, add at least:

| Variable | Required | Notes |
|----------|----------|--------|
| `GROQ_API_KEY` | Yes | Groq API key |
| `GROQ_MODEL` | No | Groq model id (default `llama-3.3-70b-versatile`) |
| `FOURMEME_TREASURY_PRIVATE_KEY` | Yes for on-chain features | Treasury wallet private key |
| `FOURMEME_RPC_URL` | Optional | BNB testnet RPC (default built-in) |
| `SUPABASE_URL` | Optional | If you use Supabase |
| `SUPABASE_ANON_KEY` | Optional | |
| `ALLOWED_ORIGINS` | **Yes for browser clients** | Comma-separated frontend URLs, e.g. `https://your-app.vercel.app,http://localhost:5173` |
| `PORT` | No | Railway injects `PORT` automatically; the app reads it |

Copy any other keys you use locally from `kairos-backend/.env` (e.g. `KAIROS_AGENT_REGISTRY_EVM_ADDRESS`, `KAIROS_SPENDING_POLICY_EVM_ADDRESS`, `KAIROS_*` tuning vars).

### 5. Networking

1. **Settings** → generate a **public domain** (or attach custom domain) so the API is reachable.
2. Your API base URL will be like `https://kairos-production-xxxx.up.railway.app`.

### 6. Point the frontend at Railway

In the frontend (e.g. Vite):

- Set **`VITE_API_URL`** to your Railway URL **including** `https://` and **no** trailing slash, e.g. `https://kairos-production-xxxx.up.railway.app`.

Redeploy the frontend after changing env vars.

### 7. Verify

```bash
curl https://YOUR-RAILWAY-URL/health
```

Expect JSON with `"status":"ok"`.

---

## B. Alternative: Nixpacks (no Docker)

If you prefer Railpack/Nixpacks:

1. **Root Directory** = **`kairos-backend`**
2. **Build command**: `npm run build`
3. **Start command**: `node dist/index.js`
4. **Node version**: 20 or 22 (match `Dockerfile` or add `"engines": { "node": ">=20" }` in `package.json`)

Railway should detect `package.json` **only after** root is set to `kairos-backend`.

---

## Common failures

| Symptom | Fix |
|--------|-----|
| `Error creating build plan with Railpack` | Set **Root Directory** to `kairos-backend` and/or use **Dockerfile** builder. |
| `npm ci` / `package.json` and lock file **not in sync** | Run **`npm install`** inside `kairos-backend`, commit **`package-lock.json`**, and redeploy. Railway uses `npm ci`, which requires an exact match. |
| CORS / `Failed to fetch` / `502` from browser | The API sets **`trust proxy`** for Railway and uses **permissive CORS** by default (`Origin` reflected). Set **`STRICT_CORS=1`** only if you want an allowlist (`ALLOWED_ORIGINS` + `*.vercel.app`). If you still see **502**, open **Deploy Logs** (crash/OOM) — not a CORS-only issue. |
| `502` / crash on boot | Check **Deploy Logs** for missing `GROQ_API_KEY` or invalid secrets. |
| DB / Supabase errors | Set `SUPABASE_URL` and `SUPABASE_ANON_KEY`; optional if you rely on in-memory fallback. |

---

## Two services (API + static frontend)

- **Service 1**: Root `kairos-backend`, Docker or Nixpacks as above.
- **Service 2**: Root `kairos-frontend`, build `npm run build`, start `npx serve -s dist` (or deploy frontend on **Vercel/Netlify** and only host API on Railway).

---

## Local Docker sanity check

From the **`kairos-backend`** folder:

```bash
docker build -t kairos-api .
docker run --rm -p 3001:3001 -e GROQ_API_KEY=your_key -e GROQ_MODEL=llama-3.3-70b-versatile kairos-api
curl http://localhost:3001/health
```

If this works, Railway will work once **Root Directory** and variables are correct.
