"""Print clusters from a built stories.json so they can be eyeballed in CI logs.

    python scripts/show_clusters.py _site/stories.json [--top 20]
    python scripts/show_clusters.py _site/pool.json --sweep 0.35,0.45,0.55
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BAR = {"left": "L", "neutral": "N", "right": "R"}


def bar(slots: list[int]) -> str:
    cells = "".join("█" if s else "·" for s in slots)
    return f"[{cells[:5]}|{cells[5:10]}|{cells[10:]}]"


def show(path: Path, top: int) -> None:
    d = json.loads(path.read_text())
    stories = d["stories"]
    sizes = Counter(min(s["outlet_count"], 10) for s in stories)
    print(f"generated {d['generated_at']}: {len(stories)} stories")
    print("outlets/story histogram:", ", ".join(f"{k}{'+' if k == 10 else ''}:{sizes[k]}" for k in sorted(sizes)))
    print(f"blindspots: left={sum(s['blindspot'] == 'left' for s in stories)} "
          f"right={sum(s['blindspot'] == 'right' for s in stories)}\n")
    for n, s in enumerate(stories[:top], 1):
        bs = f"  BLINDSPOT:{s['blindspot']}" if s["blindspot"] else ""
        print(f"#{n:<2} {bar(s['slots'])} {s['outlet_count']:>2} outlets  score {s['score']:<6}{bs}")
        print(f"    {s['title']}")
        for a in s["articles"]:
            print(f"      {BAR[a['lean']]} {a['outlet']:<12} {a['title'][:100]}")
        if s["more"]:
            print(f"      (+{len(s['more'])} more from same outlets)")
        print()


def sweep(path: Path, thresholds: list[float]) -> None:
    from ingest.cluster import cluster
    arts = json.loads(path.read_text())["articles"]
    print(f"sweep over {len(arts)} articles")
    for t in thresholds:
        t0 = time.time()
        groups, _ = cluster(arts, t)
        outs = [len({arts[i]["outlet"] for i in g}) for g in groups]
        dup = sum(len(g) - len({arts[i]["outlet"] for i in g}) for g in groups)
        big = sorted(outs, reverse=True)[:5]
        print(f"t={t:.2f}: {len(groups)} clusters, >=3 outlets: {sum(o >= 3 for o in outs)}, "
              f">=8: {sum(o >= 8 for o in outs)}, biggest {big}, same-outlet dupes {dup} ({time.time() - t0:.1f}s)")
        # Show the largest cluster at each threshold to spot over-merging.
        g = max(groups, key=len)
        for i in g[:12]:
            print(f"      {arts[i]['outlet']:<12} {arts[i]['title'][:95]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("path", type=Path)
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--sweep")
    a = ap.parse_args()
    if a.sweep:
        sweep(a.path, [float(x) for x in a.sweep.split(",")])
    else:
        show(a.path, a.top)
