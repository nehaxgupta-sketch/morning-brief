// src/lib/generate-brief/types.ts
//
// Modularization stage 2 - the pipeline's TypeScript interfaces + Zod schemas,
// moved verbatim from generate-brief.tsx (only `export` added to each top-level
// declaration; `z` import added). Pure: depends on zod only, no behaviour.
// extractJsonObject stays in the route for now and migrates with utils.

import { z } from 'zod';

export type Edition = '5min' | '10min' | 'deep';

export interface RawStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
  // Tagging for downstream personalisation:
  industries?: string[];
  interests?: string[];
  city_tags?: string[];
  topic_tags?: string[];
  // Day-of must-include flag:
  must_include?: boolean;
  // Sprint 20 — newsworthiness 0-10, stamped by the RSS engine. Drives
  // per-section selection in buildSubset (importance, not source tier).
  nw?: number;
}

export interface MarketIndex { name: string; change: string; }

export interface RawStories {
  // Stories first, by section:
  major_events: RawStory[];
  world: RawStory[];
  india: RawStory[];
  business: RawStory[];
  technology: RawStory[];
  climate_health: RawStory[];
  sport: RawStory[];      // Was single; now array (Sprint 9) — 2-4 stories across different sports.
  culture: RawStory[];    // Was single; now array (Sprint 9) — 2-4 stories across different culture types.
  // Sprint 14.2: dedicated article buckets for politics & markets. Always
  // fetched (feed the Desks pool); shown in the brief only to users who opt
  // into the 'Indian Politics' / 'Markets & Investing' interests. Optional so
  // older rows and quiet days never break validation.
  politics?: RawStory[];
  markets_news?: RawStory[];
  markets: { summary: string; indices: MarketIndex[] };
  // Lens — the four-line summary used by the home flash card.
  lens: {
    world: string;
    india: string;
    markets: string;
    watch: string;
  };
}

// ─── Output shapes (one per edition) ────────────────────────────────────────

export interface MicroStory {
  headline: string;
  what_happened: string;
  why_it_matters: string;
  source: string;
  source_url: string;
  industries?: string[];
  interests?: string[];
  city_tags?: string[];
  topic_tags?: string[];
  must_include?: boolean;
}

export interface FullStory {
  headline: string;
  facts: string;
  background: string;
  why_it_matters: string;
  what_happens_next: string;
  analysis: string;
  source: string;
  source_url: string;
  industries?: string[];
  interests?: string[];
  city_tags?: string[];
  topic_tags?: string[];
  must_include?: boolean;
}

export interface Closer {
  headlines_to_remember: string[];  // exactly 5
  things_to_watch: string[];         // exactly 3
  conversation_insight: string;
}

export interface BriefQuick {
  edition: '5min';
  date: string;
  major_events: MicroStory[];
  world: MicroStory[];
  india: MicroStory[];
  topics: MicroStory[];  // cross-topic mix (~5 items)
}

export interface BriefDaily {
  edition: '10min';
  date: string;
  major_events: FullStory[];
  world: FullStory[];
  india: FullStory[];
  business: FullStory[];
  markets: { summary: string; indices: MarketIndex[] };
  markets_news?: FullStory[];  // Sprint 14.2
  politics?: FullStory[];      // Sprint 14.2
  technology: FullStory[];
  climate_health: FullStory[];
  sport?: FullStory;
  culture?: FullStory;
  closer: Closer;
}

export interface Pattern {
  title: string;
  body: string;
  stories_connected: string[];  // headlines this pattern synthesises
}

export interface LongRead {
  title: string;
  body: string;
  candidate_themes?: string[];  // alt themes for personalisation
}

export interface WatchItem {
  title: string;
  body: string;
  interests?: string[];
  industries?: string[];
  topic_tags?: string[];
}

export interface BriefEditorial {
  edition: 'deep';
  date: string;
  three_patterns: Pattern[];
  long_read: LongRead;
  watching_this_week: WatchItem[];
  signature: {
    one_number: { value: string; context: string };
    one_chart?: { title: string; description: string; data_points?: { label: string; value: number }[] } | null;
    one_quote?: { quote: string; attribution: string; context: string } | null;
  };
}

export type BriefContent = BriefQuick | BriefDaily | BriefEditorial;

// ─── Zod schemas ────────────────────────────────────────────────────────────

export const TagsSchema = z.object({
  industries: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  city_tags: z.array(z.string()).optional(),
  topic_tags: z.array(z.string()).optional(),
  must_include: z.boolean().optional(),
});

export const MicroStorySchema = TagsSchema.extend({
  headline: z.string().min(5).max(200),
  what_happened: z.string().min(8),
  why_it_matters: z.string().min(8),
  source: z.string().min(1),
  source_url: z.string().startsWith('https://'),
});

export const FullStorySchema = TagsSchema.extend({
  headline: z.string().min(5).max(200),
  facts: z.string().min(15),
  background: z.string().min(15),
  why_it_matters: z.string().min(15),
  what_happens_next: z.string().min(15),
  analysis: z.string().min(15),
  source: z.string().min(1),
  source_url: z.string().startsWith('https://'),
});

export const MarketIndexSchema = z.object({
  name: z.string().min(1),
  change: z.string().min(1),
});

// Closer schema: permissive on counts so the entire 10min brief doesn't fail
// when gpt-4o-mini returns 4 or 6 headlines instead of exactly 5. The writer
// prompt still asks for "exactly 5" / "exactly 3" — the schema just stops
// strict counts from being a brief-killer on quiet news days.
export const CloserSchema = z.object({
  headlines_to_remember: z.array(z.string().min(5)).min(3).max(7),
  things_to_watch: z.array(z.string().min(5)).min(2).max(5),
  conversation_insight: z.string().min(20),
});

export const BriefQuickSchema = z.object({
  edition: z.literal('5min'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Sections can be empty on quiet news days — UI shows "no stories" rather than failing the whole brief.
  major_events: z.array(MicroStorySchema),
  world: z.array(MicroStorySchema),
  india: z.array(MicroStorySchema),
  topics: z.array(MicroStorySchema),
});

export const BriefDailySchema = z.object({
  edition: z.literal('10min'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Sections can be empty on quiet news days — UI shows "no stories" rather than failing the whole brief.
  major_events: z.array(FullStorySchema),
  world: z.array(FullStorySchema),
  india: z.array(FullStorySchema),
  business: z.array(FullStorySchema),
  markets: z.object({
    summary: z.string().min(10),
    indices: z.array(MarketIndexSchema).min(1).max(6),
  }),
  technology: z.array(FullStorySchema),
  climate_health: z.array(FullStorySchema),
  // Sprint 14.2: optional + default so the brief never fails if the writer
  // omits them; they render only for opted-in users.
  politics: z.array(FullStorySchema).optional().default([]),
  markets_news: z.array(FullStorySchema).optional().default([]),
  // sport/culture became arrays in Sprint 9 to support breadth across multiple
  // sports/culture types. Permissive on count — empty on quiet days is fine.
  sport: z.array(FullStorySchema).max(6),
  culture: z.array(FullStorySchema).max(6),
  closer: CloserSchema,
});

export const PatternSchema = z.object({
  title: z.string().min(5),
  body: z.string().min(100),
  stories_connected: z.array(z.string()).min(2),
});

export const LongReadSchema = z.object({
  title: z.string().min(5),
  body: z.string().min(200),
  candidate_themes: z.array(z.string()).optional(),
});

export const WatchItemSchema = z.object({
  title: z.string().min(5),
  body: z.string().min(20),
  interests: z.array(z.string()).optional(),
  industries: z.array(z.string()).optional(),
  topic_tags: z.array(z.string()).optional(),
});

export const BriefEditorialSchema = z.object({
  edition: z.literal('deep'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  three_patterns: z.array(PatternSchema).length(3),
  long_read: LongReadSchema,
  watching_this_week: z.array(WatchItemSchema).min(3).max(6),
  signature: z.object({
    one_number: z.object({
      value: z.string().min(1),
      context: z.string().min(10),
    }),
    // Sprint 27.1 (N10) — nullish, matching one_quote. The writer occasionally
    // returns one_chart: null (no usable series), and sanitizeSignature itself
    // nulls a synthetic chart — but the schema required an object, so a null
    // failed the WHOLE deep brief and burnt a full retry (~$0.09 on 07-05).
    // The renderer already tolerates null (sanitised nulls have shipped since
    // Sprint 14.4). A chart-less deep is valid; a failed deep is not.
    one_chart: z.object({
      title: z.string().min(3),
      description: z.string().min(15),
      // Sprint 13.2: real numeric points so the UI can draw an actual chart.
      // Optional + permissive: missing points just means description-only.
      data_points: z.array(z.object({
        label: z.string().min(1),
        value: z.number(),
      })).max(8).optional(),
    }).nullish(),
    one_quote: z.object({
      quote: z.string().min(10),
      attribution: z.string().min(3),
      context: z.string().min(10),
    }).nullish(),
  }),
});

export const LensSchema = z.object({
  world: z.string().min(8),
  india: z.string().min(8),
  markets: z.string().min(8),
  watch: z.string().min(8),
});
