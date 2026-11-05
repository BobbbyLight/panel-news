import { test } from "node:test";
import assert from "node:assert/strict";
import { extract } from "../src/extract.js";

const para = (n) =>
  Array.from({ length: n }, (_, i) =>
    `<p>Paragraph ${i + 1}: Lawmakers met on Tuesday to debate the measure, which <a href="/related/${i}">critics say</a> would reshape how the state funds <strong>public schools</strong> and <em>local transit</em> over the next decade.</p>`
  ).join("\n");

const NEWS = `<!doctype html><html lang="en"><head>
<title>Senate passes budget | Example News</title>
<meta property="og:site_name" content="Example News">
<meta property="article:published_time" content="2026-11-05T12:00:00Z">
<script type="application/ld+json">{"@type":"NewsArticle","headline":"Senate passes budget","author":[{"@type":"Person","name":"Jane Doe"}],"datePublished":"2026-11-05T12:00:00Z"}</script>
<script>window.tracker = { a: 1 }; document.write("<p>junk</p>")</script>
<style>.x{color:red}</style>
</head><body>
<header><nav><a href="/">Home</a><a href="/politics">Politics</a></nav></header>
<main><article>
<h1>Senate passes budget</h1>
<p class="byline">By Jane Doe</p>
<figure><img src="https://cdn.example.com/a.jpg" onerror="alert(1)"><figcaption>The Senate chamber on Tuesday.</figcaption></figure>
${para(6)}
<div class="ad">Advertisement</div>
<p>Advertisement</p>
<h2>What happens next</h2>
<ul><li>The House votes Friday.</li><li>The governor has 10 days to sign.</li></ul>
<blockquote><p>"This is a good day for the state," the majority leader said.</p></blockquote>
${para(3)}
<iframe src="https://evil.example/x"></iframe>
<p>Read more:</p>
</article></main>
<aside><p>Most popular: something unrelated entirely and long enough to look like content maybe</p></aside>
<footer>© Example</footer>
</body></html>`;

test("extracts article body as structured blocks", () => {
  const a = extract(NEWS, "https://example.com/politics/budget");
  assert.equal(a.title, "Senate passes budget");
  assert.equal(a.siteName, "Example News");
  assert.equal(a.published, "2026-11-05T12:00:00Z");
  assert.equal(a.lang, "en");
  assert.equal(a.partial, false);
  const types = a.blocks.map((b) => b.type);
  assert.ok(types.filter((t) => t === "p").length >= 9, types.join(","));
  assert.ok(types.includes("h2"));
  assert.ok(types.includes("ul"));
  assert.ok(types.includes("quote"));
  const text = JSON.stringify(a.blocks);
  assert.ok(!/tracker|junk|Advertisement|Read more|evil\.example|onerror|cdn\.example/.test(text), "clutter leaked");
  assert.ok(!text.includes("<"), "no markup in output");
});

test("keeps bold/italic/link marks with absolute hrefs", () => {
  const a = extract(NEWS, "https://example.com/politics/budget");
  const runs = a.blocks.find((b) => b.type === "p" && b.runs.some((r) => r.href)).runs;
  assert.ok(runs.some((r) => r.href === "https://example.com/related/0"));
  assert.ok(runs.some((r) => r.b && r.t === "public schools"));
  assert.ok(runs.some((r) => r.i && r.t === "local transit"));
});

test("flags paywalled stubs as partial", () => {
  const html = `<html><body><article><h1>Big story</h1><p>The first paragraph of the story is visible to everyone and sets the scene briefly.</p>
  <div class="paywall">Subscribe to continue reading. Already a subscriber? Sign in.</div></article></body></html>`;
  const a = extract(html, "https://paywalled.example/story");
  assert.equal(a.partial, true);
});

test("falls back to JSON-LD articleBody when the DOM is thin", () => {
  const body = Array.from({ length: 8 }, (_, i) => `Sentence block ${i} with enough words to count as real article text for the reader.`).join("\\n");
  const html = `<html><head><script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","headline":"JS rendered","articleBody":"${body}","isAccessibleForFree":true}]}</script></head>
  <body><div id="root"></div></body></html>`;
  const a = extract(html, "https://spa.example/a");
  assert.equal(a.title, "JS rendered");
  assert.equal(a.blocks.length, 8);
});

test("rejects javascript: links", () => {
  const html = `<html><body><article>${para(5)}<p>See <a href="javascript:alert(1)">this</a> and keep reading this long enough paragraph about the budget vote.</p></article></body></html>`;
  const a = extract(html, "https://example.com/x");
  assert.ok(!JSON.stringify(a).includes("javascript:"));
});
