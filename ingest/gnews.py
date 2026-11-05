"""Resolve Google News redirect links (news.google.com/rss/articles/<id>) to
the publisher URL, so Read mode and "open original" hit AP/Reuters directly.

Google no longer encodes the target in the id itself; the page for each id
carries a signature + timestamp that the batchexecute endpoint exchanges for
the real URL. Resolutions are cached across runs in pool.json (`gnews_map`),
so each article is resolved once. Anything that fails keeps its Google link
and is retried next run.
"""
from __future__ import annotations

import json
import re
import time
import urllib.parse

import requests

from .feeds import UA

_ID_RE = re.compile(r"news\.google\.com/(?:rss/)?articles/([^?/#]+)")
_SG_RE = re.compile(r'data-n-a-sg="([^"]+)"')
_TS_RE = re.compile(r'data-n-a-ts="([^"]+)"')
BATCH = 20
MAX_PER_RUN = 150


def is_gnews(url: str) -> bool:
    return bool(_ID_RE.search(url))


def _params(session: requests.Session, art_id: str) -> tuple[str, str] | None:
    r = session.get(f"https://news.google.com/rss/articles/{art_id}", timeout=15)
    if r.status_code != 200:
        return None
    sg, ts = _SG_RE.search(r.text), _TS_RE.search(r.text)
    return (sg.group(1), ts.group(1)) if sg and ts else None


def _batch_decode(session: requests.Session, items: list[tuple[str, str, str]]) -> dict[str, str]:
    reqs = [
        [
            "Fbv4je",
            '["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],'
            f'"X","X",1,[1,1,1],1,1,null,0,0,null,0],"{aid}",{ts},"{sg}"]',
        ]
        for aid, sg, ts in items
    ]
    body = "f.req=" + urllib.parse.quote(json.dumps([reqs]))
    r = session.post(
        "https://news.google.com/_/DotsSplashUi/data/batchexecute",
        data=body,
        headers={"content-type": "application/x-www-form-urlencoded;charset=UTF-8"},
        timeout=20,
    )
    r.raise_for_status()
    out: dict[str, str] = {}
    payload = json.loads(r.text.split("\n\n", 1)[1])
    urls = [json.loads(row[2])[1] for row in payload if row and row[0] == "wrb.fr" and row[2]]
    for (aid, _, _), url in zip(items, urls):
        if isinstance(url, str) and url.startswith("http"):
            out[aid] = url
    return out


def resolve_all(urls: list[str], cache: dict[str, str]) -> dict[str, str]:
    """Return {google_url: real_url} for every resolvable url, using/filling cache."""
    todo = []
    for u in dict.fromkeys(urls):
        m = _ID_RE.search(u)
        if m and m.group(1) not in cache:
            todo.append(m.group(1))
    todo = todo[:MAX_PER_RUN]

    if todo:
        s = requests.Session()
        s.headers["User-Agent"] = UA
        ok = 0
        for i in range(0, len(todo), BATCH):
            chunk = []
            for aid in todo[i : i + BATCH]:
                try:
                    p = _params(s, aid)
                except requests.RequestException:
                    p = None
                if p:
                    chunk.append((aid, *p))
                time.sleep(0.2)
            if not chunk:
                continue
            try:
                found = _batch_decode(s, chunk)
            except Exception as exc:
                print(f"[gnews] batch failed: {exc}")
                continue
            cache.update(found)
            ok += len(found)
        print(f"[gnews] resolved {ok}/{len(todo)} new links ({len(cache)} cached)")

    out = {}
    for u in urls:
        m = _ID_RE.search(u)
        if m and m.group(1) in cache:
            out[u] = cache[m.group(1)]
    return out
