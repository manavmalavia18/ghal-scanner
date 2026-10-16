#!/usr/bin/env node
/**
 * Wellfound lead feed — public, unauthenticated search pages
 * (wellfound.com/role/<slug>), no login wall, no Cloudflare challenge.
 * Wellfound's "Apply" button is JS-driven (no plain href to parse), so we
 * can't extract a real apply URL the way lib/jr-board-leads.mjs does for
 * JobRight/HiringCafe. Instead we read the embedded __NEXT_DATA__ Apollo
 * cache, which tells us the company's Wellfound slug AND which ATS served
 * the listing (atsSource) — we use the Wellfound slug as our best guess
 * for the company's real ATS board slug and construct a candidate URL.
 *
 * This produces LEADS only, in the same {fetchedAt, jobs:[{url,...}]}
 * shape discover-boards.mjs already consumes — the existing board-
 * discovery + tracked-boards-scan pipeline does the real verification
 * (a bad slug guess 404s and the tracked-boards dead-board cooldown
 * drops it; nothing from Wellfound's own data ever reaches the Jobs UI).
 *
 *   node fetch-wellfound-feed.mjs
 *   node fetch-wellfound-feed.mjs --loop --sleep 900
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseWellfoundNextData, dedupeByBoardUrl } from './lib/wellfound-parse.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(ROOT, 'data/wellfound-feed.json');
const HEARTBEAT = resolve(ROOT, 'data/scan-wellfound-heartbeat.json');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const LOOP = process.argv.includes('--loop');
const SLEEP_SEC = Math.max(60, Number(argVal('--sleep', '1800')) || 1800);
const PAGES_PER_ROLE = Math.max(1, Math.min(10, Number(argVal('--pages', '2')) || 2));

// Role slugs confirmed to exist as Wellfound /role/<slug> search pages —
// mirrors the software + data title universe used elsewhere in Scoutgrid.
const ROLE_SLUGS = [
  'software-engineer',
  'backend-engineer',
  'frontend-engineer',
  'full-stack-engineer',
  'devops-engineer',
  'site-reliability-engineer',
  'data-engineer',
  'machine-learning-engineer',
  'mobile-engineer',
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function fetchRolePage(roleSlug, page) {
  const url = `https://wellfound.com/role/${roleSlug}` + (page > 1 ? `?page=${page}` : '');
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
    if (!res.ok) return [];
    const html = await res.text();
    const nextData = extractNextData(html);
    if (!nextData) return [];
    return parseWellfoundNextData(nextData);
  } catch (err) {
    console.error(`wellfound ${roleSlug} page ${page}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function runOnce() {
  const started = Date.now();
  let allRows = [];
  for (const role of ROLE_SLUGS) {
    for (let page = 1; page <= PAGES_PER_ROLE; page += 1) {
      const rows = await fetchRolePage(role, page);
      allRows = allRows.concat(rows);
      if (!rows.length && page === 1) break; // role slug likely invalid, skip remaining pages
    }
  }

  const deduped = dedupeByBoardUrl(allRows);
  const nowIso = new Date().toISOString();

  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ fetchedAt: nowIso, jobs: deduped }, null, 2));
  writeFileSync(HEARTBEAT, JSON.stringify({
    at: nowIso,
    exitCode: 0,
    rolesScanned: ROLE_SLUGS.length,
    rawLeads: allRows.length,
    uniqueBoardLeads: deduped.length,
    elapsedSec: Math.round((Date.now() - started) / 1000),
  }, null, 2));

  console.log(`[${nowIso}] wellfound: ${allRows.length} raw leads -> ${deduped.length} unique board candidates`);
}

async function main() {
  if (LOOP) {
    for (;;) {
      await runOnce();
      await new Promise((r) => setTimeout(r, SLEEP_SEC * 1000));
    }
  } else {
    await runOnce();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
