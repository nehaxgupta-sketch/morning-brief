// src/lib/generate-brief/quality.ts
//
// Modularization stage 4 - the fetch-time quality gate, moved verbatim from
// generate-brief.tsx: MAJOR_DEDUP_DEPTH, PLACEMENT_V2 placement (§12), section-
// level dedup (§13), enforceQualityRules (§14), and writer ranking/subset (§15).
// Only `export` was added to top-level declarations. fetch.ts (next stage) will
// import enforceQualityRules + buildSubset from here.

import {
  isWithinRecencyWindow,
  significantWords,
  SEMANTIC_DEDUP_THRESHOLD,
  semanticOverlap,
  eventSignature,
  isSameEvent,
  prefixTokenMatch,
  isSameEventPrefix,
} from '@/lib/generate-brief/utils';
import type {
  RawStory,
  RawStories,
} from '@/lib/generate-brief/types';
import {
  isWhitelistedSource,
  publisherKey,
  sourceTier,
} from '@/lib/whitelist';

// Sprint 20.2 — the front page over-provisions to 12 leads for RANKING, but the
// writer takes only the top ~5 into major_events. Deduping india/world against
// all 12 ORPHANED the leads ranked 6-12: genuinely big India stories (a fatal
// building collapse, a passport-policy ruling, a new IB chief) were lifted onto
// the front page, deduped out of India, then never written because they didn't
// make the major top-5. Cap the dedup set to the written depth so those stories
// stay in their home section and get written. Default 6 (top-5 written + 1
// ordering buffer); MAJOR_DEDUP_DEPTH=12 restores the prior behaviour. The
// post-write cross-section dedup remains the backstop against any rare overlap.
export const MAJOR_DEDUP_DEPTH = Math.max(1, parseInt(process.env.MAJOR_DEDUP_DEPTH || '6', 10));
// ─── Sprint 22 — PLACEMENT_V2: one event → one home, by the engine's eventId ──
//
// Replaces the four uncoordinated fuzzy matchers (semantic-vs-major, exact
// fingerprint, within-section eventSignature, post-write URL) with a single
// structural invariant: every story carries the engine's event-cluster id
// (rss-retrieval stamps it), so an event is placed in exactly ONE section and a
// duplicate becomes impossible by construction — not by tuning a threshold.
//
// Behind PLACEMENT_V2 (default off — ships dark; flip on, run on the shared
// brief, confirm the [placement-v2] log, then default it). When on, matcher 1
// (the over-aggressive false-dropper) is skipped; the exact/near-dup passes are
// left as harmless subsets; this pass is authoritative and runs last.
// ============================================================================
// SECTION 12:  PLACEMENT ENGINE (PLACEMENT_V2)
// ----------------------------------------------------------------------------
// One-event-one-home authority. placeByEventId() assigns each clustered event
// a single home section and removes the front-page repeat (re-injection
// fallback lives in the writer path). dropSemanticDuplicatesAgainstMajor()
// clears topical twins of a curated lead.
// Fns:   placeByEventId, dropSemanticDuplicatesAgainstMajor
// Flags: PLACEMENT_V2, PLACEMENT_OVERLAY, PLACEMENT_MAJOR_CAP(=5)
// ============================================================================
export const PLACEMENT_V2 = (process.env.PLACEMENT_V2 || '').toLowerCase() === 'on';
export const PLACEMENT_MAJOR_CAP = 5; // front-page capacity (Sprint 22 decision)
// Shared-brief precedence (decided): india above world for the audience.
export const PLACEMENT_ORDER = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];

// ─── Sprint 23 — front-page OVERLAY (one-event-one-home, minus the front page) ─
// PLACEMENT_V2 gives major_events the FIRST claim on every event, which lifts the
// day's biggest stories OUT of world/india — so the topical tabs lead with
// leftovers (a wildfire over Iran-US; a cricket record over a fatal flood). The
// RSS engine already keeps each lead in its topical pool (see rss-retrieval:
// "India and World keep their FULL pools"); only the downstream dedup drains
// them. PLACEMENT_OVERLAY treats major_events as a HIGHLIGHT LAYER, not an
// extraction: one-event-one-home still holds across the 7 topical sections (no
// topical duplication), but a front-page lead ALSO renders in its topical home.
// Effective only when PLACEMENT_V2 is on.
//
// ─── DECISION (2026-06-29) — suppress the repeat: EXTRACTION, not overlay ──────
// The overlay made a front-page lead ALSO appear in its topical home (the
// newspaper repeat). Product decision: an event must appear exactly ONCE. So
// PLACEMENT_OVERLAY now DEFAULTS OFF — major_events claims its events out of the
// topical sections (extraction). The orphaning bug that extraction historically
// risked ("event was on the front page → dropped from india → then the front
// page over-filled/under-wrote → it vanished from BOTH") is structurally
// impossible here, because:
//   (a) the front page is trimmed to capacity FIRST (below), so an event ranked
//       out of the top-5 is never claimed, and its topical twin survives; and
//   (b) the topical twin ALWAYS exists — rss-retrieval builds major_events by
//       SELECTING (copying) PoolItems that REMAIN in pool.india/world (see
//       rss-retrieval ~L1018: the lead is filled from indiaRanked/restRanked
//       without removing them). So "fallback to home" is automatic: dropping an
//       event from the front page cannot orphan it — the section copy is intact.
// Revert: PLACEMENT_OVERLAY=on restores the newspaper repeat exactly.
export const PLACEMENT_OVERLAY = (process.env.PLACEMENT_OVERLAY || 'off').toLowerCase() === 'on';
// Topical precedence (front page excluded — it overlays, it does not claim).
export const PLACEMENT_TOPICAL_ORDER = ['india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];

export function placeByEventId(cleaned: any, eventHomeSection?: Map<number, string>, curatedLeadCount?: number): void {
  // 1. Trim the front page to capacity FIRST. A lead ranked below the cut must
  //    NOT vanish: it falls back to its topical home. The original design only
  //    *checked* whether the topical twin still existed — but recency/cap/near-dup
  //    run before this and often drop the twin, so cut leads orphaned (proven live:
  //    "ASSERT FAILED — 7 event(s) … NO topical home"). Fix (Sprint 25.1): when a
  //    cut lead's twin is gone, RE-INJECT the cut story object itself into its home
  //    section (captured from the unfiltered pool in eventHomeSection). Guarantees
  //    fallback by construction instead of hoping the twin survived.
  let cutRehomed = 0;     // cut lead whose twin already survived in its section
  let cutReinjected = 0;  // cut lead we had to re-insert (twin was filtered away)
  let cutKeptOnFront = 0; // cut lead with no topical home in the pool — kept on the front page
  let orphaned = 0;       // cut lead with no recoverable home (should now be ~0)
  const atPlacement = Array.isArray(cleaned.major_events) ? cleaned.major_events.length : 0;
  if (Array.isArray(cleaned.major_events) && cleaned.major_events.length > PLACEMENT_MAJOR_CAP) {
    const cut = cleaned.major_events.slice(PLACEMENT_MAJOR_CAP);
    cleaned.major_events = cleaned.major_events.slice(0, PLACEMENT_MAJOR_CAP);

    // Which eventIds currently survive in some topical section?
    const topicalIds = new Set<number>();
    for (const sec of PLACEMENT_TOPICAL_ORDER) {
      for (const s of (cleaned[sec] || [])) {
        if (s && typeof s.eventId === 'number') topicalIds.add(s.eventId);
      }
    }

    // Sprint 27.1 (N3) — stamp every cut lead's surviving representation as an
    // ex-front-page lead (`exLead` + its curated rank). buildSubset ranks and
    // F7's delivery report read these stamps: the 07-05 audit found three
    // curated leads (nw up to 7) that never reached any reader, with no line
    // anywhere saying so. Stamping makes their fate trackable end-to-end.
    let cutIdx = 0;
    for (const story of cut) {
      cutIdx++;
      const leadRank = PLACEMENT_MAJOR_CAP + cutIdx; // curated rank 6..12
      const id = (story && typeof story.eventId === 'number') ? story.eventId : null;
      if (id == null) { orphaned++; continue; } // no id → cannot re-home; counted, logged below
      if (topicalIds.has(id)) {
        cutRehomed++;
        // Stamp the SURVIVING TWIN in its topical section.
        for (const sec of PLACEMENT_TOPICAL_ORDER) {
          const arr = cleaned[sec];
          if (!Array.isArray(arr)) continue;
          const twin = arr.find((s: any) => s && typeof s.eventId === 'number' && s.eventId === id);
          if (twin) { (twin as any).exLead = true; (twin as any).leadRank = leadRank; break; }
        }
        continue;
      }
      // Twin was filtered away → re-inject the cut story into its captured home.
      const home = eventHomeSection?.get(id);
      (story as any).exLead = true;
      (story as any).leadRank = leadRank;
      if (home && Array.isArray(cleaned[home])) {
        cleaned[home].push(story);
        topicalIds.add(id);
        cutReinjected++;
      } else if (home === undefined && eventHomeSection) {
        // Event never had a topical home in the unfiltered pool (e.g. a major-only
        // event). Keep it on the front page rather than lose it — the safe fallback.
        cleaned.major_events.push(story);
        cutKeptOnFront++;
      } else {
        orphaned++; // truly unrecoverable — should be ~0; named loudly below.
      }
    }
  }

  // 2. One event → one home: walk sections in precedence; the first section to
  //    carry an event keeps it, every later occurrence (cross- OR within-section)
  //    is dropped. Stories with no eventId can't be matched, so they're kept.
  const claimed = new Map<number, string>();
  let removed = 0;
  // OVERLAY: the front page is a highlight layer, not a claimant — walk the
  // TOPICAL sections only, so a lead stays in its topical home AND on the front
  // page. Non-overlay (legacy): major_events is first and claims events out of
  // the topical sections (extraction).
  const placementOrder = PLACEMENT_OVERLAY ? PLACEMENT_TOPICAL_ORDER : PLACEMENT_ORDER;
  for (const sec of placementOrder) {
    const arr = cleaned[sec];
    if (!Array.isArray(arr)) continue;
    const kept: any[] = [];
    for (const s of arr) {
      const id = (s && typeof s.eventId === 'number') ? s.eventId : null;
      if (id == null) { kept.push(s); continue; }
      if (claimed.has(id)) { removed++; continue; }
      claimed.set(id, sec);
      kept.push(s);
    }
    cleaned[sec] = kept;
  }

  // 3. Phase-D assert — holds by construction; log loudly if ever violated so a
  //    clustering regression is a single named line, not silent duplication.
  const homeOf = new Map<number, string>();
  let collisions = 0;
  for (const sec of placementOrder) {
    for (const s of (cleaned[sec] || [])) {
      const id = (s && typeof s.eventId === 'number') ? s.eventId : null;
      if (id == null) continue;
      const prev = homeOf.get(id);
      if (prev && prev !== sec) collisions++;
      else homeOf.set(id, sec);
    }
  }
  // Sprint 27.1 (N3) — full cut accounting. The 07-05 run logged "1 twin +
  // 5 re-injected" against 7 cuts because (a) leads lost to pre-placement
  // filters were invisible and (b) kept-on-front was folded into re-injected.
  // Every lead is now in exactly one bucket, and curated vs at-placement is
  // explicit, so cut = twin + re-injected + kept-on-front + orphaned holds
  // arithmetically on every run.
  const cutTotal = Math.max(0, atPlacement - PLACEMENT_MAJOR_CAP);
  const lostPre = typeof curatedLeadCount === 'number' && curatedLeadCount > 0
    ? Math.max(0, curatedLeadCount - atPlacement) : null;
  const acct = `curated=${curatedLeadCount ?? 'n/a'} at-placement=${atPlacement}${lostPre != null ? ` lost-to-pre-placement-filters=${lostPre}` : ''}, cut=${cutTotal} → twin-survived=${cutRehomed} + re-injected=${cutReinjected} + kept-on-front=${cutKeptOnFront} + orphaned=${orphaned}`;
  if (collisions > 0) {
    console.error(`[placement-v2] ASSERT FAILED — ${collisions} event(s) in >1 section after placement. (${acct})`);
  } else if (orphaned > 0) {
    console.error(`[placement-v2] ASSERT FAILED — ${orphaned} cut event(s) unrecoverable (no eventId/home; lost). (${acct})`);
  } else {
    console.log(`[placement-v2] ${PLACEMENT_OVERLAY ? 'overlay (front-page highlights also shown in their topical home)' : 'extraction (one home per event; front-page leads not repeated topically)'} — ${claimed.size} topical event(s) placed, ${removed} cross/within-section dupe(s) removed, major≤${PLACEMENT_MAJOR_CAP}. Accounting: ${acct}.`);
  }
}

export function dropSemanticDuplicatesAgainstMajor(raw: any): { kept: any; droppedCount: number } {
  const majorSets = (raw.major_events || []).slice(0, MAJOR_DEDUP_DEPTH).map((s: any) => significantWords(s?.headline || ''));
  if (majorSets.length === 0) return { kept: raw, droppedCount: 0 };

  let droppedCount = 0;
  const filterSection = (arr: any[], sectionName: string): any[] => {
    if (!Array.isArray(arr)) return arr;
    return arr.filter((story) => {
      const set = significantWords(story?.headline || '');
      for (const mset of majorSets) {
        if (semanticOverlap(set, mset) >= SEMANTIC_DEDUP_THRESHOLD) {
          console.log(`[semantic-dedup] dropping ${sectionName} story (overlaps major_events): "${(story?.headline || '').slice(0, 80)}"`);
          droppedCount++;
          return false;
        }
      }
      return true;
    });
  };

  const kept = {
    ...raw,
    world: filterSection(raw.world, 'world'),
    india: filterSection(raw.india, 'india'),
  };
  return { kept, droppedCount };
}

// ─── Sprint 26 (F2) — within-section split-event guard ──────────────────────
// Default ON. The RCA's #1 reader-visible defect: two "massive Russian strike
// on Kyiv" stories shipped in world with DIFFERENT eventIds (the embeddings
// clustering split them at cosine < threshold), so neither placeByEventId
// (dedups by eventId) nor the exact-match near-dup pass (shared only 3 tokens,
// one short of the bar) collapsed them. This flag adds a SECOND near-dup pass
// AFTER placeByEventId using the prefix-aware bar (russia~russian ⇒ 4 shared ⇒
// merge), keeping the better-corroborated copy. It logs every collapse and is
// env-revertible (SECTION_DEDUP=false). It does NOT touch the engine's
// clustering threshold (RCA §10 #4).
// ============================================================================
// SECTION 13:  SECTION-LEVEL DEDUP  (Sprint 26 F2 / 27.1 N1)
// ----------------------------------------------------------------------------
// Prefix-aware within-section (and cross-section, _XS) collapse of split-event
// duplicates the exact-match pass misses (e.g. russia/russian), keeping the
// higher-eventCorr copy. Runs after placement so re-injection can't reintroduce.
// Fns:   prefixSharedTokens, inheritCollapsedEvidence
// Flags: SECTION_DEDUP, SECTION_DEDUP_XS
// ============================================================================
export const SECTION_DEDUP = (process.env.SECTION_DEDUP || 'true').toLowerCase() !== 'false';

// ─── Sprint 27.1 (N1) — CROSS-section split-event guard ─────────────────────
// Default ON. The 2026-07-05 audit's worst reader-visible defect: the same
// Meta/Instagram-CSAM event shipped in BOTH major_events and business, in both
// editions — the same clustering-split root cause as the Kyiv pair, expressed
// ACROSS sections. F2's pass is within-section only, and placeByEventId dedups
// by eventId (the two copies had different ids), so nothing compared them.
// This pass extends the same prefix-aware collapse across section boundaries,
// walking sections in placement-priority order: the copy in the higher-priority
// section (major_events first) keeps its home; the later occurrence is dropped
// and its corroboration/newsworthiness/must_include are inherited by the kept
// copy (so a merged event ranks as the SUM of its evidence, not the survivor's
// alone). A must_include newcomer whose earlier twin is NOT must_include is
// kept-both + logged loud (mislabel safety — same principle as F1). Requires
// SECTION_DEDUP=on; independently revertible with SECTION_DEDUP_XS=false.
// Logs `[section-dedup:xs] …` per collapse, including the shared tokens, so an
// over-merge (the F2c caution) is diagnosable from the run log.
export const SECTION_DEDUP_XS = (process.env.SECTION_DEDUP_XS || 'true').toLowerCase() !== 'false';

// The tokens two event-signatures actually share under the prefix-aware bar —
// logged with every collapse so over-merges on generic vocabularies (fifa/world/
// cup/prediction — the F2c caution) are visible, not inferred.
export function prefixSharedTokens(a: Set<string>, b: Set<string>): string[] {
  const A = Array.from(a);
  const B = Array.from(b);
  const out: string[] = [];
  for (const x of A) {
    for (const y of B) {
      if (prefixTokenMatch(x, y)) { out.push(x === y ? x : `${x}~${y}`); break; }
    }
  }
  return out;
}

// Merge semantics when a split-event pair collapses (within- OR cross-section):
// the kept copy inherits the pair's best evidence — max eventCorr, max nw, and
// must_include if either had it. Sprint 27.1 (N3): the 07-05 run collapsed a
// front-page lead into its twin and the twin then lost the buildSubset cut —
// deleting the event's only shipped chance. Inheriting the evidence gives the
// survivor the rank the EVENT earned, not the rank one copy earned.
export function inheritCollapsedEvidence(kept: any, dropped: any): void {
  if (!kept || !dropped) return;
  const kc = Number(kept.eventCorr || 0), dc = Number(dropped.eventCorr || 0);
  if (dc > kc) kept.eventCorr = dc;
  const kn = typeof kept.nw === 'number' ? kept.nw : null;
  const dn = typeof dropped.nw === 'number' ? dropped.nw : null;
  if (dn != null && (kn == null || dn > kn)) kept.nw = dn;
  if (dropped.must_include) kept.must_include = true;
  if (dropped.exLead && !kept.exLead) { kept.exLead = true; kept.leadRank = dropped.leadRank; }
}

// ============================================================================
// SECTION 14:  enforceQualityRules  --  THE QUALITY GATE  (~400 lines)
// ----------------------------------------------------------------------------
// The central fetch-time gate, run once on the pool: whitelist gate, recency
// window, cross-section dedup, publisher cap, within-section same-event
// collapse, then placeByEventId (when PLACEMENT_V2). Output becomes raw_stories;
// buildSubset (Section 15) derives per-edition subsets from it. EDIT WITH CARE.
// Fns:   enforceQualityRules
// Flags: PUBLISHER_CAP (+ consumes Sections 11-13 flags)
// ============================================================================
export function enforceQualityRules(raw: any): RawStories {
  // Sprint 27.1 (N3) — census the CURATED front page before any filter runs.
  // The 07-05 audit found placement telemetry under-accounting (12 curated,
  // 7 cut, only 6 explained): leads lost to recency/whitelist/near-dup BEFORE
  // placeByEventId were invisible. Passing the curated count in lets the
  // placement line report curated vs at-placement vs cut explicitly.
  const curatedLeadCount = Array.isArray(raw?.major_events) ? raw.major_events.length : 0;

  // First pass: semantic dedup of world/india against major_events.
  // Sprint 22: PLACEMENT_V2's eventId one-home pass supersedes this word-overlap
  // matcher (more reliable, and it never false-drops a distinct story) — skip it
  // when the flag is on.
  if (!PLACEMENT_V2) {
    const { kept: rawAfterSemanticDedup, droppedCount: semanticDropped } =
      dropSemanticDuplicatesAgainstMajor(raw);
    if (semanticDropped > 0) {
      console.log(`[enforce] Semantic dedup dropped ${semanticDropped} world/india stories overlapping the top ${MAJOR_DEDUP_DEPTH} major_events leads.`);
    }
    raw = rawAfterSemanticDedup;
  }

  const dropped: { section: string; reason: string; headline?: string; url?: string }[] = [];
  const seenFingerprints = new Set<string>();

  function fingerprint(s: any): string {
    const h = (s?.headline || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const u = (s?.source_url || '').toLowerCase().split('?')[0];
    return `${h}|${u}`;
  }

  // Priority for dedup — earlier wins.
  const priority = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];

  // ─── Sprint 25.1 — capture eventId → topical home BEFORE any filtering ───────
  // placeByEventId (end of this function) trims the front page to 5 and re-homes
  // the cut leads. The original design assumed each cut lead's topical twin would
  // still be present in its section at that point — but recency/cap/near-dup run
  // FIRST and frequently drop the twin, so the cut lead orphaned (proven live:
  // "[placement-v2] ASSERT FAILED — 7 event(s) … NO topical home"). Fix: snapshot
  // each event's home section from the UNFILTERED `raw` here, so placeByEventId can
  // RE-INJECT a cut lead into its home even when the twin was filtered away. We
  // record the FIRST topical section (in priority order) that carries each eventId;
  // major_events is skipped (it is the front page, not a home).
  const eventHomeSection = new Map<number, string>();
  for (const sec of priority) {
    if (sec === 'major_events') continue;
    const arr = (raw as any)[sec];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      const id = (s && typeof s.eventId === 'number') ? s.eventId : null;
      if (id == null) continue;
      if (!eventHomeSection.has(id)) eventHomeSection.set(id, sec);
    }
  }

  function processList(section: string, list: any[]): RawStory[] {
    const kept: RawStory[] = [];
    // OVERLAY: major_events is a highlight layer — dedup it WITHIN itself, but
    // don't let its fingerprints block the identical topical copies (so a lead
    // survives in world/india too). Falls back to the shared set when overlay is
    // off, preserving the original cross-section "earlier-section-wins" dedup.
    const overlayMajor = PLACEMENT_V2 && PLACEMENT_OVERLAY && section === 'major_events';
    const seen = overlayMajor ? new Set<string>() : seenFingerprints;
    for (const story of list || []) {
      if (!story || typeof story !== 'object') continue;

      // Source whitelist check
      if (!isWhitelistedSource(story.source_url)) {
        dropped.push({ section, reason: 'non-whitelisted source', headline: story.headline, url: story.source_url });
        continue;
      }

      // Recency check — 24h default, 72h for major_events
      if (!isWithinRecencyWindow(story.published_at, section)) {
        console.log(`[recency] dropping ${section} story (older than window): "${(story.headline || '').slice(0, 80)}" published_at=${story.published_at}`);
        dropped.push({ section, reason: 'outside recency window', headline: story.headline });
        continue;
      }

      // Dedup
      const fp = fingerprint(story);
      if (seen.has(fp)) {
        dropped.push({ section, reason: 'duplicate of higher-priority section', headline: story.headline });
        continue;
      }
      seen.add(fp);

      kept.push(story as RawStory);
    }
    return kept;
  }

  function processSingle(section: string, story: any): RawStory | undefined {
    // Graceful degradation: if the section is missing, malformed, or sourced from
    // a non-whitelisted publisher, return undefined. The 10min schema marks
    // sport/culture as optional, so the brief publishes without them on those days.
    if (!story || typeof story !== 'object') {
      console.warn(`Single-section ${section} missing or malformed; omitting.`);
      dropped.push({ section, reason: 'missing from fetch' });
      return undefined;
    }
    if (!isWhitelistedSource(story.source_url)) {
      console.warn(`Single-section ${section} dropped (non-whitelisted source): ${story.source_url}`);
      dropped.push({ section, reason: 'non-whitelisted source', headline: story.headline, url: story.source_url });
      return undefined;
    }
    if (!isWithinRecencyWindow(story.published_at, section)) {
      console.warn(`Single-section ${section} dropped (outside recency window): published_at=${story.published_at}`);
      dropped.push({ section, reason: 'outside recency window', headline: story.headline });
      return undefined;
    }
    const fp = fingerprint(story);
    if (seenFingerprints.has(fp)) {
      console.warn(`Single-section ${section} duplicated a higher-priority story; keeping anyway.`);
    } else {
      seenFingerprints.add(fp);
    }
    return story as RawStory;
  }

  const cleaned: RawStories = {
    major_events: [],
    world: [],
    india: [],
    business: [],
    technology: [],
    climate_health: [],
    sport: [],
    culture: [],
    markets: raw?.markets || { summary: '', indices: [] },
    lens: raw?.lens || { world: '', india: '', markets: '', watch: '' },
  };

  // Walk priority order so dedup picks the highest-priority section first.
  // All sections including sport/culture are arrays as of Sprint 9.
  for (const sec of priority) {
    const arr = raw?.[sec];
    (cleaned as any)[sec] = processList(sec, Array.isArray(arr) ? arr : []);
  }

  // Markets indices sanity
  if (!cleaned.markets.indices || cleaned.markets.indices.length !== 4) {
    console.warn('Markets indices count off — got', cleaned.markets.indices?.length);
  }

  // ─── Sprint 11 / 14.8: publisher diversity cap (now PER-SECTION) ─────────
  // Originally a GLOBAL cap of 3/publisher across the whole fetch. That proved
  // far too aggressive once enforceQualityRules began running on the Perplexity
  // pool: Indian news is dominated by a few big mastheads, so a healthy 42-story
  // retry pool (6/6/6/6/5/4/5/4 on the 18-Jun 11:25 run) collapsed to ~9 —
  // world/business/tech went to ZERO because indianexpress.com had spent its
  // GLOBAL budget of 3 on the higher-priority sections, leaving none for the
  // rest. A global cap also fights the source-tiering (we WANT national agencies
  // leading EVERY section). Fix: cap PER SECTION, tunable via PUBLISHER_CAP
  // (default 4). A single source can no longer monopolise one section, but
  // claiming slots in major/india no longer starves world/tech. must_include
  // stories remain exempt.
  const PUBLISHER_CAP = Math.max(1, parseInt(process.env.PUBLISHER_CAP || '4', 10) || 4);
  let publisherDropped = 0;
  const globalDistribution = new Map<string, number>();

  function applyPublisherCap(arr: any[], section: string): RawStory[] {
    const out: RawStory[] = [];
    const perSection = new Map<string, number>(); // reset for each section
    for (const story of arr) {
      const key = publisherKey(story?.source_url) || 'unknown';
      const used = perSection.get(key) || 0;
      if (!story?.must_include && used >= PUBLISHER_CAP) {
        console.log(`[publisher-cap] dropping ${section} story (publisher ${key} already at ${PUBLISHER_CAP} in this section): "${(story?.headline || '').slice(0, 70)}"`);
        publisherDropped++;
        dropped.push({
          section,
          reason: `publisher diversity cap (${key} at ${PUBLISHER_CAP}/section)`,
          headline: story.headline,
          url: story.source_url,
        });
        continue;
      }
      perSection.set(key, used + 1);
      globalDistribution.set(key, (globalDistribution.get(key) || 0) + 1);
      out.push(story);
    }
    return out;
  }

  // Sprint 20 Drop #5 — order the SPORT section by home-audience priority BEFORE
  // the publisher cap, so India's own results (cricket) aren't capped out by a
  // flooding foreign event (FIFA). Scoped to sport (that's where the flood is);
  // stable, so only India-cricket stories move and everything else keeps order.
  if (HOME_AUDIENCE_BOOST && Array.isArray((cleaned as any).sport) && (cleaned as any).sport.length > 1) {
    (cleaned as any).sport = ((cleaned as any).sport as any[])
      .map((s, i) => ({ s, i, hb: homeAudienceBonus(s), m: (s as any)?.must_include ? 1 : 0 }))
      .sort((x, y) => (y.m - x.m) || (y.hb - x.hb) || (x.i - y.i))
      .map((d) => d.s);
  }

  // Cap each section independently — no cross-section coupling.
  for (const sec of priority) {
    (cleaned as any)[sec] = applyPublisherCap((cleaned as any)[sec] || [], sec);
  }

  if (publisherDropped > 0) {
    const distribution = Array.from(globalDistribution.entries())
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
    console.log(`[publisher-cap] dropped ${publisherDropped} stories (max ${PUBLISHER_CAP}/publisher/section). Final distribution: ${distribution}`);
  }

  // ─── Within-section same-event collapse (Sprint 18.2) ──────────────────────
  // The engine collapses the curated front page, but world/india/etc. can still
  // carry two reworded versions of one story (an oil-sanctions pair, a duplicate
  // fire report). Drop the later one — keep the first (already in importance
  // order). Per-section only: it never reaches across sections, so the worst
  // case is losing one of a true pair while its near-twin still covers the event.
  let nearDupDropped = 0;
  for (const sec of priority) {
    const arr = (cleaned as any)[sec] as RawStory[];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const keptSigs: Set<string>[] = [];
    const out: RawStory[] = [];
    for (const story of arr) {
      const sig = eventSignature(story?.headline || '');
      let dup = false;
      for (const ks of keptSigs) { if (isSameEvent(sig, ks)) { dup = true; break; } }
      if (dup && !story?.must_include) {
        console.log(`[near-dup] dropping ${sec} story (same event as an earlier one in section): "${(story?.headline || '').slice(0, 70)}"`);
        nearDupDropped++;
        continue;
      }
      keptSigs.push(sig);
      out.push(story);
    }
    (cleaned as any)[sec] = out;
  }
  if (nearDupDropped > 0) {
    console.log(`[near-dup] dropped ${nearDupDropped} within-section same-event duplicate(s).`);
  }

  // Final story-count check — warn if cap dropped us below 15 (the 5min cap).
  const totalKept = priority.reduce(
    (n, sec) => n + ((cleaned as any)[sec]?.length || 0), 0,
  );
  if (totalKept < 15) {
    console.warn(`[publisher-cap] post-cap story count ${totalKept} below the 15-story 5min target. Consider relaxing the cap if this recurs.`);
  }

  // Count must_include flags
  let mustCount = 0;
  for (const sec of priority) {
    if (sec === 'sport' || sec === 'culture') {
      if ((cleaned as any)[sec]?.must_include) mustCount++;
    } else {
      for (const s of (cleaned as any)[sec]) if (s.must_include) mustCount++;
    }
  }
  // Sprint 22 (PLACEMENT_V2) — authoritative one-event-one-home placement by the
  // engine's eventId, run last so it operates on the final per-section lists
  // (after dedup, cap, and near-dup collapse). Guarantees no event appears in two
  // sections; trims the front page to capacity with fallback-to-home.
  if (PLACEMENT_V2) placeByEventId(cleaned, eventHomeSection, curatedLeadCount);

  // ─── Sprint 26 (F2) — split-event section dedup ────────────────────────────
  // Runs AFTER placeByEventId so it also catches any near-dup that re-injection
  // reintroduced. For each section, collapse stories whose event-signatures pass
  // the PREFIX-AWARE bar (isSameEventPrefix) — this is what the exact-match pass
  // above missed for the Kyiv pair (russia vs russian). When two collapse,
  // KEEP the higher eventCorr (more distinct publishers corroborated it); tie →
  // keep the earlier (already in importance order). must_include is never
  // dropped. Logs each collapse with both headlines so the split is visible in
  // the run log and the admin RCA.
  if (SECTION_DEDUP) {
    let sectionDedupCollapsed = 0;
    for (const sec of priority) {
      const arr = (cleaned as any)[sec] as RawStory[];
      if (!Array.isArray(arr) || arr.length < 2) continue;
      const kept: RawStory[] = [];
      const keptSigs: Set<string>[] = [];
      for (const story of arr) {
        const sig = eventSignature(story?.headline || '');
        let dupIdx = -1;
        for (let i = 0; i < keptSigs.length; i++) {
          if (isSameEventPrefix(sig, keptSigs[i])) { dupIdx = i; break; }
        }
        if (dupIdx === -1) {
          kept.push(story);
          keptSigs.push(sig);
          continue;
        }
        // Found a same-event partner already kept in this section.
        const incumbent = kept[dupIdx];
        const sharedToks = prefixSharedTokens(sig, keptSigs[dupIdx]); // BEFORE any swap
        const incCorr = Number((incumbent as any)?.eventCorr || 0);
        const newCorr = Number((story as any)?.eventCorr || 0);
        const incMust = !!(incumbent as any)?.must_include;
        const newMust = !!(story as any)?.must_include;
        // Never drop a must_include; if both must_include, keep both (skip merge).
        if (incMust && newMust) {
          kept.push(story);
          keptSigs.push(sig);
          continue;
        }
        let dropHeadline: string;
        let droppedStory: any;
        if (newMust && !incMust) {
          // Replace incumbent with the must_include newcomer.
          dropHeadline = incumbent?.headline || '';
          droppedStory = incumbent;
          kept[dupIdx] = story;
          keptSigs[dupIdx] = sig;
        } else if (incMust && !newMust) {
          dropHeadline = story?.headline || '';
          droppedStory = story;
          // keep incumbent, drop newcomer
        } else if (newCorr > incCorr) {
          dropHeadline = incumbent?.headline || '';
          droppedStory = incumbent;
          kept[dupIdx] = story;
          keptSigs[dupIdx] = sig;
        } else {
          dropHeadline = story?.headline || '';
          droppedStory = story;
          // tie or incumbent higher → keep incumbent (earlier)
        }
        // Sprint 27.1 (N3) — the survivor inherits the pair's best evidence
        // (max eventCorr/nw, must_include) so a collapse can't demote the event
        // below the buildSubset cut that one of its copies had earned.
        inheritCollapsedEvidence(kept[dupIdx], droppedStory);
        sectionDedupCollapsed++;
        console.log(`[section-dedup] collapsed same-event pair in ${sec} (kept eventCorr=${Number((kept[dupIdx] as any)?.eventCorr || 0)}): dropped "${(dropHeadline || '').slice(0, 70)}" — kept "${(kept[dupIdx]?.headline || '').slice(0, 70)}" | shared tokens: ${sharedToks.join(', ')}`);
      }
      (cleaned as any)[sec] = kept;
    }
    if (sectionDedupCollapsed > 0) {
      console.log(`[section-dedup] collapsed ${sectionDedupCollapsed} split-event duplicate(s) across sections.`);
    } else {
      console.log('[section-dedup] no split-event duplicates found.');
    }

    // ── Sprint 27.1 (N1) — cross-section pass ──────────────────────────────
    // Same prefix-aware bar, applied ACROSS section boundaries in placement-
    // priority order. The earlier (higher-priority) section keeps its copy —
    // this mirrors placeByEventId's own first-claim semantics, and it means a
    // front-page lead is never yanked off the front page by a topical twin.
    // The dropped copy's evidence is inherited by the kept copy. If the dropped
    // copy was BETTER corroborated, that is logged loudly (section precedence
    // won, but the trade-off is visible). A must_include newcomer whose earlier
    // twin is not must_include is kept-both + logged (mislabel safety) — F7's
    // brief-wide duplicate check will independently flag it if it ships.
    if (SECTION_DEDUP_XS) {
      type XsKept = { sig: Set<string>; sec: string; story: any };
      const registry: XsKept[] = [];
      let xsCollapsed = 0;
      let xsMustKeptBoth = 0;
      for (const sec of priority) {
        const arr = (cleaned as any)[sec] as RawStory[];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const survivors: RawStory[] = [];
        for (const story of arr) {
          const sig = eventSignature(story?.headline || '');
          let twin: XsKept | null = null;
          for (const r of registry) {
            if (r.sec !== sec && isSameEventPrefix(sig, r.sig)) { twin = r; break; }
          }
          if (!twin) {
            survivors.push(story);
            registry.push({ sig, sec, story });
            continue;
          }
          const newMust = !!(story as any)?.must_include;
          const twinMust = !!(twin.story as any)?.must_include;
          if (newMust && !twinMust) {
            // Mislabel safety: never drop a must_include, never yank the earlier
            // section's copy — keep both, loudly. F7 will flag it if both ship.
            xsMustKeptBoth++;
            console.warn(`[section-dedup:xs] must_include twin KEPT in ${sec} (earlier copy in ${twin.sec} is not must_include) — keeping both, F7 will verify: "${String(story?.headline || '').slice(0, 70)}"`);
            survivors.push(story);
            registry.push({ sig, sec, story });
            continue;
          }
          const sharedToks = prefixSharedTokens(sig, twin.sig);
          const dropCorr = Number((story as any)?.eventCorr || 0);
          const keptCorr = Number((twin.story as any)?.eventCorr || 0);
          inheritCollapsedEvidence(twin.story, story);
          xsCollapsed++;
          const corrNote = dropCorr > keptCorr
            ? ` ⚠ dropped copy was BETTER corroborated (${dropCorr}>${keptCorr}) — section precedence kept the ${twin.sec} copy; evidence inherited`
            : '';
          console.log(`[section-dedup:xs] collapsed cross-section same-event pair (${twin.sec} ⟷ ${sec}): dropped "${String(story?.headline || '').slice(0, 70)}" from ${sec} — kept "${String(twin.story?.headline || '').slice(0, 70)}" in ${twin.sec} (eventCorr now ${Number((twin.story as any)?.eventCorr || 0)}) | shared tokens: ${sharedToks.join(', ')}${corrNote}`);
        }
        (cleaned as any)[sec] = survivors;
      }
      if (xsCollapsed > 0 || xsMustKeptBoth > 0) {
        console.log(`[section-dedup:xs] collapsed ${xsCollapsed} cross-section split-event duplicate(s)${xsMustKeptBoth > 0 ? `; ${xsMustKeptBoth} must_include twin(s) kept-both (mislabel safety)` : ''}.`);
      } else {
        console.log('[section-dedup:xs] no cross-section split-event duplicates found.');
      }
    }
  }

  console.log(`Quality enforcement complete. Must-includes: ${mustCount}/5. Dropped: ${dropped.length}`);
  if (dropped.length > 0) console.log('Dropped:', JSON.stringify(dropped, null, 2).slice(0, 1500));

  return cleaned;
}

// ─── Phase 3: Edition writers (three different prompts) ─────────────────────

// ============================================================================
// SECTION 15:  WRITER PREP, RANKING & SUBSET
// ----------------------------------------------------------------------------
// Shapes the cleaned pool for the writer, ranks by source tier / newsworthiness
// / home-audience boost, and buildSubset() carves each edition's per-section
// quota from the shared pool at write time.
// Fns:   rankBySourceTier, rankByImportance, homeAudienceBonus, buildSubset
// Flags: RANK_BY_NEWSWORTHINESS, HOME_AUDIENCE_BOOST, HOME_BOOST_SPORT_ONLY
// ============================================================================
export function rawStoriesForWriter(raw: RawStories) {
  // Strip `lens` — it's a four-line home-screen summary, not source material.
  // Previously the deep writer was treating lens lines as available headlines
  // and putting them in three_patterns.stories_connected. Writers see stories
  // and markets only.
  const { lens, ...storiesOnly } = raw;
  return storiesOnly;
}

// ─── Deterministic post-filter subset builder ───────────────────────────────
//
// After enforceQualityRules drops non-whitelisted, stale, and semantically-
// duplicate stories, we still typically have more raw stories than each
// edition wants. This builder picks a balanced subset.
//
// Sprint 12.5.1 — REWRITTEN. The previous version walked priority order with
// a single global cap (20 for 10min, 15 for 5min). After Sprint 12.5's prompt
// strengthening pushed Perplexity to over-fetch, the priority sections alone
// (major=7 + india=7 + world=7 = 21) exhausted the cap, leaving business,
// technology, climate_health, sport, and culture with ZERO stories in the
// subset. Result: 10min written brief had 5 empty topical sections; Daily
// scored 52/70 because of it.
//
// New design: per-section QUOTAS that guarantee breadth, then redistribute any
// slack to higher-priority sections. Topical sections (biz/tech/climate/sport/
// culture) are guaranteed at least 1-3 stories each.
//
// 5min set is no longer a strict subset of 10min (priority sections may differ
// by 1-2 stories), but the 5min writer concatenates topicals into a single
// 'topics' bucket, so breadth coverage matters more than strict subsetting.

// Sprint 14.8 — STABLE rank by source tier (national/record first), preserving
// the fetcher's relative order within a tier and always keeping must_include on
// top. Decorate-sort-undecorate so it's stable regardless of engine/target.
export function rankBySourceTier(arr: RawStory[]): RawStory[] {
  if (!Array.isArray(arr) || arr.length < 2) return Array.isArray(arr) ? arr : [];
  return arr
    .map((s, i) => ({ s, i, t: sourceTier((s as any)?.source_url), m: (s as any)?.must_include ? 1 : 0 }))
    .sort((a, b) => (b.m - a.m) || (b.t - a.t) || (a.i - b.i))
    .map((d) => d.s);
}

// Sprint 20 — rank each section by NEWSWORTHINESS first (the nw score the RSS
// engine now stamps on every story), then must_include, then source tier, then
// the fetcher's order. This is the fix for "fluff led the section": a 50-year-
// old evergreen (nw low) now sinks below a M6.9 earthquake (nw high) even if the
// evergreen came from a higher-tier wire. Stories without a score (nw undefined,
// e.g. the unscored tail, or when scoring was unavailable) sort as -1 and fall
// back to the exact tier ordering above — so the change is fully fail-safe.
// Gated by RANK_BY_NEWSWORTHINESS (default on).
export const RANK_BY_NW = (process.env.RANK_BY_NEWSWORTHINESS || 'on').toLowerCase() !== 'off';

// ─── Sprint 20 Drop #5 — home-audience priority for sport ───────────────────
// The FIFA World Cup floods every sport feed; the per-publisher section cap then
// keeps each masthead's first 4 (all FIFA football), capping out India's OWN
// cricket results before they can be selected. On the 2026-06-26 run "India beat
// Bangladesh in the T20 World Cup" was dropped 4× by the cap while a Turkey-US
// dead rubber took the single sport slot. This deterministic bonus lifts India
// national-team results in marquee cricket events so they (a) survive the
// publisher cap and (b) lead the sport slot in selection. It fires ~only on
// India cricket (returns 0 otherwise), so it reshuffles sport without disturbing
// any other section. Gated by HOME_AUDIENCE_BOOST (default on).
export const HOME_AUDIENCE_BOOST = (process.env.HOME_AUDIENCE_BOOST || 'on').toLowerCase() !== 'off';
// Sprint 23 — scope the home-audience (India-cricket) lift to the SPORT section
// only. In rankByImportance the lift sat ABOVE newsworthiness for EVERY section,
// so a cricket milestone outranked a fatal flood in india/world. The lift was
// only ever meant to stop a foreign tournament flooding SPORT (see the dedicated
// sport pass in enforceQualityRules) — confine it there. Revertible:
// HOME_BOOST_SPORT_ONLY=off restores the all-section lift.
export const HOME_BOOST_SPORT_ONLY = (process.env.HOME_BOOST_SPORT_ONLY || 'on').toLowerCase() !== 'off';
export function homeAudienceBonus(story: any): number {
  if (!HOME_AUDIENCE_BOOST) return 0;
  const h = `${(story as any)?.headline || ''} ${(story as any)?.summary || (story as any)?.body || ''}`;
  if (!/\b(india|indian|team india)\b/i.test(h)) return 0;
  if (!/\b(cricket|t20i?|odi|test match|icc|bcci|world cup)\b/i.test(h)) return 0;
  const result = /\b(beat|beats|won|win|wins|defeat|defeats|thrash\w*|advance\w*|qualif\w*|knockout|semi-?final|final|clinch\w*|seal\w*|chase\w*)\b/i.test(h);
  let b = result ? 2 : 1;
  if (/\b(world cup|icc|champions trophy)\b/i.test(h)) b += 1;       // marquee event
  if (/\b(india a|under-?19|u-?19|ranji|domestic|maharaja trophy|tg20)\b/i.test(h)) b = Math.min(b, 1); // dampen minor cricket
  return Math.min(3, b);
}

export function rankByImportance(arr: RawStory[], section?: string): RawStory[] {
  if (!Array.isArray(arr) || arr.length < 2) return Array.isArray(arr) ? arr : [];
  if (!RANK_BY_NW) return rankBySourceTier(arr);
  // Apply the India-cricket lift only where it belongs. When HOME_BOOST_SPORT_ONLY
  // is on, hb is non-zero only for the sport section; everywhere else
  // newsworthiness decides, so a fatal flood outranks a sports record in
  // india/world.
  const useBoost = !HOME_BOOST_SPORT_ONLY || section === 'sport';
  return arr
    .map((s, i) => ({
      s, i,
      nw: typeof (s as any)?.nw === 'number' ? (s as any).nw : -1,
      hb: useBoost ? homeAudienceBonus(s) : 0,
      t: sourceTier((s as any)?.source_url),
      m: (s as any)?.must_include ? 1 : 0,
    }))
    .sort((a, b) => (b.m - a.m) || (b.hb - a.hb) || (b.nw - a.nw) || (b.t - a.t) || (a.i - b.i))
    .map((d) => d.s);
}

export function buildSubset(raw: RawStories, cap: number): RawStories {
  // Per-section base quotas. Sum equals cap; topical sections always get >=1.
  const QUOTAS: Record<number, Record<string, number>> = {
    15: { // 5min — leaner, but still touch every topical section
      major_events: 4, india: 4, world: 3,
      business: 1, technology: 1, climate_health: 1, sport: 0, culture: 1,
    },
    20: { // 10min + (Drop #4) 5min — broader coverage; world floored at 4
      major_events: 5, india: 4, world: 4,
      business: 2, technology: 2, climate_health: 1, sport: 1, culture: 1,
    },
  };

  // If an unfamiliar cap is passed, fall back to the 20-quota shape.
  const quota = QUOTAS[cap] || QUOTAS[20];

  // Priority for slack redistribution (best-section-first).
  const PRIORITY = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];

  // Sprint 14.8 / 20 — rank each section by NEWSWORTHINESS first (Sprint 20),
  // then must_include, then source tier (national agencies / papers of record),
  // then the fetcher's order. Used by both passes. Falls back to pure tier order
  // for any section whose stories have no nw score (fail-safe).
  const ranked: Record<string, RawStory[]> = {};
  for (const sec of PRIORITY) {
    ranked[sec] = rankByImportance(((raw as any)[sec] || []) as RawStory[], sec);
  }

  // First pass: take min(quota, available) per section.
  const taken: Record<string, RawStory[]> = {};
  let used = 0;
  for (const sec of PRIORITY) {
    const want = quota[sec] || 0;
    const avail = ranked[sec];
    const take = avail.slice(0, want);
    taken[sec] = take;
    used += take.length;
  }

  // Second pass: if sections under-delivered (raw had fewer than quota), give
  // the unused slots to other sections that have surplus, walking priority.
  let slack = cap - used;
  if (slack > 0) {
    for (const sec of PRIORITY) {
      if (slack <= 0) break;
      const avail = ranked[sec];
      const room = avail.length - taken[sec].length;
      const more = Math.min(room, slack);
      if (more > 0) {
        taken[sec] = avail.slice(0, taken[sec].length + more);
        slack -= more;
      }
    }
  }

  const nwScored = PRIORITY.reduce((n, sec) => n + (taken[sec] || []).filter((s: any) => typeof s?.nw === 'number').length, 0);
  console.log(`[subset:cap=${cap}] picked ${cap - slack} stories (slack=${slack}, nw-ranked=${RANK_BY_NW}, nw-scored=${nwScored}/${cap - slack}) — ` +
    `major=${taken.major_events.length}, india=${taken.india.length}, world=${taken.world.length}, ` +
    `biz=${taken.business.length}, tech=${taken.technology.length}, climate=${taken.climate_health.length}, ` +
    `sport=${taken.sport.length}, culture=${taken.culture.length}`);

  return {
    major_events:   taken.major_events,
    india:          taken.india,
    world:          taken.world,
    business:       taken.business,
    technology:     taken.technology,
    climate_health: taken.climate_health,
    sport:          taken.sport,
    culture:        taken.culture,
    // Sprint 14.2: politics & markets_news pass through in full (NOT counted
    // against the cap) so the dedicated-section writer sees them. The brief
    // shows them only to opted-in users; everyone else's personalise step
    // drops them.
    politics:       rankBySourceTier(((raw as any).politics || []) as RawStory[]),
    markets_news:   rankBySourceTier(((raw as any).markets_news || []) as RawStory[]),
    markets:        raw.markets,
    lens:           raw.lens,
  };
}

// Deterministic visibility check (Sprint 23): flag 5-min items whose one-line
// what_happened merely restates the headline (high significant-word overlap). We
// LOG rather than regenerate — a per-story retry would add a second model call
// and latency for little gain; surfacing the count in the run log lets the
// prompt fix be verified and tuned. No content is changed.
