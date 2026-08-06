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

function candidateSectionsFor(s: PoolStory): SectionKey[] {
  const out = new Set<SectionKey>();
  for (const g of s.geo) out.add(g);                                   // world / india
  for (const t of s.topic_tags) if (t.startsWith('sec:')) out.add(t.slice(4)); // base topical sections
  if ((s.nw ?? 0) >= MAJOR_NW_MIN) out.add('major_events');           // front-page eligibility by nw
  // WHOLE-WORD keyword match: pad + strip punctuation so "ai" matches the word
  // "ai", not the "ai" inside "said"/"campaign"/"air". Keywords under 3 chars are
  // dropped as too ambiguous even on a word boundary (e.g. "us", "ev", "ml").
  const hay = ` ${`${s.headline} ${s.body}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const has = (k: string) => k.length >= 3 && hay.includes(` ${k} `);
  for (const r of KW_RULES) if (r.kws.some(has)) { out.add(r.key); if (r.base) out.add(r.base); }
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
