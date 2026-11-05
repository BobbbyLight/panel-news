"""Hourly build: fetch panel -> merge rolling pool -> cluster -> write JSON.

    python -m ingest.build --out _site/ [--prev https://user.github.io/repo]

Outputs (all metadata only: headline, link, short summary, time):
    stories.json       clusters ranked for the daily feed
    feeds-health.json  per-outlet fetch status
    pool.json          the rolling 48h article pool, re-read next run so
                       stories persist after they scroll off a feed
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

from .cluster import DISTANCE_THRESHOLD, cluster
from .feeds import UA, fetch_outlet, load_panel
from .gnews import is_gnews, resolve_all

WINDOW_HOURS = 48
LEANS = ("left", "neutral", "right")
# Preferred outlet for the story's display headline (plain wire copy first).
HEADLINE_PREF = ["ap", "reuters", "bbc", "npr", "thehill"]
SCHEMA = 1
SINGLETON_HOURS = 18


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _load_prev(prev: str | None, name: str):
    if not prev:
        return None
    try:
        if prev.startswith("http"):
            r = requests.get(f"{prev.rstrip('/')}/{name}", params={"t": int(time.time())},
                             headers={"User-Agent": UA}, timeout=20)
            return r.json() if r.status_code == 200 else None
        p = Path(prev) / name
        return json.loads(p.read_text()) if p.exists() else None
    except Exception as exc:
        print(f"[prev] could not load {name}: {exc}", file=sys.stderr)
        return None


def _norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", t.lower()).strip()


def merge_pool(fresh: list[dict], prev_pool: list[dict] | None, now: float) -> list[dict]:
    cutoff = now - WINDOW_HOURS * 3600
    by_key: dict[tuple, dict] = {}
    # Previous first so fresh copies (possibly edited headlines) win.
    for a in (prev_pool or []) + fresh:
        if a["ts"] < cutoff or a["ts"] > now + 3600:
            continue
        key = (a["outlet"], _norm_title(a["title"]))
        url_key = a["url"]
        old = by_key.get(key)
        if old and old["url"] != url_key and old["ts"] < a["ts"]:
            a = {**a, "ts": old["ts"], "published": old["published"]}
        by_key[key] = a
    # Also collapse identical URLs (headline edited in place).
    by_url: dict[str, dict] = {}
    for a in by_key.values():
        by_url[a["url"]] = a
    return sorted(by_url.values(), key=lambda a: a["ts"], reverse=True)


def _story_id(urls: list[str], prev_ids: dict[str, str], taken: set[str]) -> str:
    votes = Counter(prev_ids[u] for u in urls if u in prev_ids)
    for sid, _ in votes.most_common():
        if sid not in taken:
            return sid
    return hashlib.sha1(min(urls).encode()).hexdigest()[:12]


def build_stories(pool: list[dict], panel: list[dict], prev_stories: dict | None, now: float):
    outlets = {o["id"]: o for o in panel}
    groups, emb = cluster(pool)

    prev_ids: dict[str, str] = {}
    prev_first: dict[str, str] = {}
    for s in (prev_stories or {}).get("stories", []):
        prev_first[s["id"]] = s.get("first_seen")
        for a in s["articles"] + s.get("more", []):
            prev_ids[a["url"]] = s["id"]

    stories, taken = [], set()
    for idx in groups:
        centroid = emb[idx].mean(axis=0)
        centroid /= np.linalg.norm(centroid) or 1.0
        sims = {i: float(emb[i] @ centroid) for i in idx}

        # One representative headline per outlet: the one closest to the centroid.
        per_outlet: dict[str, list[int]] = {}
        for i in idx:
            per_outlet.setdefault(pool[i]["outlet"], []).append(i)
        reps, more = [], []
        for oid, ii in per_outlet.items():
            ii.sort(key=lambda i: sims[i], reverse=True)
            reps.append(ii[0])
            more.extend(ii[1:])

        def art(i: int, full: bool = True) -> dict:
            a, o = pool[i], outlets[pool[i]["outlet"]]
            d = {"outlet": o["id"], "lean": o["lean"], "slot": o["slot"],
                 "title": a["title"], "url": a["url"], "published": a["published"]}
            if full:
                d["summary"] = a.get("summary", "")
            return d

        articles = sorted((art(i) for i in reps),
                          key=lambda d: (LEANS.index(d["lean"]), d["slot"]))
        coverage = {l: sum(1 for a in articles if a["lean"] == l) for l in LEANS}
        slots = [0] * 15
        for a in articles:
            slots[LEANS.index(a["lean"]) * 5 + a["slot"]] = 1

        rep_by_outlet = {pool[i]["outlet"]: i for i in reps}
        head_i = next((rep_by_outlet[o] for o in HEADLINE_PREF if o in rep_by_outlet),
                      max(reps, key=lambda i: sims[i]))

        times = sorted(pool[i]["ts"] for i in idx)
        n_out = len(reps)
        n_leans = sum(1 for v in coverage.values() if v)
        age_h = (now - times[-1]) / 3600
        # Breadth across the panel dominates; recency decays over ~a day.
        score = n_out * (1 + 0.35 * (n_leans - 1)) * math.exp(-age_h / 20)

        # Blindspot: one partisan side is silent while the story is clearly
        # being covered elsewhere (>=4 outlets, >=2 on the opposite side).
        # Value is the side that is NOT covering it.
        blindspot = None
        for side, other in (("left", "right"), ("right", "left")):
            if coverage[side] == 0 and n_out >= 4 and coverage[other] >= 2:
                blindspot = side

        sid = _story_id([pool[i]["url"] for i in idx], prev_ids, taken)
        taken.add(sid)
        first_seen = prev_first.get(sid) or datetime.fromtimestamp(times[0], timezone.utc).isoformat(timespec="seconds")
        stories.append({
            "id": sid,
            "title": pool[head_i]["title"],
            "lead": pool[head_i]["outlet"],
            "first_seen": first_seen,
            "updated": datetime.fromtimestamp(times[-1], timezone.utc).isoformat(timespec="seconds"),
            "score": round(score, 3),
            "outlet_count": n_out,
            "coverage": coverage,
            "slots": slots,
            "blindspot": blindspot,
            "articles": articles,
            "more": sorted((art(i, False) for i in more), key=lambda d: d["published"], reverse=True),
        })

    # Single-outlet items are only worth keeping while fresh; this roughly
    # halves stories.json without touching anything with real coverage.
    stale = now - SINGLETON_HOURS * 3600
    stories = [s for s in stories if s["outlet_count"] > 1
               or datetime.fromisoformat(s["updated"]).timestamp() > stale]
    stories.sort(key=lambda s: s["score"], reverse=True)
    return stories


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="_site")
    ap.add_argument("--prev", help="URL or dir holding last run's pool.json/stories.json")
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    now = time.time()

    panel = load_panel()
    t0 = time.time()
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(fetch_outlet, panel))
    print(f"fetched {len(panel)} outlets in {time.time() - t0:.1f}s")

    fresh, health = [], []
    for o, (chosen, attempts) in zip(panel, results):
        fresh.extend(a.to_dict() for a in chosen.articles)
        health.append({
            "id": o["id"], "name": o["name"], "lean": o["lean"], "slot": o["slot"],
            "ok": chosen.ok, "via": chosen.source_type, "source": chosen.source_url,
            "items": chosen.count, "recent_24h": chosen.recent_24h, "newest": chosen.newest,
            "fallback": len(attempts) > 1 and chosen.ok,
            "attempts": [{"type": a.source_type, "url": a.source_url, "status": a.status,
                          "items": a.count, "error": a.error} for a in attempts],
        })

    prev_pool = _load_prev(args.prev, "pool.json")
    prev_stories = _load_prev(args.prev, "stories.json")
    prev_articles = (prev_pool or {}).get("articles", [])

    # Swap Google News redirect links (AP/Reuters) for publisher URLs.
    gmap = dict((prev_pool or {}).get("gnews_map", {}))
    g_urls = [a["url"] for a in fresh + prev_articles if is_gnews(a["url"])]
    resolved = resolve_all(g_urls, gmap) if g_urls else {}
    for a in fresh + prev_articles:
        if a["url"] in resolved:
            a["url"] = resolved[a["url"]]
    # Only ids still in the live feeds need remembering.
    live_ids = {u.rsplit("/", 1)[-1].split("?")[0] for u in g_urls}
    gmap = {k: v for k, v in gmap.items() if k in live_ids}

    pool = merge_pool(fresh, prev_articles, now)
    left = sum(is_gnews(a["url"]) for a in pool)
    print(f"gnews: {len(resolved)} links resolved, {left} still unresolved in pool")
    print(f"pool: {len(fresh)} fresh + {len((prev_pool or {}).get('articles', []))} previous -> {len(pool)} in {WINDOW_HOURS}h window")

    t0 = time.time()
    stories = build_stories(pool, panel, prev_stories, now)
    print(f"clustered into {len(stories)} stories in {time.time() - t0:.1f}s (threshold {DISTANCE_THRESHOLD})")

    gen = _now_iso()
    meta = {"schema": SCHEMA, "generated_at": gen, "window_hours": WINDOW_HOURS}
    panel_meta = [{k: o[k] for k in ("id", "name", "lean", "slot", "domain")} for o in panel]
    dump = lambda name, obj: (out / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    dump("stories.json", {**meta, "panel": panel_meta, "stories": stories})
    dump("feeds-health.json", {**meta, "healthy": sum(h["ok"] for h in health), "outlets": health})
    dump("pool.json", {**meta, "articles": pool, "gnews_map": gmap})
    for f in ("stories.json", "feeds-health.json", "pool.json"):
        print(f"  {f}: {(out / f).stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
