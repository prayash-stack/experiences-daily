#!/usr/bin/env node
// Fetches news for the tours/activities/experiences space and writes docs/news.json.
// No dependencies — runs on Node 20+ (built-in fetch). Run: node fetch-news.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const OUT_FILE = new URL('./docs/news.json', import.meta.url);
const KEEP_DAYS = 21;
const MAX_ITEMS = 800;
const FETCH_TIMEOUT_MS = 20_000;

const GN = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;

// NOTE: never use the "-term" / "-site:" exclusion operators in Google News
// RSS queries — they flip the endpoint into a loose-match mode that returns
// x.com posts, LinkedIn job ads and spam domains. Filter noise below instead.
const FEEDS = [
  { url: GN('"Headout" when:90d'), category: 'Headout', keepDays: 90 },
  { url: GN('"GetYourGuide" OR "Viator" OR "Klook" OR "Tiqets" OR "KKday" when:7d'), category: 'Competitors' },
  { url: GN('"Airbnb Experiences" OR "Musement" OR "Civitatis" when:7d'), category: 'Competitors' },
  { url: GN('"Fever" ("Feverup" OR "live entertainment" OR "Candlelight concerts") when:7d'), category: 'Competitors' },
  { url: GN('"Tripadvisor" (Viator OR TheFork OR acquisition OR subscription OR earnings OR OTA) when:7d'), category: 'Competitors' },
  { url: GN('"live entertainment" (venue OR ticketing OR "immersive experience" OR concert OR arena) when:7d'), category: 'Live entertainment' },
  { url: GN('site:blooloop.com when:7d'), category: 'Live entertainment' },
  { url: GN('"tours and activities" (booking OR platform OR operators OR market OR startup) OR "attractions industry" OR "experience economy" when:7d'), category: 'Experiences economy' },
  { url: GN('"MakeMyTrip" OR "ixigo" OR "Cleartrip" OR "EaseMyTrip" OR "Thrillophilia" OR "Yatra Online" when:7d'), category: 'India travel' },
  { url: GN('("travel tech" OR "travel technology" OR traveltech) (funding OR funded OR raises OR raised OR acquisition OR acquires OR startup OR "Series A" OR "Series B") when:7d'), category: 'Travel tech & funding' },
  { url: GN('site:phocuswire.com when:7d'), category: 'Industry reads' },
  { url: GN('site:arival.travel when:30d'), category: 'Industry reads', keepDays: 30 },
  { url: 'https://skift.com/feed/', category: 'Industry reads', source: 'Skift' },
];

// Recurring junk that survives the queries: scraper databases, stock-note
// mills, award-PR boilerplate, school sports pages that share brand names.
const NOISE_SOURCES =
  /^(Tracxn|MarketBeat|Simply Wall St|simplywall\.st|TipRanks|TradingView|Kalkine|Kavout|Wall Street Zen|ETF Daily News|Defense World|Zacks|MaxPreps|Prep Baseball|Sortir à Paris|UNiDAYS|Encyclopedia Britannica)/i;
const NOISE_TITLES =
  /travell?ers['’]? choice|\bpromo codes?\b|\bdiscount codes?\b|\bcoupons?\b|obituar|undervalued|overvalued|price target|fair value|rating (?:lowered|raised|reiterated)|[\d,]+ shares\b|\bSt\.? Viator\b|^news archives$/i;

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function clean(s) {
  return decodeEntities(
    s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  ).trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A story syndicated to many outlets should appear once: dedupe on the
// normalized headline as well as the exact link.
function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseFeed(xml, feed) {
  const items = [];
  for (const block of xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || []) {
    let title = clean(tag(block, 'title'));
    const link = clean(tag(block, 'link'));
    const pubDate = clean(tag(block, 'pubDate'));
    const source = feed.source || clean(tag(block, 'source')) || 'News';

    // Google News titles are "Headline - Publisher"; strip the suffix. Some
    // items are ONLY the suffix (" - PhocusWire") — they reduce to '' and are
    // dropped, as are "PhocusWire - PhocusWire" style items via the normTitle
    // comparison below.
    title = title.replace(new RegExp(`\\s*-\\s*${escapeRe(source)}\\s*$`), '').trim();

    const publishedAt = new Date(pubDate);
    if (!title || normTitle(title) === normTitle(source)) continue;
    if (!/^https?:\/\//i.test(link) || Number.isNaN(publishedAt.getTime())) continue;
    if (NOISE_SOURCES.test(source) || NOISE_TITLES.test(title)) continue;

    items.push({
      title,
      link,
      source,
      category: feed.category,
      publishedAt: publishedAt.toISOString(),
    });
  }
  return items;
}

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text(), feed);
  } finally {
    clearTimeout(timer);
  }
}

function loadPrevious() {
  try {
    return JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function loadExisting() {
  const prev = loadPrevious();
  return Array.isArray(prev.items) ? prev.items : [];
}

// ---------- AI digest (per-category summaries + opportunities for Headout) ----------
// Uses the Claude API when ANTHROPIC_API_KEY is set; otherwise falls back to
// GitHub Models, which is free in Actions with the workflow's GITHUB_TOKEN
// (needs `models: read` permission). On any failure, yesterday's digest is kept.

function buildDigestPrompt(items) {
  const byCat = {};
  for (const it of items) (byCat[it.category] ||= []).push(it);
  const cats = Object.keys(byCat);
  const digest = cats
    .map((cat) => `## ${cat}\n` + byCat[cat].slice(0, 14).map((i) => `- ${i.title} (${i.source})`).join('\n'))
    .join('\n\n');
  const prompt = `You write the daily morning briefing for people working in the tours, activities & experiences industry — the space Headout operates in (competitors: GetYourGuide, Viator, Klook, Tiqets, KKday, Fever, Airbnb Experiences). Today's headlines by category:

${digest}

Return a JSON object with exactly two keys:
"summaries": an object mapping each category name (${cats.map((c) => JSON.stringify(c)).join(', ')}) to a 2-3 sentence summary of what happened and why it matters to someone in this industry. Name specific companies and numbers; no filler.
"opportunities": an array of 3 to 5 objects, each {"title": <short punchy title>, "insight": <1-2 sentences describing a concrete opportunity for Headout — a partnership, market entry, supply expansion, or product move — grounded in specific headlines above>}.`;
  return { prompt, cats };
}

async function fetchJson(url, options, timeoutMs = 90_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function digestSchema(cats) {
  return {
    type: 'object',
    properties: {
      summaries: {
        type: 'object',
        properties: Object.fromEntries(cats.map((c) => [c, { type: 'string' }])),
        required: cats,
        additionalProperties: false,
      },
      opportunities: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, insight: { type: 'string' } },
          required: ['title', 'insight'],
          additionalProperties: false,
        },
      },
    },
    required: ['summaries', 'opportunities'],
    additionalProperties: false,
  };
}

async function claudeDigest(prompt, cats) {
  const schema = digestSchema(cats);
  const data = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 3000,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (data.stop_reason === 'refusal') throw new Error('Claude refused the request');
  const text = data.content.find((b) => b.type === 'text')?.text;
  return { parsed: JSON.parse(text), model: 'claude-opus-4-8' };
}

async function githubModelsDigest(prompt, cats) {
  const call = (response_format) =>
    fetchJson('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt + '\n\nRespond with only the JSON object.' }],
        response_format,
        max_tokens: 2500,
      }),
    });
  let data;
  try {
    // Strict schema keeps the summary keys exactly equal to the category names.
    data = await call({
      type: 'json_schema',
      json_schema: { name: 'digest', strict: true, schema: digestSchema(cats) },
    });
  } catch {
    data = await call({ type: 'json_object' });
  }
  return { parsed: JSON.parse(data.choices[0].message.content), model: 'openai/gpt-4o-mini' };
}

// Map loosely-named summary keys ("Travel tech and funding") back to the exact
// category names used by the dashboard.
function remapSummaryKeys(summaries, cats) {
  const tokens = (s) => new Set(
    s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  );
  const catTokens = cats.map((c) => [c, tokens(c)]);
  const out = {};
  for (const [key, text] of Object.entries(summaries)) {
    if (cats.includes(key)) { out[key] = text; continue; }
    const kt = tokens(key);
    let best = null, bestScore = 0;
    for (const [cat, ct] of catTokens) {
      const inter = [...kt].filter((t) => ct.has(t) && t !== 'and').length;
      const score = inter / Math.max(kt.size, ct.size);
      if (score > bestScore) { bestScore = score; best = cat; }
    }
    if (best && bestScore >= 0.5 && !(best in out)) out[best] = text;
  }
  return out;
}

// A kept-on-failure digest is only reused for a few days; after that it's
// better to show nothing than a week-old briefing presented as current.
function usablePrevious() {
  const prev = loadPrevious().ai || null;
  if (!prev?.generatedAt) return null;
  const ageDays = (Date.now() - new Date(prev.generatedAt).getTime()) / 864e5;
  return ageDays < 3 ? prev : null;
}

async function generateAiDigest(items) {
  const { prompt, cats } = buildDigestPrompt(items);
  try {
    let result;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        result = await claudeDigest(prompt, cats);
      } catch (err) {
        if (!process.env.GITHUB_TOKEN) throw err;
        console.log(`::warning::Claude digest failed (${err.message}) — falling back to GitHub Models.`);
        result = await githubModelsDigest(prompt, cats);
      }
    } else if (process.env.GITHUB_TOKEN) {
      result = await githubModelsDigest(prompt, cats);
    } else {
      console.log('No ANTHROPIC_API_KEY or GITHUB_TOKEN — keeping previous AI digest.');
      return usablePrevious();
    }
    const { summaries, opportunities } = result.parsed;
    if (!summaries || typeof summaries !== 'object' || !Array.isArray(opportunities)) {
      throw new Error('AI digest has unexpected shape');
    }
    const cleanSummaries = {};
    for (const [cat, text] of Object.entries(remapSummaryKeys(summaries, cats))) {
      if (typeof text === 'string' && text.trim()) cleanSummaries[cat] = text.trim();
    }
    const cleanOpps = opportunities
      .filter((o) => o && typeof o.title === 'string' && typeof o.insight === 'string')
      .slice(0, 6);
    if (Object.keys(cleanSummaries).length === 0 || cleanOpps.length === 0) {
      throw new Error(`AI digest effectively empty (${Object.keys(cleanSummaries).length} summaries, ${cleanOpps.length} opportunities)`);
    }
    console.log(`AI digest: ${Object.keys(cleanSummaries).length} summaries, ${cleanOpps.length} opportunities (${result.model})`);
    return {
      summaries: cleanSummaries,
      opportunities: cleanOpps,
      generatedAt: new Date().toISOString(),
      model: result.model,
    };
  } catch (err) {
    console.log(`::warning::AI digest failed (${err.message}) — keeping previous digest.`);
    return usablePrevious();
  }
}

const results = await Promise.allSettled(FEEDS.map(fetchFeed));
const fresh = [];
const sources = [];
results.forEach((r, i) => {
  const feed = FEEDS[i];
  // A consent/captcha interstitial is HTTP 200 with zero <item> blocks, so
  // "fulfilled but empty" counts as unhealthy too.
  const ok = r.status === 'fulfilled' && r.value.length > 0;
  const count = r.status === 'fulfilled' ? r.value.length : 0;
  sources.push({ category: feed.category, url: feed.url, ok, count });
  if (r.status === 'fulfilled') {
    console.log(`ok   ${count}\t${feed.category}\t${feed.url.slice(0, 90)}`);
    fresh.push(...r.value);
  } else {
    console.error(`FAIL ${feed.url.slice(0, 90)} — ${r.reason}`);
  }
});

if (fresh.length === 0) {
  console.error('Every feed failed; keeping the previous news.json.');
  process.exit(1);
}

// The Headout feed queries 90 days back; give its category a matching
// retention window instead of the default.
const keepDaysByCat = {};
for (const f of FEEDS) {
  keepDaysByCat[f.category] = Math.max(keepDaysByCat[f.category] || 0, f.keepDays || KEEP_DAYS);
}
const cutoffFor = (cat) =>
  Date.now() - (keepDaysByCat[cat] || KEEP_DAYS) * 24 * 3600 * 1000;

const seenLinks = new Set();
const seenTitles = new Set();
const merged = [];

// Fresh items first so re-fetched stories keep their newest metadata. Titles
// are deduped per-category (cross-publisher syndication) AND per-source (the
// same Skift article arriving via both skift.com/feed and a Google News query
// lands in different categories with different links).
for (const item of [...fresh, ...loadExisting()]) {
  const t = normTitle(item.title);
  if (!t) continue;
  if (new Date(item.publishedAt).getTime() < cutoffFor(item.category)) continue;
  const keys = [`cat:${item.category}|${t}`, `src:${(item.source || '').toLowerCase()}|${t}`];
  if (seenLinks.has(item.link) || keys.some((k) => seenTitles.has(k))) continue;
  seenLinks.add(item.link);
  keys.forEach((k) => seenTitles.add(k));
  merged.push(item);
}

merged.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
// Cap the file size without letting high-volume categories evict the old items
// that extended keepDays windows (Headout 90d, Arival 30d) deliberately retain.
let items = merged;
if (merged.length > MAX_ITEMS) {
  const protectedItems = merged.filter((it) => (keepDaysByCat[it.category] || KEEP_DAYS) > KEEP_DAYS);
  const rest = merged.filter((it) => (keepDaysByCat[it.category] || KEEP_DAYS) <= KEEP_DAYS);
  items = protectedItems
    .concat(rest.slice(0, Math.max(0, MAX_ITEMS - protectedItems.length)))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  console.log(`::warning::Item cap hit: kept ${items.length} of ${merged.length} items (MAX_ITEMS=${MAX_ITEMS}).`);
}

const ai = await generateAiDigest(items);

writeFileSync(
  OUT_FILE,
  JSON.stringify({ updatedAt: new Date().toISOString(), sources, ai, items }, null, 1)
);
console.log(`\nWrote ${items.length} items to docs/news.json`);

// Surface unhealthy feeds on the Actions run summary; fail the run (after the
// file is written — the workflow commits before checking this step's outcome)
// when half or more of the feeds returned nothing.
const unhealthy = sources.filter((s) => !s.ok);
for (const s of unhealthy) {
  console.log(`::warning::Feed failed or empty: [${s.category}] ${s.url}`);
}
if (unhealthy.length >= FEEDS.length / 2) {
  console.error(`${unhealthy.length}/${FEEDS.length} feeds unhealthy — failing the run.`);
  process.exit(1);
}
