# King Engine Bearings — Marketing Dashboard

Live: **https://transcendent-palmier-2390a7.netlify.app**
Owner: Meytal Gal (VP Marketing). Local clone: `C:\Users\meytals\Desktop\meytal\meytal_voult\king-bearings-dashboard-work`.

A single-page dashboard (`index.html`, no build step) backed by Netlify Functions.
Every push to `main` auto-deploys to Netlify (site `transcendent-palmier-2390a7`,
Netlify login `meytalsnirgal@gmail.com`, CLI via `npx netlify-cli`).

## Architecture

```
index.html                     the whole frontend (HTML + CSS + JS, Chart.js from CDN)
netlify/functions/
  magento.js                   eCommerce data (Magento custom API)
  googleads.js                 Google Ads data (GAQL)
  analytics.js                 GA4 data
  search.js                    Instagram (Meta Graph API)
data/
  negative-mentions.json       written daily by a scheduled task (see below)
  instagram-followers.json     appended daily by a scheduled task (see below)
```

All secrets live in **Netlify environment variables** (never in code):
`MAGENTO_TOKEN`, `GA_CLIENT_EMAIL`, `GA_PRIVATE_KEY`, `GA_PROPERTY_ID` (418589591),
`GOOGLE_ADS_CLIENT_ID/SECRET/DEVELOPER_TOKEN/REFRESH_TOKEN`, `IG_TOKEN`, `SERPAPI_KEY`.
Note: most are secret-scoped, so `netlify dev` / CLI cannot read their values —
test against the deployed functions instead.

## Function endpoints (all GET, all return JSON with `connected` or `available`)

| Endpoint | What it returns |
|---|---|
| `/.netlify/functions/magento` | Current-month revenue/orders/AOV vs last month, 12-mo revenue trend, top products |
| `/.netlify/functions/magento?view=brands` | Sales by brand, monthly, current year (see brand rules below) |
| `/.netlify/functions/magento?view=monthly&year=Y` | Monthly orders/amount/AOV for the KPI table |
| `/.netlify/functions/googleads` | MTD cost/clicks/conversions vs last month, top campaigns |
| `/.netlify/functions/googleads?view=monthly&year=Y` | Monthly cost/clicks/impressions + purchase orders/value |
| `/.netlify/functions/googleads?view=diag` | Conversion-action diagnostics (names, categories, primary flags, YTD volumes) |
| `/.netlify/functions/analytics` | Sessions MTD, YoY traffic, top pages, channels, cart funnel |
| `/.netlify/functions/analytics?view=monthly&year=Y` | Monthly GA4 New Users + official full-range YTD |
| `/.netlify/functions/analytics?view=igtraffic&year=Y` | Monthly sessions where sessionSource contains "instagram" |
| `/.netlify/functions/search?type=instagram` | IG account + last 100 posts |
| `/.netlify/functions/search?type=ig-insights` | Reach/profile views/website taps last 28d (currently `available:false`, token lacks `instagram_manage_insights`) |

## Magento API: what we learned the hard way

Endpoint: `https://kingenginebuilders.com/rest/V1/dashboard/sales-summary`
(custom module by the eCommerce team; Bearer `MAGENTO_TOKEN`). Filters:
`created_at` gteq/lteq (admin-timezone datetimes), plus `attribute_set`,
`manufacturer`, `application`, `size`. `fields=` limits the payload.

**Known bugs in the API (reported to the eCommerce team, dashboard works around both):**
1. With a `manufacturer` filter, the server's `revenue` field is inflated by a
   broken join (a single day's "King revenue" exceeded the whole store's revenue
   that day). Do not use it.
2. With a `manufacturer` filter, `orders[items[order_items]]` returns **whole
   orders** (all items of any order containing at least one matching item),
   not just the matching items.

Therefore **brand revenue is classified per order item by product-name rules**
in `magento.js` (`BRAND_RULES`, validated against the data to the cent where a
ground truth existed):
- UEM Pistons & Rings: `icon|silv-o-lite|kb|dualoy|milwaukee 8|s9901hc`
- CP Carrillo: `carrillo` ($0 all of 2026 — genuinely nothing sold)
- Turbosmart: product types, not brand name (`boost tee|bov|raceport|genv|wg\d\d|v-band|vac hose|oil drain`) because Turbosmart product names often omit the brand
- King: positive match on its regular naming (`bearing|thrust washer|polymer|...`)
- Fallback: Merch & Other (apparel, drill bits, unknown part numbers)

Other Magento facts: no customer identity is exposed (customer_email/customer_id
are silently dropped) so **Returning Buyers cannot be computed** until the
eCommerce team adds a customer field. "Completed orders" = status not
canceled/closed. `row_total` is pre-discount product revenue; `grand_total`
includes shipping/tax. Server caches repeated queries (first hit ~5s, repeats
~0.5s); parallel per-month queries are much faster than one big range.

## Google Ads: conversion actions are a minefield

Account `2801560311` (login customer `1510947200`), GAQL API version pinned in
`GOOGLE_ADS_API_VERSION` (currently v24; v17 died — bump when Google sunsets it).

The account has multiple PURCHASE-category conversion actions:
- **Bounce_Purchase** (primary, created ~June 2026 by the agency) — the only one
  with real order values (~$300-500/order). This is what the dashboard uses.
- Two legacy codeless "Purchase" page-load counters recording ~$1 junk values
  (600+ conversions each YTD). They were *primary until June*, so neither
  `metrics.conversions` nor a category filter alone gives clean history —
  `googleads.js` resolves primary purchase action **names** first and pins the
  monthly query to them via `segments.conversion_action_name IN (...)` with
  `metrics.all_conversions`.

Consequence: **Google Ads purchase attribution effectively starts June 2026.**
Jan–May 2026 shows ~0 attributed orders because nothing reliable was recorded.

GAQL gotcha: a segment used in WHERE must also appear in SELECT
(`EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE`).

## GA4

Service-account JWT auth (no OAuth dance). Property 418589591.
**Known data issue:** tracking collapsed in May 2026 — New Users went
86K (Feb) → 73K (Mar) → 21K (Apr) → 591 (May) → 322 (Jun). Also suspicious:
New Users exploded to 91K–97K/month in Nov–Dec 2025 from a ~8K baseline
(possible bot/spam traffic or tag change). Until the site's tags are audited,
treat GA-derived rates (conversion rate, sessions) as broken. The same issue
explains the Google Ads "conversions -92%" alarm.

## Instagram

Meta Graph API v19, IG user id `17841402254973060`, token `IG_TOKEN`.
Available: account fields + media (100 posts fetched for the monthly engagement
chart). NOT available: `/insights` (needs `instagram_manage_insights` — the
frontend card auto-appears if the token is ever reauthorized with that scope).
Follower history cannot be queried retroactively, so a scheduled task snapshots
the count daily into `data/instagram-followers.json`.

## Scheduled tasks (in `C:\Users\meytals\.claude\scheduled-tasks\`, run via Claude)

| Task | Schedule | Writes |
|---|---|---|
| `king-negative-mentions-scan` | daily ~06:30 | `data/negative-mentions.json` (overwrite) |
| `king-instagram-followers-snapshot` | daily ~06:57 | `data/instagram-followers.json` (append) |
| `king-marketing-email-notion-sync` | daily ~06:00 | Notion comments (not this repo) |

Both repo-writing tasks `git pull`, edit their one file, commit, push (which
redeploys the site).

## Frontend conventions

- KPI tables: measurements as rows, months as columns, YTD last; current month
  marked "MTD"; missing data rendered as "—" (never fake zeros); MoM % change
  with arrows — green/red only when the direction is unambiguously good/bad,
  neutral gray for costs (Cost, CPC).
- YTD ratios computed from totals (YTD CPC = total cost ÷ total clicks,
  YTD AOV = total amount ÷ total orders), never averaged monthly ratios.
- Year selector (header) reloads the monthly KPI views with `?year=`.
- Each KPI card shows its source system + last refresh time, and a red warning
  line if its source fails.
- Charts are Chart.js; `kpiChart()` handles dual axes and hover tooltips.
- Layout is mobile-width (max 480px); KPI tables scroll horizontally.

## History of major decisions

Git history is the full record. Highlights: Google Ads OAuth token saga
(playground tokens die in ~24h; the working refresh token was captured via a
local OAuth catcher, July 14 2026), Magento connection + brand classification
(July 16 2026), monthly KPI spec implementation with purchase-only Ads
attribution (July 16 2026), Instagram VP metrics + follower snapshot
(July 16 2026). Removed on request: Returning Buyers row, Google Ads
Orders & Revenue graph (data still in the KPI table).
