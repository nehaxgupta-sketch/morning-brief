// src/lib/brief/fetch.ts  —  STEP 1: major call + minor call → one Pool
//
// Reuses the carried RSS engine (./clustering) verbatim — no internals touched:
//   • major = fetchStrategy_Rss(): the full backbone, clustered with a global
//     eventId, then FLATTENED here. Its section buckets become candidacy seeds;
//     its curated `major_events` bucket is DISCARDED — route (step 3) recomputes
//     the front page by nw (D1: biggest news regardless of area).
//   • minor = fetchStoriesFromFeeds(selected city/interest feeds): deduped but
//     eventId-STRIPPED by the helper, so minor stories carry provisional ids and
//     are merged into the major eventId space in step 2 (dedupe).
//
// Cross-pool global-uniqueness (D2) is enforced in dedupe.ts via the carried
// same-event primitives — not by refactoring the engine's clustering.

import {
  fetchStrategy_Rss, fetchStoriesFromFeeds,
  type RssPool, type RssStory,
} from './clustering';
import { FLAGS, minorFeedSet } from './config';
import type { Pool, PoolStory, StepFetch, UserSelections } from './types';

// Topical/geo sections we flatten. 'major_events' is intentionally omitted — it
// is a curated duplicate view of india/world; route rebuilds it from nw.
const FLATTEN_SECTIONS: string[] = [
  'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news',
];
const GEO = new Set<string>(['world', 'india']);

// Provisional ids for minor stories sit in a negative band so they never collide
// with the engine's non-negative eventIds; dedupe reassigns real ids.
let provisional = -1;

function toPoolStory(s: RssStory, sections: string[], call: 'major' | 'minor'): PoolStory {
  return {
    eventId: s.eventId != null ? s.eventId : provisional--,
    eventCorr: s.eventCorr || 1,
    headline: s.headline, body: s.body, source: s.source, source_url: s.source_url,
    published_at: s.published_at, nw: s.nw,
    geo: sections.filter((x) => GEO.has(x)) as Array<'world' | 'india'>,
    interests: s.interests || [], industries: s.industries || [],
    city_tags: s.city_tags || [], topic_tags: s.topic_tags || [],
    must_include: s.must_include,
    _call: call,
  };
}

// Flatten the sectioned RssPool → one PoolStory per eventId, UNIONING each
// cluster's section memberships into a candidacy seed (geo + `sec:*` topic_tags;
// dedupe turns the seed into candidateSections).
function flattenMajor(pool: RssPool): PoolStory[] {
  const byId = new Map<number, { story: PoolStory; secs: Set<string> }>();
  for (const sec of FLATTEN_SECTIONS) {
    const list = (pool as any)[sec] as RssStory[] | undefined;
    if (!list) continue;
    for (const s of list) {
      const id = s.eventId != null ? s.eventId : provisional--;
      const hit = byId.get(id);
      if (hit) hit.secs.add(sec);
      else byId.set(id, { story: toPoolStory({ ...s, eventId: id }, [sec], 'major'), secs: new Set([sec]) });
    }
  }
  const out: PoolStory[] = [];
  for (const { story, secs } of Array.from(byId.values())) {
    const arr = Array.from(secs);
    story.geo = Array.from(new Set([...story.geo, ...arr.filter((s) => GEO.has(s))])) as Array<'world' | 'india'>;
    for (const s of arr) if (!GEO.has(s)) story.topic_tags = Array.from(new Set([...(story.topic_tags || []), `sec:${s}`]));
    out.push(story);
  }
  return out;
}

async function fetchMinor(all: UserSelections[]): Promise<PoolStory[]> {
  if (!FLAGS.minorFetch) { console.log('[fetch] minor call disabled (BRIEF_MINOR_FETCH=off).'); return []; }
  const feeds = minorFeedSet(all);
  if (feeds.length === 0) { console.log('[fetch] minor call — no dedicated feeds for the selected areas.'); return []; }
  const urls = feeds.map((f) => f.url);
  // fetchStoriesFromFeeds takes one `secs` for all urls, so we geo-seed 'india'
  // conservatively; interest/city candidacy is recovered by keyword match in
  // dedupe. (v1 simplification — per-feed secs would need per-group calls.)
  const { stories, reachability } = await fetchStoriesFromFeeds(urls, { tier: 2, secs: ['india'], concurrency: 6 });
  console.log(`[fetch] minor call — ${reachability}`);
  return stories.map((s) => toPoolStory(s, ['india'], 'minor'));
}

export const fetchBrief: StepFetch = async (selections, date) => {
  const [rss, minor] = await Promise.all([
    fetchStrategy_Rss().catch((e: any) => { console.warn('[fetch] major call failed:', e?.message || e); return null; }),
    fetchMinor(selections),
  ]);
  const major = rss ? flattenMajor(rss) : [];
  const stories = [...major, ...minor];
  console.log(`[fetch] pool assembled — major ${major.length} + minor ${minor.length} = ${stories.length} stories (pre-dedupe).`);
  return {
    date,
    stories,
    markets: rss?.markets || { summary: '', indices: [] },
    _source: rss?._source || 'rss',
    _fetched_at: rss?._fetched_at || new Date().toISOString(),
  };
};
