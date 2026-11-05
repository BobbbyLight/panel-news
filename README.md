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
| `.github/workflows/build.yml` | hourly build + Pages deploy |

## Setup

1. **Pages**: Settings → Pages → Source: *GitHub Actions*. The deploy runs from `main` only.
2. The first run happens on push to `main`, then hourly at :17. Trigger one by hand from the
   Actions tab ("Build & deploy" → Run workflow).
3. Open `https://<user>.github.io/panel-news/` on your phone and use "Add to Home Screen".

Read mode (Cloudflare Worker) and pull-to-refresh (fine-grained PAT) setup are
documented as those features land.

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
