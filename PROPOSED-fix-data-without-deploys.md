# Proposed fix: stop the daily data from needing a Netlify deploy

**Not applied. Awaiting Meytal's approval.** Prepared 2026-08-23.

## What broke

Netlify paused production deploys on 16 August: *"Skipped due to account credit usage exceeded."*
Every push since then shows as **Skipped**, not Failed. The site keeps serving the 16 August build.

Consequence: `data/negative-mentions.json` and `data/instagram-followers.json` have been frozen for a
week on the live site, while GitHub `main` has had correct, current data the whole time.

The Netlify **Functions** (`search`, `analytics`, `magento`, `googleads`) are unaffected and still
serving. Only the two static data files are stale, because those are the only things the daily
routines change.

## The likely reason the credits ran out

The routines push **two to three commits every day** (mentions scan, sometimes twice, plus the
Instagram followers snapshot). Every one of those triggers a full production build. That is roughly
60 to 90 production builds a month to publish what are, in the end, two small JSON files.

So this is not really a billing problem. It is a design problem: the daily data is riding through a
build pipeline it does not need.

## The fix, two lines

Read the two data files straight from GitHub raw instead of from the deployed site. Then a data commit
is live within about five minutes with **no deploy at all**, and the daily routines stop consuming
build credits entirely.

Verified working: `raw.githubusercontent.com` returns `Access-Control-Allow-Origin: *` and
`Cache-Control: max-age=300` on this repo, so a browser fetch from the dashboard succeeds and the data
is at most five minutes stale. The repo is public, so no token is involved.

### The diff

In `index.html`, add the base near the other constants:

```js
const RAW = 'https://raw.githubusercontent.com/meytalsnirgal/king-bearings-dashboard/main';
```

Line 806, currently:
```js
const res = await fetch(`/data/instagram-followers.json?_=${Date.now()}`);
```
becomes:
```js
const res = await fetch(`${RAW}/data/instagram-followers.json?_=${Date.now()}`);
```

Line 828, currently:
```js
const res = await fetch(`/data/negative-mentions.json?_=${Date.now()}`);
```
becomes:
```js
const res = await fetch(`${RAW}/data/negative-mentions.json?_=${Date.now()}`);
```

## The catch

**This change is itself in `index.html`, so it needs one deploy to take effect.** Deploys are paused.
So it cannot be applied until either the next billing cycle starts or the plan is upgraded.

Once that one deploy lands, no future data update needs a deploy again, and this exact failure cannot
recur.

## Also worth doing at the same time

- **Stop the followers snapshot and the mentions scan from committing twice a day.** One commit per day
  per routine is enough. Fewer commits, fewer builds.
- Consider whether the dashboard needs the Netlify build step at all. It is static HTML plus functions;
  if the functions were the only thing requiring a build, a different split may be cheaper.

## Already done, no approval needed

The mentions scan now verifies the **live** file after pushing and reports `DASHBOARD STALE` when the
deployed timestamp does not match what it just committed. That is what should have caught this on
17 August instead of it running silently for a week.
