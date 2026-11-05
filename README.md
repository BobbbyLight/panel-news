# Panel News

A personal, zero-cost news reader that compares stories across a fixed
15-outlet panel (5 left, 5 neutral, 5 right). A GitHub Action fetches the feeds
hourly, clusters articles about the same story with a small sentence-embedding
model, and publishes `stories.json` with the static PWA to GitHub Pages.
No backend, accounts, analytics or third-party CDNs. All user state lives in
IndexedDB on your device.

## Layout

| Path | What |
|---|---|
| `panel.yaml` | the 15 outlets, with ordered fallback feed sources |
| `ingest/` | fetch, cluster, rank, write JSON (metadata only, never article text) |
| `scripts/check_feeds.py` | per-outlet item counts (`--all` tests every fallback) |
| `scripts/show_clusters.py` | prints clusters, or `--sweep` similarity thresholds |
| `web/` | the PWA (vanilla JS modules, no build step) |
| `worker/` | Cloudflare Worker for Read mode (Readability) |
| `.github/workflows/build.yml` | hourly build + Pages deploy |

## Setup

1. **Pages**: Settings → Pages → Source: *GitHub Actions*. The deploy runs from `main` only.
2. The first run happens on push to `main`, then hourly at :17. Trigger one by hand from the
   Actions tab ("Build & deploy" → Run workflow).
3. Open `https://<user>.github.io/panel-news/` on your phone and use "Add to Home Screen".

Pull-to-refresh (fine-grained PAT) setup is documented when that feature lands.

## Read mode Worker (Cloudflare, free plan)

`worker/` fetches an article, runs Mozilla Readability, and returns clean
structured JSON (no HTML, no images). It only answers requests whose `Origin`
is in `ALLOWED_ORIGINS` (`worker/wrangler.toml`), refuses private/IP targets,
and caches results at the edge for 6 hours. The Worker URL is not a secret.

**Deploy via GitHub Actions (recommended; no tools on your machine):**

1. Cloudflare dashboard → **Workers & Pages**. On first visit it asks you to pick a
   `*.workers.dev` subdomain; do that once.
2. Note your **Account ID** (Workers & Pages overview, right-hand column).
3. **My Profile → API Tokens → Create Token →** template **"Edit Cloudflare Workers"**.
   Account resources: your account. Zone resources: *All zones* (the template needs
   something there; the Worker uses no zones). Create, then copy the token. It's shown once.
4. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token
   - `CLOUDFLARE_ACCOUNT_ID` = the account id
5. **Actions → "Deploy read-mode Worker" → Run workflow.** The log prints the URL,
   e.g. `https://panel-news-reader.<subdomain>.workers.dev`.
6. In the app: **Settings → Read mode**, paste the URL. Or commit it to
   `web/js/config.js` so every device gets it.

After that, any change under `worker/` on `main` redeploys automatically
(tests run first).

**Or deploy from your machine:** `cd worker && npm ci && npx wrangler login && npx wrangler deploy`.

Using a different Pages origin (custom domain)? Update `ALLOWED_ORIGINS` in
`worker/wrangler.toml`.

Local dev: `cd worker && npm test` (extractor tests) and
`npx wrangler dev --var DEV:1` (allows localhost origins and targets).

## Local preview

```sh
pip install -r requirements-build.txt
python -m ingest.build --out _site --prev https://<user>.github.io/panel-news
cp -r web/. _site/ && python -m http.server -d _site 8000
```

## Tuning

- `CLUSTER_THRESHOLD` env (default `0.45`, cosine distance). Lower values split stories,
  higher values merge them. Use `scripts/show_clusters.py _site/pool.json --sweep 0.4,0.45,0.5`.
- Per-outlet `exclude_title` regex in `panel.yaml` drops junk items (e.g. NY Post sportsbook promos).

Fonts: Atkinson Hyperlegible and OpenDyslexic, both SIL OFL, self-hosted.
