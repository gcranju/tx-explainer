# Deploy

Two free hosts, both git-based:

- **Frontend** (Vite/React) → **Vercel**
- **Backend** (Fastify + Anthropic, SSE streaming) → **Render** free tier
  (Vercel serverless caps requests at 60s; the LLM agent loop can run longer,
  so the backend lives on Render where long-lived SSE has no short timeout.
  Note: Render's free tier sleeps after ~15 min idle and cold-starts on the
  next request.)

## 1. Push to GitHub

```bash
git init && git add -A && git commit -m "Initial commit"
gh repo create tx-explainer --private --source=. --push   # or create the repo in the GitHub UI and push
```

## 2. Backend → Render

1. Go to https://dashboard.render.com → **New** → **Blueprint**.
2. Connect the repo. Render reads [render.yaml](render.yaml) and creates the
   `tx-explainer-backend` web service.
3. In the service's **Environment** tab, set:
   - `ANTHROPIC_API_KEY` — required
   - `SONIC_RPC_URL`, `SONICSCAN_API_KEY` — optional overrides
4. Deploy. Copy the resulting URL, e.g. `https://tx-explainer-backend.onrender.com`.
5. Verify: `curl https://<your-backend>.onrender.com/health`

## 3. Frontend → Vercel

1. Go to https://vercel.com → **Add New** → **Project** → import the repo.
2. Set **Root Directory** to `frontend` (Vercel auto-detects Vite: build
   `npm run build`, output `dist`).
3. Add an environment variable:
   - `VITE_BACKEND` = `https://<your-backend>.onrender.com`
4. Deploy.

## Notes

- The backend already sends `Access-Control-Allow-Origin: *`, so the Vercel
  origin can call it cross-domain.
- To change the backend URL later, update `VITE_BACKEND` in Vercel and redeploy
  the frontend (Vite inlines env vars at build time).
