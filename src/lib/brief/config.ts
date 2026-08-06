// src/lib/brief/config.ts
//
// Shared config for the rebuilt pipeline: env flags, the count policy (D4/D5),
// and a reconciliation layer over the carried taxonomy in ./feeds.
//
// The two legacy interest taxonomies live under DIFFERENT keys and only partly
// overlap: INTEREST_SECTIONS (section + keywords + why, ~20 interests) and
// INTEREST_FEEDS (dedicated RSS, ~8 interests). This file unifies them so
// routing, candidacy, and the minor fetch all read one model.
//
// Carried data is IMPORTED, never reproduced: ./feeds = the current
// feeds.config.ts MERGED with the CITY_FEEDS / INTEREST_FEEDS registries lifted
// out of the retired tails.ts (D6 expansion happens there).

import {
  INTEREST_SECTIONS, PROFESSION_SECTIONS,
  CITY_FEEDS, INTEREST_FEEDS,
  citySlug, cityFeed, type Section,
} from './feeds';
import type { Edition, SectionKey, SectionKind, UserSelections } from './types';

// ── Env flags ────────────────────────────────────────────────────────────────
// Post-strip there is no legacy path to revert to, so flags are behavioural
// toggles INSIDE steps (default = the spec). "Revert" is git.
export const FLAGS = {
  minorFetch:   (process.env.BRIEF_MINOR_FETCH   || 'on') !== 'off', // D6 minor call
  starvation:   (process.env.BRIEF_STARVATION    || 'on') !== 'off', // leftover core → other sections
  qualityFloor: (process.env.BRIEF_QUALITY_FLOOR || 'on') !== 'off', // quality overrides the count floor
};

// ── Count policy (D4 / D5) ───────────────────────────────────────────────────
// CORE is byte-identical across every user (D5): 3 + 4 + 3 = 10.
export const CORE = { major_events: 3, india: 4, world: 3 } as const;
export const CORE_TOTAL = CORE.major_events + CORE.india + CORE.world; // 10
export const CORE_SECTIONS: SectionKey[] = ['major_events', 'world', 'india'];

// Ceiling = hard cap; floor = the level we backfill from core to when a user's
// selections are thin. Target scales with # selected areas and leans to ceiling.
export const EDITION_BOUNDS: Record<Exclude<Edition, 'deep'>, { floor: number; ceiling: number }> = {
  '5min':  { floor: 10, ceiling: 20 },
  '10min': { floor: 15, ceiling: 30 },
};

// Per selected area, stories we aim to add before the ceiling clamp (route.ts).
export const AREA_QUOTA: Record<SectionKind, number> = { core: 0, city: 3, interest: 3, industry: 2 };

// major_events eligibility: a story is a front-page candidate once its nw clears
// this bar; route then takes the top CORE.major_events by nw. Env-tunable.
export const MAJOR_NW_MIN = parseInt(process.env.BRIEF_MAJOR_NW_MIN || '7', 10);

// ── Section identity helpers ─────────────────────────────────────────────────
export const cityKey = (city: string): SectionKey => `city:${citySlug(city)}`;
export const industryKey = (k: string): SectionKey => `prof:${k.toLowerCase()}`;
// interest sections keep their taxonomy label as the key (e.g. 'Markets & Investing').

export interface UnifiedDef {
  key: SectionKey;
  label: string;
  kind: SectionKind;
  baseSection?: Section;  // base pool section this interest/industry draws from
  keywords: string[];     // candidacy matching against the major pool
  why: string;            // static seed for the WIM fallback (step 5)
  feeds: string[];        // dedicated minor feeds (may be empty → drawn from pool)
}

// Bridge INTEREST_SECTIONS labels → the INTEREST_FEEDS key space (lowercase +
// a few known aliases) so we can attach dedicated feeds where they exist.
const INTEREST_FEED_ALIAS: Record<string, string> = {
  'startups': 'startups & entrepreneurship',
  'environment & climate': 'climate',
  'health & wellness': 'health',
};
function feedsForInterest(label: string): string[] {
  const k = label.toLowerCase();
  return INTEREST_FEEDS[INTEREST_FEED_ALIAS[k] || k] || INTEREST_FEEDS[k] || [];
}

export function interestDef(label: string): UnifiedDef | null {
  const d = (INTEREST_SECTIONS as Record<string, any>)[label];
  if (!d) return null;
  return {
    key: label, label: d.label || label, kind: 'interest',
    baseSection: d.section, keywords: (d.keywords || []).map((k: string) => k.toLowerCase()),
    why: d.why || '', feeds: feedsForInterest(label),
  };
}
export function industryDef(key: string): UnifiedDef | null {
  const d = (PROFESSION_SECTIONS as Record<string, any>)[key];
  if (!d) return null;
  return {
    key: industryKey(key), label: d.label || key, kind: 'industry',
    baseSection: d.section, keywords: (d.keywords || []).map((k: string) => k.toLowerCase()),
    why: d.why || '', feeds: [],
  };
}
export function cityDef(city: string): UnifiedDef {
  const slug = citySlug(city);
  const feeds = CITY_FEEDS[slug] || (cityFeed ? [cityFeed(city)] : []);
  return { key: cityKey(city), label: city, kind: 'city', keywords: [city.toLowerCase(), slug], why: '', feeds };
}

// Sections a user actually has = core (added by route) + selected areas.
export function activeDefsForUser(sel: UserSelections): UnifiedDef[] {
  const defs: UnifiedDef[] = [];
  for (const i of sel.interests)  { const d = interestDef(i); if (d) defs.push(d); }
  for (const c of sel.cities)     { defs.push(cityDef(c)); }
  for (const p of sel.industries) { const d = industryDef(p); if (d) defs.push(d); }
  return defs;
}

// ── Minor feed set (D6 / D7): union of dedicated feeds for SELECTED areas only ─
// Never the full app catalogue — only areas some user actually picked.
export function minorFeedSet(all: UserSelections[]): { url: string; secs: Section[]; tier: number }[] {
  const seen = new Set<string>();
  const out: { url: string; secs: Section[]; tier: number }[] = [];
  const add = (urls: string[], secs: Section[]) => {
    for (const u of urls) { if (!u || seen.has(u)) continue; seen.add(u); out.push({ url: u, secs, tier: 2 }); }
  };
  for (const sel of all) {
    for (const c of sel.cities)    add(cityDef(c).feeds, ['india']);
    for (const i of sel.interests) { const d = interestDef(i); if (d) add(d.feeds, d.baseSection ? [d.baseSection] : ['india']); }
    // industries have no dedicated feeds today — drawn from the major pool by keyword.
  }
  return out;
}
