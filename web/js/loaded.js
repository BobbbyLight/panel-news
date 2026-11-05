/**
 * loaded.js — flags loaded/charged wording in a cluster's headlines.
 *
 * Two signals, deliberately simple:
 *   1. "diff": content words in a partisan headline that appear in none of the
 *      cluster's neutral headlines (the wire/public-broadcaster framing is the
 *      baseline). Only used when the cluster has neutral coverage.
 *   2. "charged": a small lexicon of words that are loaded in almost any
 *      headline (slams, radical, meltdown…). Applies to every headline.
 */

const STOP = new Set(
  ("a an the and or but of to in on at for from by with as is are was were be been being it its this that these those " +
    "after before over under into about than then so not no yes his her their our your my he she they we you i " +
    "will would can could may might must should has have had do does did says said say new more most just now up " +
    "out off what who why how when where which while amid via vs us u.s if all any some its it's didnt didn't dont won't wont isn't " +
    "get gets got make makes made take takes took turn turns turned look looks happen happens go goes going come comes back one two first").split(" ")
);

const CHARGED = [
  "slam", "slams", "slammed", "blast", "blasts", "blasted", "rip", "rips", "ripped", "torch", "torches",
  "destroy", "destroys", "destroyed", "obliterate", "obliterates", "eviscerate", "eviscerates", "annihilate",
  "annihilated", "crush", "crushes", "humiliate", "humiliates", "humiliating", "humiliation", "shred", "shreds",
  "meltdown", "melts", "unhinged", "deranged", "insane", "crazy", "bizarre", "shocking", "stunning", "bombshell",
  "explosive", "chaos", "chaotic", "disaster", "disastrous", "catastrophe", "catastrophic", "carnage", "bloodbath",
  "radical", "extremist", "extreme", "far-left", "far-right", "leftist", "leftists", "woke", "maga", "socialist",
  "communist", "marxist", "fascist", "authoritarian", "regime", "thug", "thugs", "mob", "cabal", "elites",
  "scheme", "scam", "hoax", "lies", "lie", "liar", "lying", "smear", "smears", "propaganda", "gaslighting",
  "brag", "brags", "bragged", "gloat", "gloats", "whine", "whines", "rant", "rants", "tirade", "screed",
  "outrage", "outraged", "furious", "fury", "panic", "panics", "terrified", "cowardly", "coward", "pathetic",
  "disgraceful", "disgrace", "shameful", "absurd", "ridiculous", "laughable", "embarrassing", "dumb", "stupid",
  "drubbing", "rout", "wipeout", "tsunami", "landslide", "crushing", "devastating", "sweeping",
];
const CHARGED_SET = new Set(CHARGED);

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
const norm = (w) => w.toLowerCase().replace(/[’']s$/, "").replace(/[’']/g, "");
// Cheap stemming so "ballroom"/"ballrooms", "attack"/"attacked" match.
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");

function contentWords(text) {
  return (text.match(WORD_RE) || []).map(norm).filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * otherTitles: every other headline in the cluster (any lean).
 * Returns an array of {text, kind} segments for a headline, where kind is
 * null | "diff" | "charged".
 */
export function markHeadline(title, lean, neutralTitles, otherTitles = []) {
  const baseline = new Set(neutralTitles.flatMap(contentWords).map(stem));
  // Vocabulary shared by 2+ other headlines is the story's own subject matter
  // ("midterm", "Republicans"), not framing, even if the wires skipped it.
  const counts = new Map();
  for (const t of otherTitles) for (const w of new Set(contentWords(t).map(stem))) counts.set(w, (counts.get(w) || 0) + 1);
  for (const [w, n] of counts) if (n >= 2) baseline.add(w);
  const useDiff = lean !== "neutral" && baseline.size > 0;
  const out = [];
  let last = 0;
  for (const m of title.matchAll(WORD_RE)) {
    const w = norm(m[0]);
    let kind = null;
    if (CHARGED_SET.has(w)) kind = "charged";
    else if (useDiff && w.length > 3 && !STOP.has(w) && !baseline.has(stem(w)) && !/^\d+$/.test(w)) kind = "diff";
    if (kind) {
      if (m.index > last) out.push({ text: title.slice(last, m.index), kind: null });
      out.push({ text: m[0], kind });
      last = m.index + m[0].length;
    }
  }
  if (last < title.length) out.push({ text: title.slice(last), kind: null });
  return out;
}
