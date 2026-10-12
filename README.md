# Scoutgrid

A distributed job-aggregation pipeline that scans Greenhouse, Ashby, Lever,
Workday, HiringCafe, JobRight, NextPlay, and a curated list of VC-backed
startup boards — running entirely on **free, unmetered GitHub Actions
compute**, with residential-IP routing via a self-hosted **Tailscale** exit
node to get past datacenter IP-reputation blocks.

It started as 10 cron jobs running 24/7 on an 8GB MacBook Air. This repo is
what's left after moving every scraper off that laptop.

```
┌─────────────┐   cron (5–15min, offset)   ┌───────────────────────┐
│ GitHub       │ ─────────────────────────▶│ 7 independent scrapers│
│ Actions      │                            │ each → own TSV/JSON   │
│ (public repo,│◀───────────────────────── │ + own checkpoint/      │
│  unmetered)  │   git commit + push        │ cooldown cache         │
└──────┬───────┘                            └───────────────────────┘
       │ Tailscale exit node (datacenter IP → residential IP)
       ▼
┌─────────────┐        git pull          ┌──────────────────────┐
│ Target sites │                          │ Local dashboard        │
│ (ATS boards, │                          │ (career-ops, Mac-only) │
│  job boards) │                          └──────────────────────┘
└─────────────┘                                      │
                                                        │ same data, live fetch
                                                        ▼
                                            ┌──────────────────────┐
                                            │ Remote dashboard        │
                                            │ (Vercel, public URL)    │
                                            └──────────────────────┘
```

## Why this exists

Running 10 scrapers continuously on a personal laptop meant chronic swap
pressure, fan noise, and battery drain — for work that doesn't need to
happen *there* at all. Every scraper here is stateless and idempotent, so
there's no reason it can't run on someone else's compute.

**This repo is public on purpose.** GitHub Actions on standard runners is
completely unmetered for public repos — no minute quota, which is what
makes a 5-minute scan cadence free forever. Nothing sensitive lives here:
the scraped data is already-public job postings (company/title/date,
visible on each ATS's own board), and the one mildly personal file
(`portals.yml`, search filters) reveals only that someone is job hunting,
not who. No resumes, no application data, no plaintext credentials —
session cookies live exclusively as encrypted GitHub Actions secrets.

## The scrapers

| Source | Method | Cadence | Notes |
|---|---|---|---|
| Greenhouse / Ashby / Lever | Public JSON APIs | `*/5min` | cheapest slice, no browser needed |
| Workday | Full-directory reverse sweep | `*/15min` | ~13k companies, ~10min per run |
| Tracked boards | `portals.yml`-defined company list | offset `/15min` | |
| VC portfolio seeds | YC + a16z public APIs | slower cadence | walks portfolio pages |
| HiringCafe | Headed-Chrome scrape via `patchright` | offset | needs Xvfb — see below |
| NextPlay | Headed-Chrome scrape | offset | needs Tailscale — see below |
| JobRight | Cookie-session scrape | offset | headless, no Xvfb needed |

## Two real infra problems, solved honestly

**1. Cloudflare blocks headless Chrome.** GitHub's Linux runners have no
display at all, and some targets fingerprint headless mode and block it.
Fixed with **Xvfb** — a virtual framebuffer that lets Chrome run in genuine
headed mode on a runner with no physical screen.

**2. Some targets block datacenter IP ranges outright**, independent of
browser fingerprinting — confirmed via direct A/B testing (identical code,
home IP vs. GitHub's IP: one works, one 403s). Rather than reach for a paid
residential-proxy service, this repo routes flagged scrapers' traffic
through a **Tailscale exit node** — a WireGuard tunnel back to a real
residential connection, free on Tailscale's personal tier.

**Deliberately not solved**: a third target returns AWS WAF CAPTCHA
challenges on every request. That's a platform actively defending against
automation, not a reachability problem — no bypass was built. Reading a
public API and defeating a deliberate anti-bot wall are different things,
and this project only does the former.

## Architecture notes

- **No database.** Flat TSV/JSON files + git history as the append log.
  For a single-operator pipeline at this scale, git *is* the database —
  free, versioned, and trivially diffable.
- **No shared mutable state across scrapers.** Early on, two scrapers
  racing on one shared cooldown-cache file caused silent push failures
  (job reports green, data never lands). Every scraper now owns its own
  checkpoint and cooldown file — the fix is structural, not a retry hack.
- **Every job is independently idempotent and resumable** from its own
  checkpoint file, so a mid-run failure costs a few minutes, not a restart
  from zero.

## Downstream

A **local dashboard** (Mac-only, not in this repo) pulls this repo's
output on a short interval and merges new rows into its own feed — kept
in sync but decoupled, so a scraper failing here never breaks the viewer.

A second, fully independent **public dashboard on Vercel** reads this
repo's data live on every request (no caching layer beyond what
`raw.githubusercontent.com` itself does) — dynamic, not a static
snapshot, viewable from anywhere without the laptop being on.

## Running a scraper locally

```
npm install
node run.mjs          # GHAL
node run-workday.mjs  # Workday
node run-hc.mjs        # HiringCafe (needs a local display or Xvfb)
```

## Repo layout

Each `run-*.mjs` is a thin CI entrypoint around the matching
`fetch-*.mjs` / `scan-*.mjs` scraper, wiring it to that scraper's own
checkpoint and output files. `lib/` holds shared, dependency-free parsing
utilities (location/clearance filtering, repost detection, title
matching). `.github/workflows/` has one workflow per scraper, each on its
own offset cron so concurrent runs never collide on the same files.
