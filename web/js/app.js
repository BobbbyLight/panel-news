/**
 * app.js — hash router + views. No framework: a tiny h() helper builds DOM
 * nodes so feed text is only ever set as textContent (never innerHTML).
 *
 * Routes:
 *   #/            Today: the top clusters, then a "caught up" stop
 *   #/more        everything else with 2+ outlets, then single-outlet items
 *   #/blind       blindspots (one side silent)
 *   #/story/:id   5/5/5 side-by-side comparison
 *   #/read/:id/:outlet   Read mode (step 4)
 *   #/settings
 */
import { DB } from "./db.js";
import { Theming, THEMES } from "./theming.js";
import { Data, LEANS, LEAN_LABEL, loadStories, timeAgo } from "./data.js";
import { markHeadline } from "./loaded.js";
import { mount as mountReader, workerUrl } from "./reader.js";

const TODAY_COUNT = 15;
const VIEWS = [
  { id: "standard", label: "Standard", icon: "☰" },
  { id: "compact", label: "Compact", icon: "≡" },
  { id: "cards", label: "Cards", icon: "▦" },
];

const $main = document.getElementById("main");
const $status = document.getElementById("status");
let readIds = new Set();

// ---------------------------------------------------------------- helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function transition(fn) {
  const rm = document.documentElement.dataset.reduceMotion === "true";
  if (!rm && document.startViewTransition) {
    const t = document.startViewTransition(fn);
    t.ready.catch(() => {});
    t.finished.catch(() => {});
  }
  else fn();
}

const outletName = (id) => Data.outlet(id)?.name || id;

// ------------------------------------------------------------ coverage bar
function coverageBar(story, { size = "sm", labels = false } = {}) {
  const c = story.coverage;
  const label = `Covered by ${story.outlet_count} of 15: ${c.left} left, ${c.neutral} neutral, ${c.right} right`;
  const groups = LEANS.map((lean, g) =>
    h(
      "span",
      { class: `cov-group cov-${lean}` },
      story.slots.slice(g * 5, g * 5 + 5).map((on, i) =>
        h("span", { class: "cov-cell" + (on ? " is-on" : ""), style: `--i:${g * 5 + i}` })
      )
    )
  );
  const bar = h("span", { class: `cov cov--${size}`, role: "img", "aria-label": label, title: label }, groups);
  if (!labels) return bar;
  return h(
    "div",
    { class: "cov-labelled" },
    bar,
    h("div", { class: "cov-legend" }, LEANS.map((l) => h("span", { class: `cov-legend-item cov-${l}` }, `${LEAN_LABEL[l]} ${c[l]}`)))
  );
}

// ------------------------------------------------------------- list items
function storyItem(story) {
  const lead = Data.leadArticle(story);
  const unread = !readIds.has(story.id);
  const view = Theming.get().view;
  const readHref = `#/read/${story.id}/${lead.outlet}`;
  const storyHref = `#/story/${story.id}`;
  const meta = h(
    "div",
    { class: "item-meta" },
    h("span", { class: "item-outlet" }, outletName(lead.outlet)),
    h("span", { class: "item-dot", "aria-hidden": "true" }, "·"),
    h("time", { datetime: story.updated }, timeAgo(story.updated))
  );
  const covBtn = h(
    "a",
    { class: "item-cov", href: storyHref, "aria-label": `Compare ${story.outlet_count} outlets` },
    coverageBar(story),
    h("span", { class: "item-count" }, String(story.outlet_count))
  );
  const blind = story.blindspot
    ? h("span", { class: `chip chip-blind cov-${story.blindspot}` }, `${LEAN_LABEL[story.blindspot]} blindspot`)
    : null;

  return h(
    "article",
    { class: "item" + (unread ? " is-unread" : " is-read"), dataset: { id: story.id } },
    unread ? h("span", { class: "unread-dot", "aria-label": "unread" }) : null,
    h("a", { class: "item-headline", href: readHref }, story.title),
    view === "cards" && lead.summary ? h("p", { class: "item-summary" }, lead.summary) : null,
    h("div", { class: "item-foot" }, meta, blind, covBtn)
  );
}

function list(stories) {
  return h("div", { class: "list" }, stories.map(storyItem));
}

function partition() {
  const all = Data.data.stories;
  const multi = all.filter((s) => s.outlet_count >= 2);
  return {
    today: multi.slice(0, TODAY_COUNT),
    more: multi.slice(TODAY_COUNT),
    singles: all.filter((s) => s.outlet_count < 2),
  };
}

// ------------------------------------------------------------------ views
function viewToday() {
  const { today } = partition();
  const left = today.filter((s) => !readIds.has(s.id)).length;
  return h(
    "section",
    { class: "view view-today" },
    h("h2", { class: "view-title" }, "Today", h("span", { class: "view-sub" }, `${today.length} stories · ${left} unread`)),
    list(today),
    h(
      "div",
      { class: "caught-up" },
      h("div", { class: "caught-up-art", "aria-hidden": "true" }, h("span"), h("span"), h("span")),
      h("h3", {}, "You're caught up"),
      h("p", {}, "That's the day's top stories across the panel."),
      h("a", { class: "btn", href: "#/more" }, "Browse more")
    )
  );
}

function viewMore() {
  const { more, singles } = partition();
  return h(
    "section",
    { class: "view view-more" },
    h("h2", { class: "view-title" }, "More", h("span", { class: "view-sub" }, `${more.length} multi-outlet stories`)),
    list(more),
    singles.length
      ? h(
          "details",
          { class: "singles" },
          h("summary", {}, `Single-outlet stories (${singles.length})`),
          list(singles)
        )
      : null
  );
}

function viewBlind() {
  const stories = Data.data.stories.filter((s) => s.blindspot);
  const side = (lean) => stories.filter((s) => s.blindspot === lean);
  const block = (lean) =>
    h(
      "div",
      { class: "blind-block" },
      h("h3", { class: `blind-head cov-${lean}` }, `${LEAN_LABEL[lean]} isn't covering`),
      side(lean).length ? list(side(lean)) : h("p", { class: "muted" }, "Nothing right now.")
    );
  return h(
    "section",
    { class: "view view-blind" },
    h("h2", { class: "view-title" }, "Blindspots"),
    h("p", { class: "muted" }, "Stories with 4+ outlets where one side of the panel has published nothing."),
    block("left"),
    block("right")
  );
}

function viewStory(id) {
  const story = Data.story(id);
  if (!story) return notFound();
  DB.markRead(id).then(() => readIds.add(id));
  const slots = Data.slotsFor(story);
  const neutralTitles = story.articles.filter((a) => a.lean === "neutral").map((a) => a.title);
  const showDiff = Boolean(Theming.get().diffHighlight);

  const col = (lean) =>
    h(
      "div",
      { class: `cmp-col cov-${lean}` },
      h("h3", { class: "cmp-head" }, LEAN_LABEL[lean], h("span", { class: "cmp-count" }, `${story.coverage[lean]}/5`)),
      slots
        .filter((s) => s.lean === lean)
        .map(({ outlet, article }) =>
          article
            ? h(
                "a",
                { class: "cmp-cell", href: `#/read/${story.id}/${outlet.id}` },
                h("span", { class: "cmp-outlet" }, outlet.name, h("time", {}, timeAgo(article.published))),
                h(
                  "span",
                  { class: "cmp-title" },
                  markHeadline(article.title, lean, neutralTitles, story.articles.filter((x) => x !== article).map((x) => x.title)).map((seg) =>
                    seg.kind && (showDiff || seg.kind === "charged") ? h("mark", { class: `mk-${seg.kind}` }, seg.text) : seg.text
                  )
                )
              )
            : h("div", { class: "cmp-cell is-empty" }, h("span", { class: "cmp-outlet" }, outlet.name), h("span", { class: "cmp-none" }, "No story"))
        )
    );

  return h(
    "section",
    { class: "view view-story" },
    h("a", { class: "back", href: "#/", onclick: backClick }, "‹ Back"),
    h("h2", { class: "story-title" }, story.title),
    coverageBar(story, { size: "lg", labels: true }),
    story.blindspot
      ? h("p", { class: `blind-note cov-${story.blindspot}` }, `Blindspot: no ${story.blindspot}-leaning outlet on the panel has covered this.`)
      : null,
    h(
      "div",
      { class: "mk-legend muted" },
      h("span", {}, h("mark", { class: "mk-charged" }, "charged"), " words are always marked."),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: showDiff,
          onchange: async (e) => {
            await Theming.set("diffHighlight", e.target.checked);
            render();
          },
        }),
        h("span", {}, "Also mark ", h("mark", { class: "mk-diff" }, "wording"), " the neutral outlets didn't use")
      )
    ),
    h("div", { class: "cmp" }, LEANS.map(col)),
    story.more.length
      ? h(
          "details",
          { class: "story-more" },
          h("summary", {}, `${story.more.length} more from the same outlets`),
          h(
            "ul",
            {},
            story.more.map((a) =>
              h("li", {}, h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, a.title), h("span", { class: "muted" }, ` — ${outletName(a.outlet)}`))
            )
          )
        )
      : null
  );
}

function viewRead(id, outletId) {
  const story = Data.story(id);
  const article = story?.articles.find((a) => a.outlet === outletId);
  if (!article) return notFound();
  const holder = h("div", { class: "read-holder" });
  // Mount after the holder is in the DOM so scroll/focus maths work.
  queueMicrotask(() => {
    cleanup = mountReader(holder, {
      story,
      article,
      outletName: outletName(outletId),
      timeAgo,
      onRead: () => DB.markRead(id).then(() => readIds.add(id)),
    });
  });
  return holder;
}

function viewSettings() {
  const s = Theming.get();
  const seg = (key, options) =>
    h(
      "div",
      { class: "seg", role: "radiogroup" },
      options.map(([value, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": String(s[key] === value),
            class: "seg-btn" + (s[key] === value ? " is-selected" : ""),
            onclick: async () => {
              await Theming.set(key, value);
              render();
            },
          },
          label
        )
      )
    );

  const health = h("div", { class: "health" }, h("p", { class: "muted" }, "Loading feed status…"));
  fetch(`feeds-health.json?t=${Date.now()}`)
    .then((r) => r.json())
    .then((d) => {
      health.replaceChildren(
        h("p", { class: "muted" }, `${d.healthy}/15 feeds healthy · checked ${timeAgo(d.generated_at)} ago`),
        h(
          "ul",
          { class: "health-list" },
          d.outlets.map((o) =>
            h(
              "li",
              { class: o.ok ? "" : "is-down" },
              h("span", { class: `health-dot cov-${o.lean}` }),
              h("span", { class: "health-name" }, o.name),
              h("span", { class: "muted" }, o.ok ? `${o.recent_24h} today · ${o.via}${o.fallback ? " (fallback)" : ""}` : "no recent items")
            )
          )
        )
      );
    })
    .catch(() => health.replaceChildren(h("p", { class: "muted" }, "Feed status unavailable offline.")));

  return h(
    "section",
    { class: "view view-settings" },
    h("h2", { class: "view-title" }, "Settings"),
    h(
      "div",
      { class: "set-section" },
      h("h3", {}, "Theme"),
      h(
        "div",
        { class: "swatches" },
        THEMES.map((t) =>
          h(
            "button",
            {
              type: "button",
              class: "swatch" + (s.theme === t.id ? " is-selected" : ""),
              dataset: { themeId: t.id },
              "aria-label": t.label,
              "aria-pressed": String(s.theme === t.id),
              onclick: async () => {
                await Theming.set("theme", t.id);
                render();
              },
            },
            h("span", { class: "swatch-dot" }),
            h("span", { class: "swatch-label" }, t.label)
          )
        )
      )
    ),
    h("div", { class: "set-section" }, h("h3", {}, "Flair"), seg("flair", [["subtle", "Subtle"], ["max", "Max"]])),
    h(
      "div",
      { class: "set-section" },
      h("h3", {}, "Motion"),
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: s.reduceMotion,
          onchange: (e) => Theming.set("reduceMotion", e.target.checked),
        }),
        "Reduce motion (turns off all animation)"
      )
    ),
    h("div", { class: "set-section" }, h("h3", {}, "List view"), seg("view", VIEWS.map((v) => [v.id, v.label]))),
    h(
      "div",
      { class: "set-section" },
      h("h3", {}, "Font"),
      seg("font", [["atkinson", "Atkinson Hyperlegible"], ["opendyslexic", "OpenDyslexic"]])
    ),
    h(
      "div",
      { class: "set-section" },
      h("h3", {}, "Read mode"),
      h("p", { class: "muted small" }, "Cloudflare Worker that extracts article text. Not a secret: it only answers this site."),
      h("input", {
        class: "text-input",
        type: "url",
        inputmode: "url",
        placeholder: "https://panel-news-reader.<you>.workers.dev",
        value: s.workerUrl || "",
        "aria-label": "Worker URL",
        onchange: (e) => Theming.set("workerUrl", e.target.value.trim()),
      }),
      h("p", { class: "muted small" }, workerUrl() ? `Using ${workerUrl()}` : "Not set: articles open as summary + link.")
    ),
    h("div", { class: "set-section" }, h("h3", {}, "Feeds"), health),
    h(
      "p",
      { class: "muted small" },
      "Everything you do here stays on this device (IndexedDB). No accounts, no analytics."
    )
  );
}

function notFound() {
  return h(
    "section",
    { class: "view" },
    h("h2", {}, "That story has rolled off"),
    h("p", { class: "muted" }, "Stories leave the panel after 48 hours."),
    h("a", { class: "btn", href: "#/" }, "Back to Today")
  );
}

function backClick(e) {
  if (history.length > 1) {
    e.preventDefault();
    history.back();
  }
}

// ----------------------------------------------------------------- router
const scrollMemo = new Map();

function route() {
  const [, name = "", a, b] = location.hash.replace(/^#/, "").split("/");
  switch (name) {
    case "":
      return ["today", viewToday];
    case "more":
      return ["more", viewMore];
    case "blind":
      return ["blind", viewBlind];
    case "story":
      return ["story", () => viewStory(a)];
    case "read":
      return ["read", () => viewRead(a, b)];
    case "settings":
      return ["settings", viewSettings];
    default:
      return ["today", viewToday];
  }
}

let lastKey = location.hash;
let cleanup = null;
function render({ animate = false } = {}) {
  cleanup?.();
  cleanup = null;
  const [tab, view] = route();
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", String(t.dataset.tab === tab)));
  if (!Data.data && tab !== "settings") {
    $main.replaceChildren(h("div", { class: "loading" }, h("span"), h("span"), h("span")));
    return;
  }
  const draw = () => $main.replaceChildren(view());
  animate ? transition(draw) : draw();
}

window.addEventListener("hashchange", () => {
  scrollMemo.set(lastKey, window.scrollY);
  lastKey = location.hash;
  render({ animate: true });
  window.scrollTo(0, scrollMemo.get(location.hash) || 0);
});

// ------------------------------------------------------------------ status
function renderStatus() {
  if (!Data.data) return;
  const age = timeAgo(Data.data.generated_at);
  $status.textContent = Data.offline ? `Offline · showing data from ${age} ago` : `Updated ${age} ago`;
}

// ------------------------------------------------------------------- boot
document.getElementById("view-btn").addEventListener("click", async () => {
  const i = VIEWS.findIndex((v) => v.id === Theming.get().view);
  const next = VIEWS[(i + 1) % VIEWS.length];
  await Theming.set("view", next.id);
  document.getElementById("view-btn").setAttribute("aria-label", `List view: ${next.label}. Tap to change.`);
  transition(() => render());
});

document.getElementById("refresh-btn").addEventListener("click", () => refresh());

async function refresh() {
  document.body.classList.add("is-refreshing");
  try {
    await loadStories({ bust: true });
  } catch {
    /* status line shows the failure */
  }
  document.body.classList.remove("is-refreshing");
  renderStatus();
  render({ animate: true });
}

async function boot() {
  await Theming.init();
  readIds = await DB.readIds();
  DB.pruneReads();
  render();
  try {
    await loadStories();
  } catch (err) {
    $main.replaceChildren(
      h("section", { class: "view" }, h("h2", {}, "Couldn't load stories"), h("p", { class: "muted" }, String(err.message || err)), h("button", { class: "btn", onclick: () => refresh() }, "Try again"))
    );
    return;
  }
  renderStatus();
  render();
  setInterval(renderStatus, 60_000);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
