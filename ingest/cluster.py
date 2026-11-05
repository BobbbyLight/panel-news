"""Group articles about the same story.

Embeds "title. summary" with all-MiniLM-L6-v2, then runs average-linkage
agglomerative clustering on cosine distance. Average linkage (rather than
single) stops two unrelated stories from chaining together through one
ambiguous headline.
"""
from __future__ import annotations

import os

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import pdist

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# Cosine *distance* cut-off (1 - similarity). Tuned against real panel data:
# same-event headlines from different outlets typically sit at 0.55-0.85
# similarity; "same topic, different event" sits around 0.35-0.5.
DISTANCE_THRESHOLD = float(os.environ.get("CLUSTER_THRESHOLD", "0.45"))

# Articles further apart than this can never share a cluster.
MAX_SPREAD_HOURS = 36

_model = None


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME, device="cpu")
    return _model


def embed(texts: list[str]) -> np.ndarray:
    return _get_model().encode(
        texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False
    ).astype(np.float32)


def article_text(a: dict) -> str:
    s = a.get("summary") or ""
    return f"{a['title']}. {s[:300]}" if s else a["title"]


def cluster(articles: list[dict], threshold: float = DISTANCE_THRESHOLD) -> tuple[list[list[int]], np.ndarray]:
    """Return (clusters as lists of article indices, embedding matrix)."""
    n = len(articles)
    if n == 0:
        return [], np.zeros((0, 384), np.float32)
    emb = embed([article_text(a) for a in articles])
    if n == 1:
        return [[0]], emb

    dist = pdist(emb, metric="cosine")
    # Push apart pairs too far apart in time so they can't merge.
    ts = np.array([a["ts"] for a in articles], dtype=np.float64)[:, None]
    tdist = pdist(ts, metric="cityblock") / 3600.0
    dist = np.where(tdist > MAX_SPREAD_HOURS, 2.0, np.clip(dist, 0, 2))

    Z = linkage(dist, method="average")
    labels = fcluster(Z, t=threshold, criterion="distance")
    groups: dict[int, list[int]] = {}
    for i, lab in enumerate(labels):
        groups.setdefault(int(lab), []).append(i)
    return list(groups.values()), emb
