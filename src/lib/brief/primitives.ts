// src/lib/generate-brief/utils.ts
//
// Modularization stage 3 - cross-cutting PURE helpers, moved verbatim from
// generate-brief.tsx (only `export` added to top-level declarations). No
// behaviour, no process.env, no I/O: date helpers, the JSON extractor, sleep,
// compare-only URL normalisation, and the recency + event-dedup primitives
// (§11). Self-contained: imports nothing.

// ─── Date helpers (IST) ─────────────────────────────────────────────────────

export function getISTDate(offsetDays = 0): string {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split('T')[0];
}

export function isWeekend(): boolean {
  // IST day of week — used to flex the Editorial's Long Read length.
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  const dow = new Date(istMs).getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
}

// ─── JSON extraction helper ─────────────────────────────────────────────────

export function extractJsonObject(text: string): any {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) {
    throw new Error(`JSON truncated. Length=${cleaned.length}, last 200: ${cleaned.slice(-200)}`);
  }
  const candidate = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (e: any) {
    throw new Error(`JSON parse failed: ${e.message}. Near end: ${candidate.slice(-300)}`);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Compare-only URL normalisation. We do NOT mutate the stored source_url
// (other stages match it verbatim) — this is purely for duplicate detection.
export function normaliseUrlForCompare(url: string | undefined | null): string {
  let u = String(url || '').trim().toLowerCase();
  if (!u) return '';
  u = u.replace(/^https?:\/\//, '').replace(/^www\./, '');
  u = u.split(/[?#]/)[0];
  u = u.replace(/\/(amp|lite)\/?$/i, '/');
  u = u.replace(/\/+$/g, '');
  return u;
}

export const RECENCY_HOURS_DEFAULT = 24;
export const RECENCY_HOURS_MAJOR = 72;

// Weekend carry (Sprint 18.2): a Monday brief must still surface Saturday/Sunday
// hard news, and weekend briefs reach back over Friday — otherwise the 24h
// window silently bins the weekend's biggest stories (Iran talks, an election
// result) on Monday morning. Importance ranking (event corroboration) and
// cluster-freshest dating keep genuinely stale single-source items from leading,
// so widening the window does not resurface dead stories. Mon = 72h, Sat/Sun =
// 48h, weekdays = 24h; major_events/climate stay at least 72h.
export function recencyWindowHours(section: string): number {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  const dow = new Date(istMs).getUTCDay(); // 0 = Sun … 6 = Sat
  const base = dow === 1 ? 72 : (dow === 0 || dow === 6) ? 48 : RECENCY_HOURS_DEFAULT;
  const major = section === 'major_events' || section === 'climate_health';
  return major ? Math.max(RECENCY_HOURS_MAJOR, base) : base;
}

export function isWithinRecencyWindow(publishedAt: any, section: string): boolean {
  if (!publishedAt || typeof publishedAt !== 'string') return true; // permissive on missing
  // Date-only strings (YYYY-MM-DD) must be parsed as end-of-day IST, not
  // midnight UTC. Without this, "2026-06-06" parses as 5:30 AM IST on 6 June,
  // which at any IST morning cron run (e.g. 6:38 AM on 7 June) lands ~25h
  // old and gets dropped from the 24h-window sections — killing every story
  // gpt-5 dates as "yesterday" even if the event was actually 8 PM yesterday.
  let normalized = publishedAt.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T23:59:59+05:30`;
  }
  const ts = Date.parse(normalized);
  if (isNaN(ts)) return true; // permissive on unparseable
  const hours = recencyWindowHours(section);
  const ageHours = (Date.now() - ts) / (1000 * 60 * 60);
  return ageHours <= hours;
}

// ─── Semantic dedup: major_events ↔ world/india ─────────────────────────────
//
// gpt-5 sometimes returns the same underlying story in both major_events and
// world/india with different headlines or sources. Fingerprint dedup catches
// only exact URL matches; this catches semantic duplicates by comparing
// significant-word overlap between headlines. Keep in major_events (higher
// priority), drop from world/india.
export const STOPWORDS = new Set([
  'a','an','the','of','in','on','at','to','for','and','or','but','with','by',
  'from','as','is','are','was','were','be','been','being','has','have','had',
  'do','does','did','will','would','could','should','may','might','must','can',
  'this','that','these','those','it','its','their','his','her','our','your',
  'over','under','into','out','up','down','off','about','than','then','also',
  'new','says','said','set','vs','v','amid','after','before','today','yesterday',
]);

export function significantWords(headline: string): Set<string> {
  if (!headline || typeof headline !== 'string') return new Set();
  const tokens = headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(tokens);
}

// Raised from 3 to 4 (Sprint 15.1): with major_events now a small curated
// front page, a 3-word overlap was wrongly dropping *different* India/World
// stories that merely shared common words (Modi, India, court, …) with a lead.
// 4 still catches true duplicates (a promoted story shares its whole headline)
// while protecting the India shelf. A duplicate is a better failure than a
// silently dropped story.
export const SEMANTIC_DEDUP_THRESHOLD = 4;

export function semanticOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of Array.from(a)) if (b.has(w)) n++;
  return n;
}

// ─── Same-event near-dup (Sprint 18.2) ──────────────────────────────────────
// Safety net mirroring the engine's eventSig: fold the highest-frequency news
// synonyms (killed/dead, blast/explosion, resigns/quits) and keep salient
// figures so two reworded versions of ONE story inside the SAME rendered section
// (e.g. an oil-sanctions pair in world) can be collapsed to one. Applied
// per-section only and conservatively — a duplicate is a safer failure than a
// dropped story, so this never reaches across sections.
export const EVENT_SYN_GB: Record<string, string> = {
  killed: '@kill', kills: '@kill', kill: '@kill', dead: '@kill', death: '@kill', deaths: '@kill', die: '@kill', dies: '@kill', died: '@kill', killing: '@kill', toll: '@kill',
  blast: '@blast', blasts: '@blast', explosion: '@blast', explosions: '@blast', explode: '@blast', exploded: '@blast', explodes: '@blast',
  fire: '@fire', blaze: '@fire', inferno: '@fire',
  resign: '@resign', resigns: '@resign', resigned: '@resign', resignation: '@resign', quit: '@resign', quits: '@resign', step: '@resign', steps: '@resign', stepping: '@resign', stepped: '@resign',
  talks: '@talks', talk: '@talks', negotiation: '@talks', negotiations: '@talks', deal: '@talks',
  strike: '@strike', strikes: '@strike', struck: '@strike', attack: '@strike', attacks: '@strike',
  bust: '@seize', seize: '@seize', seized: '@seize', seizes: '@seize', seizure: '@seize',
  poll: '@vote', polls: '@vote', vote: '@vote', votes: '@vote', election: '@vote', elections: '@vote', runoff: '@vote',
};
export function eventSignature(headline: string): Set<string> {
  const out = new Set<string>();
  const toks = String(headline || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
  for (const w of toks) {
    if (!w) continue;
    if (/^\d+$/.test(w)) { if (w.length >= 2 && parseInt(w, 10) >= 5) out.add('#' + w); continue; }
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    out.add(EVENT_SYN_GB[w] || w);
  }
  return out;
}
export function isSameEvent(a: Set<string>, b: Set<string>): boolean {
  const shared = semanticOverlap(a, b);
  if (shared >= 4) return true;
  const small = Math.min(a.size, b.size) || 1;
  return shared >= 3 && shared / small >= 0.6;
}

// ─── Prefix-aware same-event (Sprint 26 F2/F7) ──────────────────────────────
// The plain semanticOverlap above is exact-token: it does NOT stem, so
// "russia" and "russian" (or "strike"/"strikes" when one side didn't hit the
// synonym map) count as DIFFERENT tokens. That is exactly why two "massive
// Russian strike on Kyiv" stories got separate eventIds and slipped past every
// existing dedup: their signatures shared only {kyiv, massive, @strike} = 3,
// one short of isSameEvent's bar. This variant treats two tokens as matching
// when they are equal OR one is a prefix of the other AND the shorter is ≥5
// chars (so russia⊂russian merges, but short accidental prefixes like
// "pol"⊂"police" do not). Verified by hand not to over-merge the distinct
// pairs in the RCA. Used ONLY by the section-level guard and the final-brief
// invariant checker — never to widen the engine's clustering threshold
// (RCA §10 #4: do NOT lower EVENT_SIM_THRESHOLD blindly).
export const EVENT_PREFIX_MIN = 5;
export function prefixTokenMatch(x: string, y: string): boolean {
  if (x === y) return true;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (shorter.length < EVENT_PREFIX_MIN) return false;
  return longer.startsWith(shorter);
}
export function prefixOverlap(a: Set<string>, b: Set<string>): number {
  const A = Array.from(a);
  const B = Array.from(b);
  let n = 0;
  for (const x of A) {
    for (const y of B) {
      if (prefixTokenMatch(x, y)) { n++; break; }
    }
  }
  return n;
}
export function isSameEventPrefix(a: Set<string>, b: Set<string>): boolean {
  const shared = prefixOverlap(a, b);
  if (shared >= 4) return true;
  const small = Math.min(a.size, b.size) || 1;
  return shared >= 3 && shared / small >= 0.6;
}
