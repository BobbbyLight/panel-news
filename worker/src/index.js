/**
 * Panel News read-mode Worker.
 *
 *   GET /extract?url=<article url>  ->  JSON (see extract.js)
 *   GET /                           ->  {"ok": true}
 *
 * Only answers browsers on ALLOWED_ORIGINS (CORS + an Origin check, so it is
 * not an open proxy for random sites), only fetches public http(s) URLs, and
 * caches results at the edge for 6 hours.
 */
import { extract } from "./extract.js";

const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const CACHE_SECONDS = 6 * 3600;
const FETCH_TIMEOUT_MS = 12_000;

function allowedOrigin(req, env) {
  const origin = req.headers.get("Origin");
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origin && list.includes(origin)) return origin;
  if (env.DEV === "1" && (!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) return origin || "*";
  return null;
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? `public, max-age=${CACHE_SECONDS}` : "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(origin ? cors(origin) : {}),
      ...extra,
    },
  });
}

/** Reject anything that isn't a public http(s) host. */
function checkTarget(raw, env) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (env.DEV === "1" && (h === "localhost" || h === "127.0.0.1")) return u;
  if (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    !h.includes(".") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(h) || // bare IPv4
    h.startsWith("[") // bare IPv6
  )
    return null;
  if (u.port && !["80", "443"].includes(u.port)) return null;
  return u;
}

async function handleExtract(req, env, ctx, origin) {
  const target = checkTarget(new URL(req.url).searchParams.get("url") || "", env);
  if (!target) return json({ error: "bad_url" }, 400, origin);

  // Edge cache keyed on the target only (not the Origin), so one fetch serves repeats.
  const cacheKey = new Request(`https://panel-news-cache.invalid/extract?u=${encodeURIComponent(target.href)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = await hit.text();
    return new Response(body, { status: 200, headers: { ...Object.fromEntries(hit.headers), ...cors(origin), "X-Cache": "HIT" } });
  }

  let res;
  try {
    res = await fetch(target.href, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    return json({ error: "fetch_failed", detail: String(err?.name || err) }, 502, origin);
  }

  const finalUrl = res.url || target.href;
  if (new URL(finalUrl).hostname === "news.google.com") {
    return json({ error: "unresolved_google_link", finalUrl }, 422, origin);
  }
  if (!res.ok) return json({ error: "upstream_status", status: res.status, finalUrl }, 502, origin);
  const type = res.headers.get("content-type") || "";
  if (!/html|xml/i.test(type)) return json({ error: "not_html", type, finalUrl }, 415, origin);

  let article;
  try {
    article = extract(await res.text(), finalUrl);
  } catch (err) {
    return json({ error: "extract_failed", detail: String(err?.message || err).slice(0, 200), finalUrl }, 500, origin);
  }
  if (!article.blocks.length) return json({ error: "no_content", finalUrl, partial: true }, 422, origin);

  const body = { url: target.href, finalUrl, fetchedAt: new Date().toISOString(), ...article };
  const out = json(body, 200, origin, { "X-Cache": "MISS" });
  // Store without CORS headers; they are re-added per request above.
  ctx.waitUntil(
    cache.put(cacheKey, json(body, 200, null))
  );
  return out;
}

export default {
  async fetch(req, env, ctx) {
    const origin = allowedOrigin(req, env);
    if (req.method === "OPTIONS") {
      return origin ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    }
    if (req.method !== "GET") return json({ error: "method" }, 405, origin);
    const path = new URL(req.url).pathname;
    if (path === "/") return json({ ok: true }, 200, origin || "*");
    if (!origin) return json({ error: "origin_not_allowed" }, 403, null);
    if (path === "/extract") return handleExtract(req, env, ctx, origin);
    return json({ error: "not_found" }, 404, origin);
  },
};
