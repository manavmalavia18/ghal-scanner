# ghal-scanner

Standalone Greenhouse/Ashby/Lever reverse scanner, trimmed out of
[career-ops](https://github.com/career-ops-hq/career-ops) so it can run on a
**GitHub Actions schedule** instead of 24/7 on a laptop.

## Why this exists

career-ops's own GHAL loop (`scripts/scan-ghal.mjs`) ran continuously on a
personal 8GB MacBook Air alongside several other always-on scrapers,
contributing to chronic swap pressure / system slowness. Greenhouse/Ashby/
Lever is the *cheap* slice of the scan matrix (public JSON APIs, no headed
browser needed, a full incremental cycle runs in under a minute once
warmed up) — a good fit for a scheduled Actions runner. The expensive slice
(Workday full-directory sweeps, which can run 30min-10hrs) stays local,
where it isn't fighting a GitHub Actions 6-hour job cap.

**This repo is public on purpose.** GitHub Actions on standard runners is
completely unmetered for public repos on any plan — no minute quota at all,
which is what makes a 5-minute scan cadence free. Nothing sensitive lives
here: `data/scan-history.tsv` is just scraped public job-posting data
(company/title/date, already public on Greenhouse/Ashby/Lever's own
boards), and the only even mildly personal file is `portals.yml` (title/
location search filters — reveals you're job hunting and roughly what for,
not true PII). No resume, no application data, no credentials.

## How it works

1. `.github/workflows/scan.yml` runs `run.mjs` on a cron schedule
   (`*/5 * * * *`), resuming from `data/cache/ats-ghal-checkpoint.json`
   each time.
2. New matches land in `data/scan-history.tsv`; the workflow commits and
   pushes any changes back to this repo.
3. A lightweight puller on the laptop (`career-ops`'s
   `scripts/pull-ghal-remote.mjs`) does a cheap `git pull` on a short
   interval and merges new rows into career-ops's local
   `data/scan-history.tsv` so `jobs-ui.mjs` keeps working unchanged.

## Local one-off run

```
npm install
node run.mjs
```

## Files

Trimmed 1:1 from career-ops (unmodified except `run.mjs`, which is new):
`scan-ats-full.mjs`, `scan.mjs`, `providers/{greenhouse,ashby,lever,icims,
workday,_*}.mjs` (icims/workday unused here but are load-time deps of
`scan-ats-full.mjs`), `tracker-*.mjs`, `fingerprint-core.mjs`,
`invite-match.mjs`, `path-resolver.mjs`, `pipeline-lock.mjs`,
`portal-health-lock.mjs`, `user-agent.mjs`, `verify-portals.mjs`,
`plugins/_*.mjs`, `lib/{ascii-fold,cli-flags,is-main-module,title-filter}.mjs`,
`seeds/vc-portfolios.mjs`, `portals.yml`, `tracker-aliases.json`.
