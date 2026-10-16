// Parses Wellfound's embedded Next.js __NEXT_DATA__ Apollo cache into
// candidate official-board leads. Wellfound tells us the company name, a
// Wellfound-internal slug, and which ATS platform served the listing
// (atsSource) — we use that to construct a CANDIDATE official board URL
// (e.g. https://jobs.ashbyhq.com/{slug}) using the Wellfound slug as our
// best guess. We never show Wellfound's own listing data to users; this
// only produces leads for the existing board-discovery pipeline, which
// already tolerates bad guesses (the tracked-boards scan's dead-board
// cooldown drops anything that doesn't resolve to a real board).

const ATS_SOURCE_MAP = {
  'AtsIntegration::Greenhouse::Listing': 'greenhouse',
  'AtsIntegration::Ashby::Listing': 'ashby',
  'AtsIntegration::Lever::Listing': 'lever',
};

export function atsKindFromSource(atsSource) {
  return ATS_SOURCE_MAP[String(atsSource || '')] || '';
}

export function boardUrlForAts(kind, slug) {
  const s = String(slug || '').trim();
  if (!s) return '';
  if (kind === 'greenhouse') return `https://job-boards.greenhouse.io/${s}`;
  if (kind === 'ashby') return `https://jobs.ashbyhq.com/${s}`;
  if (kind === 'lever') return `https://jobs.lever.co/${s}`;
  return '';
}

/**
 * @param {object} nextData - parsed __NEXT_DATA__ JSON from a Wellfound
 *   role-search page.
 * @returns {{title:string, company:string, url:string, location:string,
 *   salary:string, postedAt:string, ats:string}[]}
 */
export function parseWellfoundNextData(nextData) {
  const apollo = nextData?.props?.pageProps?.apolloState?.data;
  if (!apollo || typeof apollo !== 'object') return [];

  const startupsBySlug = new Map();
  const jobListingToStartup = new Map();
  for (const [key, value] of Object.entries(apollo)) {
    if (!key.startsWith('StartupResult:') || !value) continue;
    const refs = Array.isArray(value.highlightedJobListings) ? value.highlightedJobListings : [];
    for (const ref of refs) {
      const jobKey = ref && ref.__ref;
      if (jobKey) jobListingToStartup.set(jobKey, value);
    }
  }

  const rows = [];
  for (const [key, value] of Object.entries(apollo)) {
    if (!key.startsWith('JobListingSearchResult:') || !value) continue;
    const startup = jobListingToStartup.get(key);
    if (!startup) continue;
    const atsKind = atsKindFromSource(value.atsSource);
    if (!atsKind) continue; // unsupported ATS (e.g. custom/off-platform) — nothing to resolve to
    const url = boardUrlForAts(atsKind, startup.slug);
    if (!url) continue;
    const locationNames = Array.isArray(value.locationNames) ? value.locationNames : [];
    const postedMs = typeof value.liveStartAt === 'number' ? value.liveStartAt * 1000 : NaN;
    rows.push({
      title: value.title || value.primaryRoleTitle || '',
      company: startup.name || startup.slug || '',
      url,
      location: value.remote ? 'Remote' : (locationNames[0] || ''),
      salary: value.compensation || '',
      postedAt: Number.isFinite(postedMs) ? new Date(postedMs).toISOString() : '',
      ats: atsKind,
    });
  }
  return rows;
}

/** Dedupe to one candidate board URL per company — board-discovery only
 * needs to see each board once to register it as a lead. */
export function dedupeByBoardUrl(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row.url || seen.has(row.url)) continue;
    seen.add(row.url);
    out.push(row);
  }
  return out;
}
