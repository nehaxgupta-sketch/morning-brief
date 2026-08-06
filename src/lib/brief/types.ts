// src/lib/brief/types.ts
//
// THE SPINE — the contract every pipeline file compiles against (Sprint 29
// rebuild). Data flows through six steps; each step's input and output shape is
// fixed here so the six step files compose without interface drift.
//
//   fetch → dedupe → route → write-facts → write-wim → assemble
//
// (route runs BEFORE write-facts: routing ranks by nw + candidacy and never
// needs the written prose, so we only write the events actually placed for some
// user — the "used union" — not the whole pool.)
//
// Carried bedrock (clustering, primitives, transport, config) imports FROM this
// file; it does not redefine these shapes. `why_it_matters` is the ONLY
// per-section, per-user field (written in write-wim); everything upstream is
// user-agnostic. Editions are depth-views over the same written Article.

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

export type Edition = '5min' | '10min' | 'deep';

// Section identity. The core three are fixed; the rest are keyed strings drawn
// from the carried taxonomy in config.ts — base sections ('business','culture',
// 'technology','sport','climate_health',…), interest views ('Markets & Investing',
// 'Film & OTT'), cities ('city:bengaluru'), industries ('prof:legal').
export type CoreSection = 'major_events' | 'world' | 'india';
export type SectionKey = string;
export type SectionKind = 'core' | 'interest' | 'city' | 'industry';

export interface MarketIndex { name: string; change: string; }
export interface Markets { summary: string; indices: MarketIndex[]; }
export interface Lens { world: string; india: string; markets: string; watch: string; }

// A user's personalisation inputs (from their profile). Routing intersects a
// story's intrinsic candidacy with the sections this user actually has.
export interface UserSelections {
  userId: string;
  cities: string[];        // e.g. ['Bengaluru']
  interests: string[];     // taxonomy keys, e.g. ['Markets & Investing','Film & OTT']
  industries: string[];    // profession keys, e.g. ['finance']
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — fetch  (major call + minor call → one clustered pool)
// ─────────────────────────────────────────────────────────────────────────────
// PoolStory carries the RSS engine's RssStory fields verbatim + provenance.
// eventId/eventCorr are stamped by the clustering engine (clustering.ts) and are
// the dedupe key. Pre-dedupe, `stories` may hold same-event duplicates across the
// major and minor calls — that is exactly what step 2 collapses.

export interface PoolStory {
  eventId: number;
  eventCorr: number;               // distinct-publisher corroboration
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
  nw?: number;                     // newsworthiness 0–10 (undefined = unscored tail)
  // candidacy inputs (from feed origin + content tagging):
  geo: Array<'world' | 'india'>;   // geographic scope
  interests: string[];
  industries: string[];
  city_tags: string[];
  topic_tags: string[];
  must_include?: boolean;
  _call: 'major' | 'minor';        // which fetch produced it
}

export interface Pool {
  date: string;
  stories: PoolStory[];
  markets: Markets;
  _source: string;                 // 'rss'
  _fetched_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — dedupe  (global-unique by eventId + intrinsic candidacy tagging)
// ─────────────────────────────────────────────────────────────────────────────
// One DedupedStory per real-world event. candidateSections is the set of sections
// the story is INTRINSICALLY eligible for — major_events if nw clears the bar;
// world/india from geo; base/interest/city/industry sections from tags + the
// config taxonomy. User-agnostic; routing intersects it with each user's active
// sections. A story leaves availability only when PLACED (step 3), never when
// merely tagged — the starvation rule.

export interface DedupedStory extends PoolStory {
  candidateSections: SectionKey[];
}

export interface DedupedPool {
  date: string;
  stories: DedupedStory[];         // eventId-unique
  markets: Markets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — route  (per user: 10-core + increments to ceiling, remove-on-place)
// ─────────────────────────────────────────────────────────────────────────────
// Sections reference articles by eventId (no copies → global-uniqueness is
// enforceable by construction). Core is byte-identical across users
// (major_events 3 / india 4 / world 3 = 10). Increments fill the user's selected
// sections toward the edition ceiling; a zero-selection user's increment expands
// india/world. targetCount derives from selections + the count policy (config);
// ceilingReached tells assemble/telemetry whether we stopped on quality or cap.
// Runs on nw + candidacy only — no written prose needed yet.

export interface RoutedSection {
  key: SectionKey;
  label: string;
  kind: SectionKind;
  eventIds: number[];              // placed here; unique across the whole brief
}

export interface RoutedBrief {
  userId: string;
  date: string;
  edition: Edition;                // 5min / 10min share routing; deep synthesises
  sections: RoutedSection[];       // ordered: core first, then personalised
  targetCount: number;
  ceilingReached: boolean;
  // Step 5 fills this — the ONLY per-section, per-user layer:
  wim: Record<SectionKey, string>; // sectionKey → why-it-matters (personalised sections only)
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — write-facts  (facts once, full depth, for the used union only)
// ─────────────────────────────────────────────────────────────────────────────
// Written ONCE per event, user- and section-agnostic, for the events routing
// actually placed. No why_it_matters here. `hook` is the one-line 5-min view
// (rider B); the full body (facts/background/what_happens_next/analysis) is the
// 10-min view; deep synthesises across Articles separately.

export interface Article {
  eventId: number;
  headline: string;
  hook: string;                    // one line — 5-min depth-view
  facts: string;
  background: string;
  what_happens_next: string;
  analysis: string;
  source: string;
  source_url: string;
  // carried for routing/rendering:
  candidateSections: SectionKey[];
  geo: Array<'world' | 'india'>;
  interests: string[];
  industries: string[];
  city_tags: string[];
  topic_tags: string[];
  nw?: number;
  eventCorr: number;
  must_include?: boolean;
}

export interface ArticleStore {
  date: string;
  byEventId: Record<number, Article>;  // only the used union
  markets: Markets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — assemble  (project Articles into the edition view + persist)
// ─────────────────────────────────────────────────────────────────────────────
// The persisted, render-ready shape. 5-min projects {headline, hook}; 10-min
// projects the full Article; both attach the section's wim (personalised
// sections only). Deep is a separate synthesis (patterns/long-read/watch) over
// the routed Articles — its shape is defined at its step. markets/lens/closer
// are carried/attached.

export interface EditionStory {
  eventId: number;
  headline: string;
  hook?: string;                   // 5-min
  facts?: string;                  // 10-min
  background?: string;
  what_happens_next?: string;
  analysis?: string;
  source: string;
  source_url: string;
}

export interface EditionSection {
  key: SectionKey;
  label: string;
  kind: SectionKind;
  stories: EditionStory[];
  why_it_matters?: string;         // personalised sections only
}

// Deep edition (the third format) — a synthesis ACROSS the routed articles, not
// a story list. Written by write-deep; attached to EditionBrief.deep.
export interface DeepPattern { title: string; body: string; stories_connected: string[]; }
export interface DeepContent {
  three_patterns: DeepPattern[];
  long_read: { title: string; body: string };
  watching_this_week: { title: string; body: string }[];
  signature: {
    one_number: { value: string; context: string };
    one_quote?: { quote: string; attribution: string; context: string } | null;
  };
}

export interface EditionBrief {
  userId: string;
  date: string;
  edition: Edition;
  sections: EditionSection[];
  markets: Markets;
  lens: Lens;
  deep?: DeepContent;  // present only for the deep edition
}

// ─────────────────────────────────────────────────────────────────────────────
// Step signatures — the contract the six files implement
// ─────────────────────────────────────────────────────────────────────────────
// Async where an LLM/network is involved; pure otherwise. Each logs under its own
// tag; flags live in config.ts. `collectUsedEventIds` (in route.ts) unions the
// eventIds across all users/editions so write-facts writes only what's shown.

export type StepFetch      = (selections: UserSelections[], date: string) => Promise<Pool>;
export type StepDedupe     = (pool: Pool) => DedupedPool;
export type StepRoute      = (pool: DedupedPool, user: UserSelections, edition: Edition) => RoutedBrief;
export type StepWriteFacts = (pool: DedupedPool, usedEventIds: number[]) => Promise<ArticleStore>;
export type StepWriteWim   = (routed: RoutedBrief, store: ArticleStore, user: UserSelections) => Promise<RoutedBrief>;
export type StepAssemble   = (routed: RoutedBrief, store: ArticleStore) => EditionBrief;
