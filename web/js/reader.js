/**
 * reader.js — Read mode: fetch extracted text from the Worker (or IndexedDB),
 * render it from structured blocks (never innerHTML), and drive the reader
 * controls: font size, line spacing, line focus, bold first letters and
 * read-aloud (Web Speech API).
 *
 * mount() returns a cleanup function the router calls when leaving the view.
 */
import { DB } from "./db.js";
import { Theming } from "./theming.js";
import { DEFAULT_WORKER_URL } from "./config.js";

const RATES = [0.8, 1, 1.2, 1.4, 1.6, 1.8, 2];
const SIZE_MIN = 15, SIZE_MAX = 30;

export const ReaderPrefs = {
  get() {
    const s = Theming.get();
    return {
      size: s.readerSize ?? 20,
      leading: s.readerLeading ?? 1.7,
      focus: s.lineFocus ?? false,
      boldFirst: s.boldFirst ?? false,
      rate: s.ttsRate ?? 1,
      voice: s.ttsVoice ?? "",
    };
  },
};

export function workerUrl() {
  return (Theming.get().workerUrl || DEFAULT_WORKER_URL || "").replace(/\/+$/, "");
}

// ------------------------------------------------------------- fetching
const inflight = new Map();

/** Get extracted article: IndexedDB first, then the Worker. Stores the result. */
export async function getArticle(url, meta = {}, { network = true } = {}) {
  const cached = await DB.get("articles", url);
  if (cached?.data) return { ...cached, fromCache: true };
  if (!network) return null;
  if (inflight.has(url)) return inflight.get(url);

  const base = workerUrl();
  if (!base) throw Object.assign(new Error("Read mode isn't set up yet. Add the Worker URL in Settings."), { code: "no_worker" });

  const p = (async () => {
    const res = await fetch(`${base}/extract?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(25_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw Object.assign(new Error(describeError(data, res.status)), { code: data.error || res.status });
    const rec = {
      url,
      data,
      title: meta.title || data.title,
      outlet: meta.outlet || null,
      storyId: meta.storyId || null,
      cachedAt: Date.now(),
      bytes: JSON.stringify(data).length,
      favorite: false,
    };
    await DB.put("articles", rec);
    return rec;
  })();
  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

function describeError(d, status) {
  switch (d.error) {
    case "unresolved_google_link":
      return "This link still points at Google News, so it can't be extracted yet.";
    case "upstream_status":
      return d.status === 403 || d.status === 401
        ? "The site blocked the reader (it often does for automated requests)."
        : `The site answered with an error (${d.status}).`;
    case "fetch_failed":
      return "The site didn't respond in time.";
    case "no_content":
      return "Couldn't find article text on that page.";
    case "not_html":
      return "That link isn't a web page.";
    case "origin_not_allowed":
      return "The Worker doesn't allow this site yet (check ALLOWED_ORIGINS).";
    default:
      return `Couldn't load the article${status ? ` (${status})` : ""}.`;
  }
}

// -------------------------------------------------------------- render
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;

/** Text node(s) for a string, optionally bolding the first part of each word. */
function textNodes(text, boldFirst) {
  if (!boldFirst) return [document.createTextNode(text)];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(WORD)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const w = m[0];
    const n = w.length <= 3 ? 1 : Math.ceil(w.length * 0.45);
    out.push(h("b", { class: "bfl" }, w.slice(0, n)), document.createTextNode(w.slice(n)));
    last = m.index + w.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function runsToNodes(runs, boldFirst) {
  return runs.map((r) => {
    const parts = r.t.split("\n").flatMap((seg, i) => (i ? [h("br"), ...textNodes(seg, boldFirst)] : textNodes(seg, boldFirst)));
    let node = parts.length === 1 ? parts[0] : h("span", {}, parts);
    if (r.i) node = h("em", {}, node);
    if (r.b) node = h("strong", {}, node);
    if (r.href) node = h("a", { href: r.href, target: "_blank", rel: "noopener noreferrer" }, node);
    return node;
  });
}

const blockText = (b) => (b.runs ? b.runs.map((r) => r.t).join("") : b.items.map((it) => it.map((r) => r.t).join("")).join(". "));

function renderBlocks(blocks, boldFirst) {
  return blocks.map((b, i) => {
    let el;
    switch (b.type) {
      case "h2":
      case "h3":
        el = h(b.type, {}, runsToNodes(b.runs, boldFirst));
        break;
      case "quote":
        el = h("blockquote", {}, runsToNodes(b.runs, boldFirst));
        break;
      case "pre":
        el = h("pre", {}, b.runs[0].t);
        break;
      case "caption":
        el = h("p", { class: "rb-caption" }, runsToNodes(b.runs, boldFirst));
        break;
      case "ul":
      case "ol":
        el = h(b.type, {}, b.items.map((it) => h("li", {}, runsToNodes(it, boldFirst))));
        break;
      default:
        el = h("p", {}, runsToNodes(b.runs, boldFirst));
    }
    el.classList.add("rb");
    el.dataset.i = String(i);
    return el;
  });
}

// -------------------------------------------------------------- speech
function chunk(text, max = 220) {
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) || [text];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (const piece of s.match(new RegExp(`.{1,${max}}(\\s|$)`, "g")) || [s]) out.push(piece.trim());
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function pickVoice(name, lang) {
  const voices = speechSynthesis.getVoices();
  return (
    voices.find((v) => v.name === name) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith((lang || "en").toLowerCase().slice(0, 2)) && v.localService) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith((lang || "en").slice(0, 2))) ||
    null
  );
}

// --------------------------------------------------------------- mount
export function mount(container, { story, article, outletName, timeAgo, onRead }) {
  const prefs = () => ReaderPrefs.get();
  let data = null;
  let current = -1;
  let destroyed = false;
  const tts = { queue: [], pos: 0, playing: false, supported: "speechSynthesis" in window };

  const $body = h("div", { class: "reader-body", lang: "en" });
  const $status = h("div", { class: "reader-status" });
  const $playBtn = h("button", { type: "button", class: "rt-btn rt-play", "aria-label": "Read aloud" }, h("span", { "aria-hidden": "true" }, "▶"), h("span", { class: "rt-lbl" }, "Listen"));
  const $rateBtn = h("button", { type: "button", class: "rt-btn rt-rate", "aria-label": "Reading speed" }, `${prefs().rate}×`);
  const $focusBtn = h("button", { type: "button", class: "rt-btn", "aria-pressed": String(prefs().focus), "aria-label": "Line focus" }, h("span", { "aria-hidden": "true" }, "◎"), h("span", { class: "rt-lbl" }, "Focus"));
  const $aaBtn = h("button", { type: "button", class: "rt-btn", "aria-expanded": "false", "aria-controls": "reader-panel", "aria-label": "Text settings" }, h("span", { "aria-hidden": "true" }, "Aa"));
  const $panel = h("div", { class: "reader-panel", id: "reader-panel", hidden: true });

  const root = h(
    "section",
    { class: "view view-read reader" },
    h(
      "div",
      { class: "reader-head" },
      h("a", { class: "back", href: `#/story/${story.id}` }, "‹ Compare"),
      h("a", { class: "reader-orig", href: article.url, target: "_blank", rel: "noopener noreferrer" }, "Original ↗")
    ),
    h("p", { class: "read-outlet" }, outletName, " · ", h("time", { datetime: article.published }, timeAgo(article.published))),
    h("h2", { class: "read-title" }, article.title),
    $status,
    $body,
    h(
      "div",
      { class: "reader-end" },
      h("a", { class: "btn", href: article.url, target: "_blank", rel: "noopener noreferrer" }, "Open original ↗"),
      h("a", { class: "btn", href: `#/story/${story.id}` }, `Compare ${story.outlet_count} outlets`)
    ),
    h("div", { class: "reader-toolbar", role: "toolbar", "aria-label": "Reader controls" }, $aaBtn, $focusBtn, $playBtn, $rateBtn),
    $panel
  );
  container.replaceChildren(root);
  document.body.dataset.mode = "read";

  // ---- typography
  function applyType() {
    const p = prefs();
    root.style.setProperty("--reader-size", `${p.size}px`);
    root.style.setProperty("--reader-leading", String(p.leading));
    root.classList.toggle("is-focus", p.focus);
    $focusBtn.setAttribute("aria-pressed", String(p.focus));
    $rateBtn.textContent = `${p.rate}×`;
  }
  applyType();

  function drawBody() {
    if (!data) return;
    $body.replaceChildren(...renderBlocks(data.blocks, prefs().boldFirst));
    $body.lang = data.lang || "en";
    setCurrent(current < 0 ? 0 : current, false);
  }

  // ---- line focus
  function blocksEls() {
    return [...$body.querySelectorAll(".rb")];
  }
  function setCurrent(i, scroll = true) {
    const els = blocksEls();
    if (!els.length) return;
    i = Math.max(0, Math.min(els.length - 1, i));
    els[current]?.classList.remove("is-current");
    current = i;
    els[i].classList.add("is-current");
    if (scroll) {
      const rm = document.documentElement.dataset.reduceMotion === "true";
      els[i].scrollIntoView({ block: "center", behavior: rm ? "auto" : "smooth" });
    }
  }
  let raf = 0;
  function onScroll() {
    if (tts.playing || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const y = window.innerHeight * 0.4;
      const els = blocksEls();
      const hit = els.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return r.top <= y && r.bottom >= y;
      });
      if (hit >= 0 && hit !== current) setCurrent(hit, false);
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  $body.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const el = e.target.closest(".rb");
    if (!el) return;
    const i = Number(el.dataset.i);
    setCurrent(i, false);
    if (tts.playing) speakFrom(i);
  });

  // ---- speech
  function buildQueue() {
    tts.queue = [];
    data.blocks.forEach((b, i) => {
      if (b.type === "pre") return;
      for (const text of chunk(blockText(b))) tts.queue.push({ i, text });
    });
    // Lead with the headline.
    tts.queue.unshift({ i: 0, text: article.title, head: true });
  }
  function speakFrom(blockIndex) {
    speechSynthesis.cancel();
    tts.pos = Math.max(0, tts.queue.findIndex((q) => q.i === blockIndex && !q.head));
    tts.playing = true;
    speakNext();
  }
  function speakNext() {
    if (destroyed || !tts.playing) return;
    const item = tts.queue[tts.pos];
    if (!item) return stop(true);
    if (!item.head && item.i !== current) setCurrent(item.i);
    const u = new SpeechSynthesisUtterance(item.text);
    const p = prefs();
    u.rate = p.rate;
    u.lang = data.lang || "en-US";
    const v = pickVoice(p.voice, u.lang);
    if (v) u.voice = v;
    u.onend = () => {
      if (!tts.playing) return;
      tts.pos++;
      speakNext();
    };
    u.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") return;
      stop();
      $status.prepend(h("p", { class: "reader-meta" }, "Read-aloud stopped: this device's speech engine reported an error. Check that a text-to-speech voice is installed."));
    };
    speechSynthesis.speak(u);
    syncPlay();
  }
  function play() {
    if (!data || !tts.supported) return;
    if (!tts.queue.length) buildQueue();
    tts.playing = true;
    // Resume at the focused paragraph (or from the top with the headline).
    if (current > 0) tts.pos = Math.max(0, tts.queue.findIndex((q) => q.i === current && !q.head));
    speechSynthesis.cancel();
    speakNext();
  }
  function stop(finished = false) {
    tts.playing = false;
    speechSynthesis.cancel();
    if (finished) tts.pos = 0;
    syncPlay();
  }
  function syncPlay() {
    $playBtn.classList.toggle("is-playing", tts.playing);
    $playBtn.querySelector("span").textContent = tts.playing ? "❚❚" : "▶";
    $playBtn.querySelector(".rt-lbl").textContent = tts.playing ? "Pause" : "Listen";
    $playBtn.setAttribute("aria-label", tts.playing ? "Pause reading" : "Read aloud");
    root.classList.toggle("is-speaking", tts.playing);
  }
  $playBtn.addEventListener("click", () => (tts.playing ? stop() : play()));
  $rateBtn.addEventListener("click", async () => {
    const r = prefs().rate;
    const next = RATES[(RATES.indexOf(r) + 1) % RATES.length] ?? 1;
    await Theming.set("ttsRate", next);
    applyType();
    if (tts.playing) {
      speechSynthesis.cancel();
      speakNext(); // restart the current chunk at the new speed
    }
  });
  if (!tts.supported) {
    $playBtn.disabled = true;
    $rateBtn.disabled = true;
  }

  $focusBtn.addEventListener("click", async () => {
    await Theming.set("lineFocus", !prefs().focus);
    applyType();
    if (prefs().focus) setCurrent(current, false);
  });

  // ---- Aa panel
  function slider(label, key, min, max, step, value, fmt) {
    const out = h("output", {}, fmt(value));
    const input = h("input", {
      type: "range", min, max, step, value,
      "aria-label": label,
      oninput: (e) => {
        out.textContent = fmt(Number(e.target.value));
        Theming.set(key, Number(e.target.value)).then(applyType);
      },
    });
    return h("label", { class: "rp-row" }, h("span", { class: "rp-label" }, label), input, out);
  }
  function toggle(label, key, value, after) {
    return h(
      "label",
      { class: "check rp-check" },
      h("input", { type: "checkbox", checked: value, onchange: async (e) => { await Theming.set(key, e.target.checked); applyType(); after?.(); } }),
      label
    );
  }
  function drawPanel() {
    const p = prefs();
    const voiceSel = h("select", { class: "rp-select", "aria-label": "Voice", onchange: (e) => Theming.set("ttsVoice", e.target.value) });
    const fillVoices = () => {
      const voices = tts.supported ? speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)) : [];
      voiceSel.replaceChildren(h("option", { value: "" }, "Default voice"), ...voices.map((v) => h("option", { value: v.name, selected: v.name === p.voice }, `${v.name} (${v.lang})`)));
    };
    fillVoices();
    if (tts.supported) speechSynthesis.onvoiceschanged = fillVoices;
    $panel.replaceChildren(
      h("div", { class: "rp-grab", "aria-hidden": "true" }),
      slider("Text size", "readerSize", SIZE_MIN, SIZE_MAX, 1, p.size, (v) => `${v}px`),
      slider("Line spacing", "readerLeading", 1.3, 2.4, 0.1, p.leading, (v) => v.toFixed(1)),
      toggle("Line focus (dim all but the current paragraph)", "lineFocus", p.focus, () => setCurrent(current, false)),
      toggle("Bold first letters", "boldFirst", p.boldFirst, drawBody),
      h("label", { class: "rp-row" }, h("span", { class: "rp-label" }, "Voice"), voiceSel),
      h("button", { type: "button", class: "btn", onclick: () => togglePanel(false) }, "Done")
    );
  }
  function togglePanel(open) {
    open ??= $panel.hidden;
    if (open) drawPanel();
    $panel.hidden = !open;
    $aaBtn.setAttribute("aria-expanded", String(open));
  }
  $aaBtn.addEventListener("click", () => togglePanel());

  // ---- load
  function showStatus(kind, msg) {
    $status.className = `reader-status is-${kind}`;
    $status.replaceChildren(
      ...(kind === "loading"
        ? [h("div", { class: "skeleton" }, h("span"), h("span"), h("span"), h("span"))]
        : [h("p", {}, msg), h("a", { class: "btn btn-primary", href: article.url, target: "_blank", rel: "noopener noreferrer" }, "Open original ↗")])
    );
  }
  if (article.summary) $body.replaceChildren(h("p", { class: "rb read-summary" }, article.summary));
  showStatus("loading");

  getArticle(article.url, { title: article.title, outlet: article.outlet, storyId: story.id })
    .then((rec) => {
      if (destroyed) return;
      data = rec.data;
      $status.replaceChildren();
      $status.className = "reader-status";
      if (data.partial) showStatus("partial", "This looks like partial text, probably a paywall or a page the reader couldn't fully parse.");
      const meta = [data.byline, rec.fromCache ? "Saved on this device" : null].filter(Boolean).join(" · ");
      if (meta) $status.prepend(h("p", { class: "reader-meta" }, meta));
      drawBody();
      onRead?.();
    })
    .catch((err) => {
      if (destroyed) return;
      showStatus("error", err.message || "Couldn't load the article.");
    });

  return () => {
    destroyed = true;
    stop();
    window.removeEventListener("scroll", onScroll);
    delete document.body.dataset.mode;
    if (tts.supported) speechSynthesis.onvoiceschanged = null;
  };
}
