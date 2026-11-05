"""Fetch the panel feeds and normalise them into flat article dicts.

Only metadata is kept: headline, link, short plain-text summary, timestamp.
Full article text never touches this module (or the repo).
"""
from __future__ import annotations

import calendar
import html
import re
import time
import urllib.parse
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import feedparser
import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
UA = "panel-news/1.0 (personal RSS reader; +https://github.com/bobbbylight/panel-news)"
TIMEOUT = 20
SUMMARY_MAX = 400  # chars; keeps us firmly in headline+blurb territory

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


@dataclass
class Article:
    outlet: str
    title: str
    url: str
    summary: str
    published: str  # ISO 8601 UTC
    ts: float       # epoch seconds, for windowing

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SourceResult:
    outlet: str
    source_type: str
    source_url: str
    ok: bool
    status: int | None = None
    count: int = 0
    recent_24h: int = 0
    newest: str | None = None
    error: str | None = None
    articles: list[Article] = field(default_factory=list)


def load_panel(path: Path | None = None) -> list[dict]:
    data = yaml.safe_load((path or ROOT / "panel.yaml").read_text())
    return data["panel"]


def clean_text(raw: str | None, limit: int = SUMMARY_MAX) -> str:
    if not raw:
        return ""
    text = html.unescape(_TAG_RE.sub(" ", raw))
    text = _WS_RE.sub(" ", text).strip()
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0] + "…"
    return text


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def gnews_url(query: str, window: str = "2d") -> str:
    q = urllib.parse.quote(f"{query} when:{window}")
    return f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"


def _get(url: str) -> requests.Response:
    return requests.get(
        url,
        headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"},
        timeout=TIMEOUT,
    )


def _parse_rss(outlet: str, body: bytes) -> list[Article]:
    feed = feedparser.parse(body)
    out: list[Article] = []
    for e in feed.entries:
        st = e.get("published_parsed") or e.get("updated_parsed")
        if not st or not e.get("link") or not e.get("title"):
            continue
        ts = float(calendar.timegm(st))
        title = clean_text(e.title, 300)
        summary = clean_text(e.get("summary") or e.get("description"))
        if summary == title:
            summary = ""
        out.append(Article(outlet, title, e.link, summary, _iso(ts), ts))
    return out


_NS = {
    "sm": "http://www.sitemaps.org/schemas/sitemap/0.9",
    "news": "http://www.google.com/schemas/sitemap-news/0.9",
}


def _parse_sitemap(outlet: str, body: bytes) -> list[Article]:
    root = ET.fromstring(body)
    out: list[Article] = []
    for u in root.findall("sm:url", _NS):
        loc = u.findtext("sm:loc", namespaces=_NS)
        title = u.findtext("news:news/news:title", namespaces=_NS)
        date = u.findtext("news:news/news:publication_date", namespaces=_NS)
        if not (loc and title and date):
            continue
        try:
            dt = datetime.fromisoformat(date.replace("Z", "+00:00"))
        except ValueError:
            try:
                dt = parsedate_to_datetime(date)
            except Exception:
                continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        ts = dt.timestamp()
        out.append(Article(outlet, clean_text(title, 300), loc.strip(), "", _iso(ts), ts))
    return out


def fetch_source(outlet: dict, src: dict) -> SourceResult:
    stype = src["type"]
    url = gnews_url(src["query"]) if stype == "gnews" else src["url"]
    res = SourceResult(outlet["id"], stype, url, ok=False)
    try:
        r = _get(url)
        res.status = r.status_code
        if r.status_code != 200:
            res.error = f"HTTP {r.status_code}"
            return res
        if stype == "sitemap":
            arts = _parse_sitemap(outlet["id"], r.content)
        else:
            arts = _parse_rss(outlet["id"], r.content)
            if stype == "gnews":
                # Google News appends " - Outlet Name" to every headline and
                # its "summary" is just an HTML link to the same headline.
                for a in arts:
                    if " - " in a.title:
                        a.title = a.title.rsplit(" - ", 1)[0]
                    a.summary = ""
    except Exception as exc:  # network, XML, anything: report, don't crash the run
        res.error = f"{type(exc).__name__}: {exc}"[:200]
        return res

    now = time.time()
    arts.sort(key=lambda a: a.ts, reverse=True)
    res.articles = arts
    res.count = len(arts)
    res.recent_24h = sum(1 for a in arts if now - a.ts < 86400)
    res.newest = arts[0].published if arts else None
    res.ok = res.recent_24h > 0
    if not res.ok and not res.error:
        res.error = "no items" if not arts else "no items in last 24h"
    return res


def fetch_outlet(outlet: dict) -> tuple[SourceResult, list[SourceResult]]:
    """Try each source in order; return (chosen, all_attempts)."""
    attempts: list[SourceResult] = []
    for src in outlet["sources"]:
        r = fetch_source(outlet, src)
        attempts.append(r)
        if r.ok:
            return r, attempts
    # Nothing recent anywhere: return the attempt with most items (may be 0).
    best = max(attempts, key=lambda a: a.count)
    return best, attempts
