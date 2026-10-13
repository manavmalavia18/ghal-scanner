export const DEFAULT_HIRINGCAFE_QUERIES = Object.freeze([
  'software engineer',
  'software developer',
  'backend engineer',
  'frontend engineer',
  'full stack engineer',
  'full stack developer',
  'platform engineer',
  'devops engineer',
  'site reliability engineer',
  'data engineer',
  'machine learning engineer',
  'mobile engineer',
  'ios engineer',
  'android engineer',
  'qa automation engineer',
  'security engineer',
]);

const SOFTWARE_SIGNAL = /\b(software|developer|back[ -]?end|front[ -]?end|full[ -]?stack|web|mobile|ios|android|platform|devops|site reliability|\bsre\b|data engineer|machine learning|ml engineer|ai engineer|qa|test automation|security engineer)\b/i;
const SENIOR_OR_MANAGEMENT = /\b(senior|sr\.?|staff|principal|lead|manager|director|head|architect|vice president|vp)\b/i;
const PHYSICAL_ENGINEERING = /\b(civil|structural|mechanical|manufacturing|electrical|construction|roadway|bridge|chemical|process|controls|plumbing|hvac)\b/i;

export function parseHiringCafeQueries(value) {
  const input = Array.isArray(value) ? value : String(value || '').split('|');
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const query = String(item || '').trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

export function acceptHiringCafeJob(job, { baseline = false } = {}) {
  if (baseline) return true;
  const title = String(job?.title || '').trim();
  if (!title || SENIOR_OR_MANAGEMENT.test(title) || PHYSICAL_ENGINEERING.test(title)) return false;
  return SOFTWARE_SIGNAL.test(title);
}
