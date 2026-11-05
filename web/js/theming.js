/**
 * theming.js — same engine as adhdtimeline: three independent axes applied as
 * attributes on <html> (palette, flair intensity, reduce-motion kill switch)
 * plus typography. IndexedDB is the source of truth; a localStorage mirror lets
 * the inline script in index.html apply everything before first paint.
 *
 * Also owns the remembered list view (standard | compact | cards).
 */
import { DB } from "./db.js";

export const THEMES = [
  { id: "vaporwave-bold", label: "Vaporwave Bold", mode: "dark", color: "#0d0716" },
  { id: "vaporwave-soft", label: "Vaporwave Soft", mode: "light", color: "#f7f0fa" },
  { id: "dark-gray", label: "Dark Gray", mode: "dark", color: "#1c1c1e" },
  { id: "oled", label: "Black OLED", mode: "dark", color: "#000000" },
  { id: "dark-blue", label: "Dark Blue", mode: "dark", color: "#0a1128" },
  { id: "light-neutral", label: "Light Neutral", mode: "light", color: "#f7f7f5" },
];

const mq = (q) => window.matchMedia && window.matchMedia(q).matches;

const DEFAULTS = {
  theme: null, // resolved from system preference
  flair: "subtle",
  reduceMotion: null, // resolved from prefers-reduced-motion
  font: "atkinson",
  lineHeight: 1.5,
  letterSpacing: 0,
  view: "standard",
  diffHighlight: false,
};

const LS = "panelnews:";
let current = { ...DEFAULTS };
const listeners = new Set();

function resolve(s) {
  return {
    ...s,
    theme: s.theme || (mq("(prefers-color-scheme: dark)") ? "dark-gray" : "light-neutral"),
    reduceMotion: s.reduceMotion ?? mq("(prefers-reduced-motion: reduce)"),
  };
}

function apply(s) {
  const r = document.documentElement;
  r.dataset.theme = s.theme;
  r.dataset.flair = s.flair;
  r.dataset.reduceMotion = String(Boolean(s.reduceMotion));
  r.dataset.font = s.font;
  r.dataset.view = s.view;
  r.style.setProperty("--line-height-base", String(s.lineHeight));
  r.style.setProperty("--letter-spacing-base", `${s.letterSpacing}em`);
  const meta = document.querySelector('meta[name="theme-color"]');
  const t = THEMES.find((x) => x.id === s.theme);
  if (meta && t) meta.content = t.color;
}

function mirror(key, value) {
  try {
    localStorage.setItem(LS + key, JSON.stringify(value));
  } catch {
    /* private mode: IndexedDB still holds it */
  }
}

export const Theming = {
  THEMES,
  get: () => ({ ...current }),
  async init() {
    const stored = await DB.getSettings();
    const merged = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (stored[k] !== undefined) merged[k] = stored[k];
    current = resolve(merged);
    apply(current);
    for (const k of Object.keys(DEFAULTS)) mirror(k, current[k]);
    return this.get();
  },
  async set(key, value) {
    current = { ...current, [key]: value };
    apply(current);
    mirror(key, value);
    await DB.setSetting(key, value);
    for (const fn of listeners) fn(this.get());
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
