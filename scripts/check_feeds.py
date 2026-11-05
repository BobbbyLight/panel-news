"""Step-1 test: hit every source for every panel outlet and print item counts.

    python scripts/check_feeds.py          # chosen source per outlet
    python scripts/check_feeds.py --all    # every source, including fallbacks

Exit code is non-zero if any outlet has zero recent items.
"""
from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ingest.feeds import fetch_outlet, fetch_source, load_panel  # noqa: E402


def main() -> int:
    show_all = "--all" in sys.argv
    panel = load_panel()

    if show_all:
        jobs = [(o, s) for o in panel for s in o["sources"]]
        with ThreadPoolExecutor(12) as ex:
            results = list(ex.map(lambda j: (j[0], fetch_source(*j)), jobs))
        print(f"{'outlet':<14}{'type':<9}{'http':<6}{'items':>6}{'24h':>5}  newest                     source / error")
        for o, r in results:
            mark = "OK " if r.ok else "XX "
            print(f"{mark}{o['id']:<11}{r.source_type:<9}{str(r.status or '-'):<6}{r.count:>6}{r.recent_24h:>5}  "
                  f"{(r.newest or '-'):<26} {r.source_url[:70]}{'  <- ' + r.error if r.error else ''}")
        return 0

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(fetch_outlet, panel))

    failed = 0
    print(f"{'lean':<8}{'outlet':<22}{'via':<9}{'items':>6}{'24h':>5}  newest")
    for o, (chosen, attempts) in zip(panel, results):
        fell_back = len(attempts) > 1
        mark = "OK" if chosen.ok else "XX"
        failed += not chosen.ok
        note = f"  (fallback #{len(attempts)})" if fell_back and chosen.ok else ""
        if not chosen.ok:
            note = "  " + "; ".join(f"{a.source_type}:{a.error}" for a in attempts)
        print(f"{mark} {o['lean']:<6}{o['name']:<22}{chosen.source_type:<9}{chosen.count:>6}"
              f"{chosen.recent_24h:>5}  {chosen.newest or '-'}{note}")
        if chosen.articles:
            print(f"      └ {chosen.articles[0].title[:90]}")
    print(f"\n{15 - failed}/15 outlets healthy")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
