/**
 * data.js — loads stories.json (built hourly by the GitHub Action) and
 * exposes lean/slot helpers. Network first with a cache-buster; the service
 * worker keeps the last good copy so the app opens offline.
 */

export const LEANS = ["left", "neutral", "right"];
export const LEAN_LABEL = { left: "Left", neutral: "Neutral", right: "Right" };

let state = { data: null, byId: new Map(), outlets: new Map(), loadedAt: 0, offline: false };

function index(data) {
  state.data = data;
  state.byId = new Map(data.stories.map((s) => [s.id, s]));
  state.outlets = new Map(data.panel.map((o) => [o.id, o]));
}

export async function loadStories({ bust = false } = {}) {
  const url = bust ? `stories.json?t=${Date.now()}` : "stories.json";
  try {
    const res = await fetch(url, { cache: bust ? "no-store" : "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    index(await res.json());
    state.offline = false;
  } catch (err) {
    // Fall back to whatever the service worker cached last.
    const cached = await caches?.match?.("stories.json", { ignoreSearch: true });
    if (!cached) throw err;
    index(await cached.json());
    state.offline = true;
  }
  state.loadedAt = Date.now();
  return state.data;
}

export const Data = {
  get data() {
    return state.data;
  },
  get offline() {
    return state.offline;
  },
  story: (id) => state.byId.get(id),
  outlet: (id) => state.outlets.get(id),
  /** All 15 slots in display order, each {lean, slot, outlet, article|null}. */
  slotsFor(story) {
    const byOutlet = new Map(story.articles.map((a) => [a.outlet, a]));
    return state.data.panel
      .slice()
      .sort((a, b) => LEANS.indexOf(a.lean) - LEANS.indexOf(b.lean) || a.slot - b.slot)
      .map((o) => ({ lean: o.lean, slot: o.slot, outlet: o, article: byOutlet.get(o.id) || null }));
  },
  leadArticle(story) {
    return story.articles.find((a) => a.outlet === story.lead) || story.articles[0];
  },
  ageHours() {
    if (!state.data) return Infinity;
    return (Date.now() - Date.parse(state.data.generated_at)) / 36e5;
  },
};

export function timeAgo(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
