/**
 * extract.js — HTML page -> clean article as structured blocks.
 *
 * Output is data, not HTML: the PWA builds DOM from it with textContent, so
 * nothing from a publisher page is ever parsed as markup on the device.
 *
 *   { title, byline, siteName, published, lang, excerpt,
 *     blocks: [{type:"p"|"h2"|"h3"|"quote"|"pre"|"caption", runs:[Run]},
 *              {type:"ul"|"ol", items:[[Run]]}],
 *     textLength, partial }
 *   Run = { t: string, b?: true, i?: true, href?: string }
 *
 * Images are dropped on purpose: loading them would send the reader's IP to
 * publisher/ad image hosts at read time.
 */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const MAX_HTML = 2_500_000;

// Bulk that Readability never needs; removing it up front keeps CPU time
// inside the Workers free-plan budget.
const STRIP = [
  /<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
  /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
  /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
  /<template\b[^>]*>[\s\S]*?<\/template>/gi,
  /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
  /<!--[\s\S]*?-->/g,
  /\sstyle="[^"]*"/gi,
  /\sdata-[\w-]+="[^"]*"/gi,
];

const BOILER = /^(advertisement|ad|sponsored|story continues below( advertisement)?|continue reading|read more:?|related:?|recommended:?|sign up\b.*|subscribe\b.*newsletter.*|click here\b.*|share this\b.*|copy link)$/i;

const PAYWALL = /subscribe to (continue|read)|subscriber[- ]only|already a subscriber|to continue reading|create a free account to (continue|read)|this article is for subscribers/i;

const BLOCK = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "FIGCAPTION", "UL", "OL", "LI", "TABLE"]);
const SKIP = new Set(["IMG", "PICTURE", "VIDEO", "AUDIO", "SOURCE", "BUTTON", "FORM", "INPUT", "SELECT", "TEXTAREA", "NAV", "ASIDE", "FOOTER", "HEADER", "SCRIPT", "STYLE", "SVG", "CANVAS", "OBJECT", "EMBED"]);

function jsonLd(html) {
  const out = {};
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const nodes = [].concat(data, data?.["@graph"] || []).flat();
    for (const n of nodes) {
      const type = [].concat(n?.["@type"] || []).join(" ");
      if (!/Article|NewsArticle|Report|BlogPosting/i.test(type)) continue;
      out.headline ??= n.headline;
      out.datePublished ??= n.datePublished;
      out.articleBody ??= typeof n.articleBody === "string" ? n.articleBody : undefined;
      const a = [].concat(n.author || []).map((x) => (typeof x === "string" ? x : x?.name)).filter(Boolean);
      if (a.length) out.author ??= a.join(", ");
      if (n.isAccessibleForFree !== undefined) out.free ??= !/^(false|0)$/i.test(String(n.isAccessibleForFree));
    }
  }
  return out;
}

function absUrl(href, base) {
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Collect inline runs under `node`, applying bold/italic/link marks. */
function runsOf(node, base, marks = {}, out = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const t = child.textContent.replace(/\s+/g, " ");
      if (t) out.push({ t, ...marks });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (SKIP.has(tag)) continue;
    if (tag === "BR") {
      out.push({ t: "\n" });
      continue;
    }
    const m = { ...marks };
    if (tag === "B" || tag === "STRONG") m.b = true;
    if (tag === "I" || tag === "EM") m.i = true;
    if (tag === "A") {
      const href = absUrl(child.getAttribute("href") || "", base);
      if (href) m.href = href;
    }
    runsOf(child, base, m, out);
  }
  return out;
}

function tidy(runs) {
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.b === r.b && prev.i === r.i && prev.href === r.href) prev.t += r.t;
    else merged.push({ ...r });
  }
  if (merged.length) {
    merged[0].t = merged[0].t.replace(/^\s+/, "");
    merged[merged.length - 1].t = merged[merged.length - 1].t.replace(/\s+$/, "");
  }
  for (const r of merged) {
    r.t = r.t.replace(/ *\n */g, "\n");
    for (const k of ["b", "i", "href"]) if (!r[k]) delete r[k];
  }
  return merged.filter((r) => r.t);
}

const textOf = (runs) => runs.map((r) => r.t).join("");

function toBlocks(root, base) {
  const blocks = [];
  let loose = [];
  const flush = () => {
    const runs = tidy(loose);
    loose = [];
    if (textOf(runs).trim()) blocks.push({ type: "p", runs });
  };
  const push = (type, runs) => {
    runs = tidy(runs);
    const text = textOf(runs).trim();
    if (!text || (type === "p" && text.length < 80 && BOILER.test(text))) return;
    blocks.push({ type, runs });
  };

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.textContent.trim()) loose.push({ t: child.textContent.replace(/\s+/g, " ") });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (SKIP.has(tag)) continue;
      if (!BLOCK.has(tag)) {
        // Inline element directly in a container: part of a loose paragraph.
        if (/^(A|B|STRONG|I|EM|SPAN|SMALL|SUP|SUB|MARK|CODE|Q|CITE|ABBR|TIME)$/.test(tag)) {
          loose.push(...runsOf({ childNodes: [child] }, base));
        } else {
          flush();
          walk(child);
          flush();
        }
        continue;
      }
      flush();
      if (tag === "UL" || tag === "OL") {
        const items = [...child.children]
          .filter((li) => li.tagName === "LI")
          .map((li) => tidy(runsOf(li, base)))
          .filter((r) => textOf(r).trim());
        if (items.length) blocks.push({ type: tag.toLowerCase(), items });
      } else if (tag === "LI") {
        push("p", runsOf(child, base));
      } else if (/^H[1-6]$/.test(tag)) {
        push(tag === "H1" || tag === "H2" ? "h2" : "h3", runsOf(child, base));
      } else if (tag === "BLOCKQUOTE") {
        // Quotes often wrap <p>s; keep them as one quote block per paragraph.
        const ps = child.querySelectorAll("p");
        if (ps.length) ps.forEach((p) => push("quote", runsOf(p, base)));
        else push("quote", runsOf(child, base));
      } else if (tag === "PRE") {
        blocks.push({ type: "pre", runs: [{ t: child.textContent }] });
      } else if (tag === "FIGCAPTION") {
        push("caption", runsOf(child, base));
      } else if (tag === "TABLE") {
        child.querySelectorAll("tr").forEach((tr) => push("p", runsOf(tr, base)));
      } else {
        push("p", runsOf(child, base));
      }
    }
  };
  walk(root);
  flush();
  return blocks;
}

function blocksFromPlain(text) {
  return text
    .split(/\n{1,}/)
    .map((s) => s.trim())
    .filter((s) => s && !BOILER.test(s))
    .map((t) => ({ type: "p", runs: [{ t }] }));
}

const blocksLength = (blocks) =>
  blocks.reduce((n, b) => n + (b.runs ? textOf(b.runs).length : b.items.reduce((m, it) => m + textOf(it).length, 0)), 0);

export function extract(rawHtml, url) {
  let html = rawHtml.length > MAX_HTML ? rawHtml.slice(0, MAX_HTML) : rawHtml;
  const ld = jsonLd(html);
  const paywallHint = PAYWALL.test(html);
  for (const re of STRIP) html = html.replace(re, "");

  const { document } = parseHTML(html);
  const lang = document.documentElement?.getAttribute("lang") || null;
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || null;
  const siteName = meta('meta[property="og:site_name"]');
  const published = ld.datePublished || meta('meta[property="article:published_time"]');

  let article = null;
  try {
    article = new Readability(document, { charThreshold: 300, keepClasses: false }).parse();
  } catch {
    article = null;
  }

  let blocks = [];
  if (article?.content) {
    const { document: frag } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
    blocks = toBlocks(frag.body, url);
  }
  // Many news sites ship the full text in JSON-LD; prefer it when Readability came up short.
  if (ld.articleBody && ld.articleBody.length > blocksLength(blocks) * 1.3) {
    blocks = blocksFromPlain(ld.articleBody);
  }

  const textLength = blocksLength(blocks);
  const partial = textLength < 700 || (ld.free === false && textLength < 2500) || (paywallHint && textLength < 2500);

  return {
    title: ld.headline || meta('meta[property="og:title"]') || article?.title || document.querySelector("title")?.textContent?.trim() || null,
    byline: article?.byline || ld.author || null,
    siteName: article?.siteName || siteName,
    published,
    lang,
    excerpt: article?.excerpt || meta('meta[name="description"]'),
    blocks,
    textLength,
    partial,
  };
}
