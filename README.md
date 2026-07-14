# Experiences Daily

A self-refreshing news digest for the **tours, activities, attractions & travel-tech space** — the industry Headout, GetYourGuide, Viator, Klook and friends operate in.

**Live site:** https://prayash-stack.github.io/experiences-daily/

## How it works

- [`fetch-news.mjs`](fetch-news.mjs) pulls RSS from Google News queries (Headout, competitors, experiences economy, India travel, travel tech, PhocusWire) plus Skift's feed, dedupes syndicated stories, and writes [`docs/news.json`](docs/news.json). No dependencies — plain Node 20+.
- [`.github/workflows/refresh.yml`](.github/workflows/refresh.yml) runs it every morning at **02:15 UTC (~8:00 AM IST after GitHub's usual cron lag)** and commits the refreshed JSON.
- [`docs/index.html`](docs/index.html) is a static dashboard served by GitHub Pages that renders the JSON — category filters, search, dark mode, "new in last 24h" markers.

## Refresh manually

Actions tab → **Refresh news** → *Run workflow*, or locally:

```sh
node fetch-news.mjs
```

## Tweak the coverage

Edit the `FEEDS` array at the top of `fetch-news.mjs` — each entry is a Google News RSS query (or a direct RSS URL) mapped to a category. Category display order lives in `CATEGORY_ORDER` in `docs/index.html`.

> Note: GitHub disables cron workflows in repos with no activity for 60 days; the daily bot commit keeps it alive, but if you ever pause it, re-enable from the Actions tab.
