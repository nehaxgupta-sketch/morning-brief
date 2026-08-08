// src/lib/brief/dedupe.ts  —  STEP 2: global-unique by event + candidacy tagging
//
// Collapses the merged major+minor pool to ONE story per real-world event
// (D2 — one story appears once in the entire brief) and tags each survivor with
// candidateSections: the sections it is INTRINSICALLY eligible for. Candidacy is
// user-agnostic; route (step 3) intersects it with each user's sections and
// removes a story from availability only when PLACED — the starvation rule.
//
// Major stories carry the engine's authoritative eventId. Minor stories arrive
// with provisional (negative) ids; each is merged into a matching major event
// via the CARRIED prefix-aware same-event primitive (Ledger A2 — the backstop
// that catches clustering's split events, e.g. russia/russian). Unmatched minor
// stories become their own events.
//
// ── Sprint 29.3 (topical relevance) ──────────────────────────────────────────
// Cause 1: a keyword hit used to add the interest AND its base section, so an
//   ambiguous keyword (Cricket's `test`) stamped the whole `sport` shelf and
//   leaked "missile test" into every Sport reader's brief. Now a keyword hit
//   tags ONLY the specific interest key (`Cricket`), never the base section.
// Cause 2: topical sections (business/technology/sport/culture/climate_health)
//   now come from the story's CONTENT, not its feed's tags. Feeds like CNBC are
//   tagged [world+business], so their world-politics stories used to pollute the
//   business shelf; a story is now a business/tech/sport/… candidate only if its
//   text matches that shelf's keyword signature. Geo (world/india) stays feed-
//   derived (reliable) and major_events stays nw-derived. SECTION_KW is the
//   tuning knob — seeded from the taxonomy's own keywords + a conservative core
//   for the thin shelves; eyeball a run and adjust.

import type { Pool, PoolStory, DedupedPool, DedupedStory, SectionKey } from './types';
import { MAJOR_NW_MIN, cityKey } from './config';
import { INTEREST_SECTIONS, PROFESSION_SECTIONS, CITY_FEEDS } from './feeds';
import { eventSignature, isSameEventPrefix, normaliseUrlForCompare } from './primitives';

// Candidacy keyword rules, built once from the carried taxonomy.
type KwRule = { key: SectionKey; base?: string; kws: string[] };
const KW_RULES: KwRule[] = (() => {
  const rules: KwRule[] = [];
  for (const [label, d] of Object.entries(INTEREST_SECTIONS as Record<string, any>))
    rules.push({ key: label, base: d.section, kws: (d.keywords || []).map((k: string) => k.toLowerCase()) });
  for (const [k, d] of Object.entries(PROFESSION_SECTIONS as Record<string, any>))
    rules.push({ key: `prof:${k}`, base: d.section, kws: (d.keywords || []).map((x: string) => x.toLowerCase()) });
  return rules;
})();
const CITY_SLUGS = Object.keys(CITY_FEEDS);

// ── Content-based section signatures (Cause 2) ───────────────────────────────
// The topical shelves a story can be classified into from its own text. Geo
// (world/india) and major_events are handled separately.
const SECTION_KEYS: SectionKey[] = ['business', 'technology', 'sport', 'culture', 'climate_health'];
// Tokens too generic / cross-topic to classify a shelf on their own (they caused
// the observed mis-tags, e.g. `test` → "missile test" landing in sport).
const AMBIGUOUS_KW = new Set(['test', 'study', 'research', 'api', 'media', 'campaign', 'agency', 'space', 'brand']);
// High-precision extras where the taxonomy is thin (Business & Economy / Markets
// & Investing carry no keywords; Environment & Climate carries none).
const SECTION_KW_EXTRA: Record<string, string[]> = {
  business:       ['stock market', 'share market', 'stocks', 'shares', 'sensex', 'nifty', 'ipo', 'earnings', 'dividend', 'merger', 'acquisition', 'gdp', 'inflation', 'rupee', 'repo rate', 'valuation', 'quarterly results', 'bond yield', 'revenue', 'profit'],
  technology:     ['cybersecurity', 'smartphone', 'gadget', 'app store', 'chatgpt', 'gpu', 'operating system'],
  sport:          ['tournament', 'championship', 'wicket', 'olympics', 'medal', 'batsman', 'bowler', 'striker', 'knockout', 'semi-final'],
  culture:        ['film festival', 'actor', 'actress', 'filmmaker', 'box office', 'web series', 'art gallery'],
  climate_health: ['climate', 'carbon', 'emission', 'emissions', 'global warming', 'renewable', 'solar power', 'pollution', 'biodiversity', 'wildlife', 'monsoon', 'heatwave', 'deforestation'],
};
// Aggregate the taxonomy's own keywords by section (so this tracks feeds_config
// edits), add the extras, drop the ambiguous tokens and anything under 3 chars.
const SECTION_KW: Record<string, string[]> = (() => {
  const acc: Record<string, Set<string>> = {};
  for (const sec of SECTION_KEYS) acc[sec] = new Set((SECTION_KW_EXTRA[sec] || []).map((k) => k.toLowerCase()));
  const ingest = (tax: Record<string, any>) => {
    for (const d of Object.values(tax)) {
      const sec = d?.section;
      if (sec && acc[sec] && Array.isArray(d?.keywords)) for (const k of d.keywords) acc[sec].add(String(k).toLowerCase());
    }
  };
  ingest(INTEREST_SECTIONS as Record<string, any>);
  ingest(PROFESSION_SECTIONS as Record<string, any>);
  const out: Record<string, string[]> = {};
  for (const sec of SECTION_KEYS) out[sec] = Array.from(acc[sec]).filter((k) => k.length >= 3 && !AMBIGUOUS_KW.has(k));
  return out;
})();

function candidateSectionsFor(s: PoolStory): SectionKey[] {
  const out = new Set<SectionKey>();
  for (const g of s.geo) out.add(g);                                   // world / india (geo — reliable)
  if ((s.nw ?? 0) >= MAJOR_NW_MIN) out.add('major_events');           // front-page eligibility by nw
  // WHOLE-WORD keyword match: pad + strip punctuation so "ai" matches the word
  // "ai", not the "ai" inside "said"/"campaign"/"air". Keywords under 3 chars are
  // dropped as too ambiguous even on a word boundary (e.g. "us", "ev", "ml").
  const hay = ` ${`${s.headline} ${s.body}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const has = (k: string) => k.length >= 3 && hay.includes(` ${k} `);
  // TOPICAL shelves from CONTENT, not the feed's tags (Cause 2).
  for (const sec of SECTION_KEYS) if (SECTION_KW[sec].some(has)) out.add(sec);
  // Specific interest keys (Cricket, AI, …) from keyword — key ONLY, never the
  // base shelf (Cause 1), so an ambiguous keyword can't stamp the whole shelf.
  for (const r of KW_RULES) if (r.kws.some(has)) out.add(r.key);
  for (const c of s.city_tags) out.add(cityKey(c));                    // explicit city tags
  for (const slug of CITY_SLUGS) if (has(slug)) out.add(`city:${slug}`); // city name match (whole word)
  return Array.from(out);
}

export const dedupeBrief = (pool: Pool): DedupedPool => {
  const majors: PoolStory[] = [];
  const minors: PoolStory[] = [];
  for (const s of pool.stories) (s._call === 'major' ? majors : minors).push(s);

  // 1) major is already eventId-clustered — collapse members, keep the
  //    best-corroborated headline as representative, union tags (no field loss).
  const byEvent = new Map<number, PoolStory>();
  for (const s of majors) {
    const cur = byEvent.get(s.eventId);
    if (!cur) { byEvent.set(s.eventId, s); continue; }
    byEvent.set(s.eventId, (s.eventCorr || 1) > (cur.eventCorr || 1) ? mergeTags(s, cur) : mergeTags(cur, s));
  }
  const majorEvents = Array.from(byEvent.values());
  const majorSigs = majorEvents.map((s) => ({ s, sig: eventSignature(s.headline), url: normaliseUrlForCompare(s.source_url) }));

  // 2) merge each minor story into a matching major (exact-url OR same-event),
  //    else into an already-kept minor, else keep as a fresh event.
  let merged = 0, fresh = 0;
  let nextId = (majorEvents.reduce((m, s) => Math.max(m, s.eventId), 0)) + 1;
  const minorKept: PoolStory[] = [];
  const minorSigs: { s: PoolStory; sig: Set<string>; url: string }[] = [];
  for (const m of minors) {
    const url = normaliseUrlForCompare(m.source_url);
    const sig = eventSignature(m.headline);
    const hitMajor = majorSigs.find((x) => (x.url && x.url === url) || isSameEventPrefix(x.sig, sig));
    if (hitMajor) { mergeTags(hitMajor.s, m); merged++; continue; }
    const hitMinor = minorSigs.find((x) => (x.url && x.url === url) || isSameEventPrefix(x.sig, sig));
    if (hitMinor) { mergeTags(hitMinor.s, m); merged++; continue; }
    m.eventId = nextId++;
    minorKept.push(m);
    minorSigs.push({ s: m, sig, url });
    fresh++;
  }

  const stories: DedupedStory[] = [...majorEvents, ...minorKept].map(
    (s) => ({ ...s, candidateSections: candidateSectionsFor(s) }),
  );
  console.log(`[dedupe] ${pool.stories.length} → ${stories.length} unique events (major ${majorEvents.length}, minor merged ${merged}, new ${fresh}).`);
  return { date: pool.date, stories, markets: pool.markets };
};

// Fold `other`'s tags into `primary`, keep the higher nw/corroboration. Returns primary.
function mergeTags(primary: PoolStory, other: PoolStory): PoolStory {
  primary.interests  = uniq([...(primary.interests || []),  ...(other.interests || [])]);
  primary.industries = uniq([...(primary.industries || []), ...(other.industries || [])]);
  primary.city_tags  = uniq([...(primary.city_tags || []),  ...(other.city_tags || [])]);
  primary.topic_tags = uniq([...(primary.topic_tags || []), ...(other.topic_tags || [])]);
  primary.geo        = uniq([...(primary.geo || []),        ...(other.geo || [])]) as Array<'world' | 'india'>;
  if ((other.nw ?? -1) > (primary.nw ?? -1)) primary.nw = other.nw;
  primary.eventCorr = Math.max(primary.eventCorr || 1, other.eventCorr || 1);
  return primary;
}
const uniq = <T,>(xs: T[]): T[] => Array.from(new Set(xs));
