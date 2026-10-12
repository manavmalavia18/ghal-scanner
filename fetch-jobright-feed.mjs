#!/usr/bin/env node
/**
 * Refresh JobRight so we can track companies / ATS boards — not listings.
 * The Jobs UI does not show JobRight cards. `--boards-only` fetches
 * Greenhouse / Ashby / Lever / Workday from cached JR + Hiring Cafe apply
 * URLs and never hits jobright.ai.
 *
 *   npm run feed:jr            # scrape JobRight for new companies, then check boards
 *   npm run feed:jr:boards     # check tracked companies' ATS boards only
 */
import { spawnSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { canonicalGhalKey, normalizeHref } from './lib/ghal-job-key.mjs';
import {
  companyTitleKey,
  emptyJrClockStore,
  groundJrJob,
  rememberJrDate,
  olderIso,
  isJrRepostClock,
} from './lib/jr-repost.mjs';
import { fetchAtsPostedAt, mapPool } from './lib/ats-posted-at.mjs';
import { companyTrackFromJobs, fetchFreshFromJrLeads } from './lib/jr-board-leads.mjs';
import { jrPauseActive, jrPauseMessage } from './lib/jr-pause.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const LOCK = join(DATA, 'jr-feed.lock');
const HEARTBEAT = join(DATA, 'scan-jr-heartbeat.json');
const HITS = join(DATA, 'jobright-hits.json');
const HITS_TMP = join(DATA, 'jobright-hits.tmp.json');
const CLOCK = join(DATA, 'jr-first-seen.json');
const ATS_CACHE = join(DATA, 'ats-posted-at.json');
const JR_BOARD = join(DATA, 'jr-board-fresh.json');
const JR_COMPANIES = join(DATA, 'jr-companies.json');
const HC_FEED = join(DATA, 'hiringcafe-feed.json');
const PY = process.env.HC_PYTHON || 'python3';
const SCRAPE = join(ROOT, 'scrape-jobright.py');
/** How often we re-scrape JobRight for new companies. Board checks are cheaper. */
const COMPANY_STALE_MS = 12 * 60 * 60 * 1000;

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

function acquireLock() {
  mkdirSync(DATA, { recursive: true });
  if (existsSync(LOCK)) {
    try {
      const prev = JSON.parse(readFileSync(LOCK, 'utf8'));
      if (pidAlive(prev.pid)) {
        console.error(`skip — JobRight feed already running (pid ${prev.pid})`);
        return false;
      }
    } catch { /* replace */ }
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return true;
}

function releaseLock() {
  try { unlinkSync(LOCK); } catch { /* ignore */ }
}

function jrIdentity(job) {
  const url = job.applyUrl || job.url || '';
  return {
    key: canonicalGhalKey(url) || normalizeHref(url),
    role: companyTitleKey(job.company, job.title),
  };
}

function loadClockStore() {
  if (!existsSync(CLOCK)) return emptyJrClockStore();
  try {
    const raw = JSON.parse(readFileSync(CLOCK, 'utf8'));
    return {
      byKey: raw.byKey && typeof raw.byKey === 'object' ? raw.byKey : {},
      byRole: raw.byRole && typeof raw.byRole === 'object' ? raw.byRole : {},
    };
  } catch {
    return emptyJrClockStore();
  }
}

function seedClockFromHits(store, hits) {
  for (const job of hits.jobs || []) {
    const { key, role } = jrIdentity(job);
    rememberJrDate(store, { key, role, iso: job.atsPostedAt || job.postedAt || job.posted_at || '' });
  }
}

function loadAtsCache() {
  if (!existsSync(ATS_CACHE)) return {};
  try {
    const raw = JSON.parse(readFileSync(ATS_CACHE, 'utf8'));
    return raw.byKey && typeof raw.byKey === 'object' ? raw.byKey : {};
  } catch {
    return {};
  }
}

async function stampAtsDates(hits) {
  const cache = loadAtsCache();
  let resolved = 0;
  await mapPool(hits.jobs || [], 6, async (job) => {
    const url = job.applyUrl || job.url || '';
    const key = canonicalGhalKey(url) || normalizeHref(url);
    if (!key) return;
    if (job.atsPostedAt) {
      cache[key] = job.atsPostedAt;
      resolved += 1;
      return;
    }
    if (cache[key]) {
      job.atsPostedAt = cache[key];
      resolved += 1;
      return;
    }
    const iso = await fetchAtsPostedAt(url);
    if (iso) {
      job.atsPostedAt = iso;
      cache[key] = iso;
      resolved += 1;
    }
  });
  writeFileSync(ATS_CACHE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    byKey: cache,
  }, null, 2));
  return resolved;
}

async function groundHitsFile(store, srcPath) {
  const hits = JSON.parse(readFileSync(srcPath, 'utf8'));
  const atsResolved = await stampAtsDates(hits);
  const jobs = (hits.jobs || []).map((job) => {
    const { key, role } = jrIdentity(job);
    const next = groundJrJob({ ...job, key, role }, store);
    if (next.atsPostedAt) {
      next.repost = Boolean(next.repost) || isJrRepostClock(next.postedAt, next.atsPostedAt);
      next.postedAt = olderIso(next.postedAt, next.atsPostedAt);
    }
    return next;
  });
  const next = {
    ...hits,
    jobs,
    jobCount: jobs.length,
    repostCount: jobs.filter((j) => j.repost).length,
    atsPostedAtCount: atsResolved,
  };
  writeFileSync(HITS, JSON.stringify(next, null, 2));
  writeFileSync(CLOCK, JSON.stringify({
    updatedAt: new Date().toISOString(),
    byKey: store.byKey,
    byRole: store.byRole,
  }, null, 2));
  return next;
}

/** Same-day GH/Ashby/Lever/Workday fetch from apply URLs. Never throws. */
async function refreshBoardFresh(hits, { days = 2 } = {}) {
  try {
    const result = await fetchFreshFromJrLeads(hits.jobs || [], { days, concurrency: 6 });
    const payload = {
      fetchedAt: new Date().toISOString(),
      days,
      leadCount: result.leadCount,
      jobCount: result.jobs.length,
      boards: result.boards,
      jobs: result.jobs,
      leadSources: hits.leadSources || ['jobright'],
    };
    writeFileSync(JR_BOARD, JSON.stringify(payload, null, 2));
    payload.companyCount = writeCompanyTrack(hits.jobs || [], payload.leadSources);
    return payload;
  } catch (err) {
    console.error(`ats board fetch failed: ${err.message || err}`);
    return { jobCount: 0, leadCount: 0, error: String(err.message || err) };
  }
}

/** Hiring Cafe apply links + last JobRight hits — never calls jobright.ai. */
function loadLeadJobs() {
  const jobs = [];
  const sources = [];
  if (existsSync(HITS)) {
    try {
      const raw = JSON.parse(readFileSync(HITS, 'utf8'));
      for (const job of raw.jobs || []) jobs.push(job);
      if ((raw.jobs || []).length) sources.push('jobright-cache');
    } catch { /* empty */ }
  }
  if (existsSync(HC_FEED)) {
    try {
      const raw = JSON.parse(readFileSync(HC_FEED, 'utf8'));
      let n = 0;
      for (const job of raw.jobs || []) {
        const url = job.url || job.applyUrl || '';
        if (!url) continue;
        jobs.push({
          url,
          applyUrl: url,
          company: job.company || '',
          title: job.title || '',
        });
        n += 1;
      }
      if (n) sources.push('hiringcafe');
    } catch { /* empty */ }
  }
  return { jobs, leadSources: sources };
}

function writeCompanyTrack(jobs, sources) {
  const companies = companyTrackFromJobs(jobs);
  let scrapedAt = '';
  try {
    if (existsSync(JR_COMPANIES)) scrapedAt = JSON.parse(readFileSync(JR_COMPANIES, 'utf8')).scrapedAt || '';
  } catch { /* empty */ }
  try {
    if (existsSync(HITS)) {
      const fromHits = JSON.parse(readFileSync(HITS, 'utf8')).fetchedAt || '';
      const hitsMs = Date.parse(fromHits);
      const prevMs = Date.parse(scrapedAt);
      if (Number.isFinite(hitsMs) && (!Number.isFinite(prevMs) || hitsMs > prevMs)) scrapedAt = fromHits;
    }
  } catch { /* empty */ }
  writeFileSync(JR_COMPANIES, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    scrapedAt,
    source: sources || [],
    companyCount: companies.length,
    companies,
  }, null, 2));
  return companies.length;
}

function lastJrScrapeAt() {
  try {
    if (existsSync(JR_COMPANIES)) {
      const t = Date.parse(JSON.parse(readFileSync(JR_COMPANIES, 'utf8')).scrapedAt || '');
      if (Number.isFinite(t)) return t;
    }
  } catch { /* empty */ }
  try {
    if (existsSync(HITS)) {
      const t = Date.parse(JSON.parse(readFileSync(HITS, 'utf8')).fetchedAt || '');
      if (Number.isFinite(t)) return t;
    }
  } catch { /* empty */ }
  return 0;
}

function companiesStale() {
  const t = lastJrScrapeAt();
  return !t || Date.now() - t > COMPANY_STALE_MS;
}

function writeBoardsHeartbeat({ started, boards, paused, msg, companyCount }) {
  writeFileSync(HEARTBEAT, JSON.stringify({
    at: new Date().toISOString(),
    exitCode: 0,
    elapsedSec: Math.round((Date.now() - started) / 1000),
    newMatches: companyCount || boards.leadCount || 0,
    loginWall: false,
    paused: Boolean(paused),
    apiErrors: msg ? [msg] : [],
    companyCount: companyCount || 0,
    boardLeadCount: boards.leadCount || 0,
    boardFreshCount: boards.jobCount || 0,
    leadSources: boards.leadSources || [],
    mode: paused ? 'ats-boards-from-leads' : 'ats-boards-only',
  }, null, 2));
}

async function main() {
  const stampOnly = process.argv.includes('--stamp-only');
  const boardsOnlyFlag = process.argv.includes('--boards-only');
  const skipBoards = process.argv.includes('--skip-boards');
  const stampDates = process.argv.includes('--stamp-dates');
  const ifStale = process.argv.includes('--if-stale-companies');
  const paused = jrPauseActive();
  const pauseMsg = paused ? jrPauseMessage() : '';
  let boardsOnly = boardsOnlyFlag || (paused && !stampOnly);
  if (ifStale && !stampOnly && !paused && !boardsOnlyFlag && !companiesStale()) {
    boardsOnly = true;
    console.error('JobRight company list is fresh — checking ATS boards only');
  }
  const needsScrape = !stampOnly && !boardsOnly;
  if (paused && needsScrape === false && !stampOnly && pauseMsg) {
    console.error(pauseMsg);
  }
  if (needsScrape && (!existsSync(PY) || !existsSync(SCRAPE))) {
    console.error('JobRight scraper not installed (.venv-scrapling). Skip.');
    process.exit(0);
  }
  if (!acquireLock()) process.exit(0);
  const max = String(argVal('--max', '200'));
  const started = Date.now();
  const store = loadClockStore();
  if (existsSync(HITS)) {
    try { seedClockFromHits(store, JSON.parse(readFileSync(HITS, 'utf8'))); } catch { /* empty */ }
  }
  try {
    if (stampOnly) {
      if (!existsSync(HITS)) {
        console.log(JSON.stringify({ ok: false, error: 'no jobright-hits.json' }));
        return;
      }
      const hits = await groundHitsFile(store, HITS);
      const leads = loadLeadJobs();
      const boards = skipBoards ? { jobCount: 0, leadCount: 0, skipped: true } : await refreshBoardFresh(leads);
      writeBoardsHeartbeat({ started, boards, paused, msg: pauseMsg, companyCount: boards.companyCount });
      console.log(JSON.stringify({
        ok: true,
        stampOnly: true,
        companies: boards.companyCount || 0,
        boardLeads: boards.leadCount || 0,
        boardFresh: boards.jobCount || 0,
        leadSources: leads.leadSources,
        paused,
      }));
      return;
    }
    if (boardsOnly) {
      const leads = loadLeadJobs();
      if (!leads.jobs.length) {
        console.log(JSON.stringify({ ok: false, error: 'no Hiring Cafe or cached JobRight apply URLs' }));
        writeBoardsHeartbeat({
          started,
          boards: { jobCount: 0, leadCount: 0, leadSources: [] },
          paused,
          msg: pauseMsg || 'no lead URLs',
        });
        return;
      }
      const boards = skipBoards
        ? { jobCount: 0, leadCount: 0, skipped: true, leadSources: leads.leadSources, companyCount: writeCompanyTrack(leads.jobs, leads.leadSources) }
        : await refreshBoardFresh(leads);
      writeBoardsHeartbeat({ started, boards, paused, msg: pauseMsg, companyCount: boards.companyCount });
      console.log(JSON.stringify({
        ok: true,
        boardsOnly: true,
        paused,
        companies: boards.companyCount || 0,
        leadSources: leads.leadSources,
        boardLeads: boards.leadCount || 0,
        boardFresh: boards.jobCount || 0,
      }));
      return;
    }
    const env = { ...process.env };
    if (String(env.PLAYWRIGHT_BROWSERS_PATH || '').includes('cursor-sandbox-cache')) {
      delete env.PLAYWRIGHT_BROWSERS_PATH;
    }
    const r = spawnSync(PY, [SCRAPE, '--max', max, '--scroll', '2', '--sort', 'recent', '--out', HITS_TMP], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 300_000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (out) console.error(out);
    const status = r.status ?? 1;
    let hits = { jobCount: 0, loginWallLikely: status === 2, apiErrors: [], jobs: [] };
    if (status === 0 && existsSync(HITS_TMP)) {
      try {
        hits = JSON.parse(readFileSync(HITS_TMP, 'utf8'));
        writeFileSync(HITS, JSON.stringify(hits, null, 2));
        if (stampDates) hits = await groundHitsFile(store, HITS);
      } catch (err) {
        console.error(`jr hits write failed: ${err.message}`);
      }
    }
    const boards = skipBoards
      ? { jobCount: 0, leadCount: 0, companyCount: 0 }
      : await refreshBoardFresh(loadLeadJobs());
    const companyCount = boards.companyCount || writeCompanyTrack(hits.jobs || [], ['jobright']);
    const hb = {
      at: new Date().toISOString(),
      exitCode: status,
      elapsedSec: Math.round((Date.now() - started) / 1000),
      newMatches: companyCount,
      companyCount,
      boardLeadCount: boards.leadCount || 0,
      boardFreshCount: boards.jobCount || 0,
      loginWall: status === 2 || Boolean(hits.loginWallLikely),
      apiErrors: hits.apiErrors || [],
      mode: 'jr-companies',
    };
    const ok = status === 0 && !hb.loginWall;
    writeFileSync(HEARTBEAT, JSON.stringify(hb, null, 2));
    console.log(JSON.stringify({
      ok,
      companies: companyCount,
      boardLeads: hb.boardLeadCount,
      boardFresh: hb.boardFreshCount,
      loginWall: hb.loginWall,
      out: HITS,
    }));
  } finally {
    try { unlinkSync(HITS_TMP); } catch { /* ignore */ }
    releaseLock();
  }
}

main();
