#!/usr/bin/env node
// Fetches news for the tours/activities/experiences space and writes docs/news.json.
// No dependencies — runs on Node 20+ (built-in fetch). Run: node fetch-news.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const OUT_FILE = new URL('./docs/news.json', import.meta.url);
const KEEP_DAYS = 21;
const MAX_ITEMS = 600;
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
  /^(Tracxn|MarketBeat|Simply Wall St|simplywall\.st|TipRanks|TradingView|Kalkine|Kavout|Wall Street Zen|ETF Daily News|Defense World|Zacks|MaxPreps|Prep Baseball|Sortir à Paris|UNiDAYS)/i;
const NOISE_TITLES =
  /travell?ers['’]? choice|\bpromo codes?\b|\bdiscount codes?\b|\bcoupons?\b|obituar|undervalued|overvalued|price target|fair value|rating (?:lowered|raised|reiterated)|[\d,]+ shares\b|\bSt\.? Viator\b/i;

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

function loadExisting() {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    return Array.isArray(prev.items) ? prev.items : [];
  } catch {
    return [];
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
const items = merged.slice(0, MAX_ITEMS);

writeFileSync(
  OUT_FILE,
  JSON.stringify({ updatedAt: new Date().toISOString(), sources, items }, null, 1)
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
