// src/lib/brief/route.ts  —  STEP 3: per-user routing (no prose needed yet)
//
// Places deduped stories into a user's sections by eventId reference. Runs on nw
// + candidacy only, so it's verifiable before any writing.
//
//   • CORE (D5): major 3 → india 4 → world 3 = 10, byte-identical across every
//     user (selection-independent), always filled even on a quiet day.
//   • FILL: lean to the edition ceiling with the best-nw QUALITY candidates —
//     Phase A round-robins the user's selected sections (AREA_QUOTA cap each, for
//     variety); Phase B keeps taking the single best remaining candidate across
//     those sections + india/world overflow.
//   • STARVATION: a story leaves availability only when PLACED.
//   • QUALITY over COUNT: never place a genuinely-scored-WEAK story to reach a
//     floor; ship short instead.
//   • MONOTONIC: full placement built to the largest ceiling, sliced per edition.
//
// ── Sprint 29.1 fix (no personalisation / identical briefs) ──────────────────
// The gate was `(s.nw ?? 0) < WEAK_NW`, which treated an UNSCORED story (nw
// undefined) as weak. Only front-page candidates get an nw score (~120 of ~1500),
// so every personalised candidate was unscored → dropped → Phase B backfilled
// india/world → identical core-only briefs. Ledger #24 fix: `scoreRank` ranks
// scored-strong → unscored → scored-weak; the gate excludes ONLY genuinely-
// scored-weak (nw present AND < WEAK_NW). Unscored ARE placeable, ranked last.
//
// ── Sprint 29.2 fix (interest sections all `cand 0`) ─────────────────────────
// Symptom the 29.1 route log exposed: interests resolved to zero candidates even
// though the pool had 314 business / 154 sport / 66 technology stories. Cause:
// dedupe tags each story's BASE SECTION from `topic_tags` (`sec:business` →
// `business`, lowercase), but routing matched candidacy on the interest LABEL
// (`Technology`, `Sport`, `Markets & Investing`). `Technology` ≠ `technology`,
// `Markets & Investing` ≠ `business` → nothing matched. Fix: an interest/industry
// section now matches candidacy on its LABEL *or* its BASE SECTION (config
// exposes `UnifiedDef.baseSection`) — the "draws from base section" design the
// taxonomy always intended. Core/city keys are unchanged (city already matches on
// its slug). The candidacy log now prints the base section it matched on, so a
// still-empty interest points at a taxonomy `.section` name, not at routing.

import type {
  DedupedPool, DedupedStory, RoutedBrief, RoutedSection, SectionKey, SectionKind, Edition, StepRoute,
} from './types';
import { CORE, EDITION_BOUNDS, AREA_QUOTA, FLAGS, activeDefsForUser, type UnifiedDef } from './config';

const WEAK_NW = parseInt(process.env.BRIEF_WEAK_NW || '3', 10);
const CORE_ORDER: SectionKey[] = ['major_events', 'india', 'world'];
const CORE_LABEL: Record<string, string> = { major_events: 'Top Stories', india: 'India', world: 'World' };

// Ranking: scored-strong (nw ≥ WEAK_NW) by nw; UNSCORED just below the weakest
// acceptable score so real nw wins where it exists but unscored still fills;
// scored-weak last.
function scoreRank(s: DedupedStory): number {
  const nw = s.nw;
  if (nw == null) return WEAK_NW - 0.5;
  if (nw < WEAK_NW) return -1;
  return nw;
}
function isScoredWeak(s: DedupedStory): boolean {
  return s.nw != null && s.nw < WEAK_NW;
}
// A section's candidacy keys: the label, plus the base section it draws from
// (interests/industries). Lets `Markets & Investing` pull from `business`, etc.
function matchKeys(d: UnifiedDef): SectionKey[] {
  return d.baseSection ? [d.key, d.baseSection as SectionKey] : [d.key];
}

interface PlacementItem { key: SectionKey; label: string; kind: SectionKind; eventId: number; }
interface Target { key: SectionKey; keys: SectionKey[]; label: string; kind: SectionKind; }

export const routeBrief: StepRoute = (pool: DedupedPool, user, edition: Edition): RoutedBrief => {
  const placed = new Set<number>();
  const order: PlacementItem[] = [];
  const defs = activeDefsForUser(user);
  const bounds = edition === 'deep' ? EDITION_BOUNDS['10min'] : EDITION_BOUNDS[edition];
  const MAX = EDITION_BOUNDS['10min'].ceiling; // build once to the largest ceiling; slice per edition

  // Candidates matching ANY of the given section keys (label or base section).
  const candidatesFor = (keys: SectionKey[]): DedupedStory[] =>
    pool.stories
      .filter((s) => !placed.has(s.eventId) && keys.some((k) => s.candidateSections.includes(k)))
      .sort((a, b) => scoreRank(b) - scoreRank(a) || ((b.eventCorr || 1) - (a.eventCorr || 1)));

  const place = (key: SectionKey, label: string, kind: SectionKind, s: DedupedStory) => {
    placed.add(s.eventId);
    order.push({ key, label, kind, eventId: s.eventId });
  };

  // Take up to n from `keys`, placing into section `key`. Skip only genuinely-
  // scored-weak (continue, not break: scoreRank sorts those last, so keep
  // scanning to reach unscored candidates above them).
  const fillSection = (keys: SectionKey[], key: SectionKey, label: string, kind: SectionKind, n: number, gate: boolean): number => {
    let took = 0;
    for (const s of candidatesFor(keys)) {
      if (took >= n || order.length >= MAX) break;
      if (gate && FLAGS.qualityFloor && isScoredWeak(s)) continue;
      place(key, label, kind, s);
      took++;
    }
    return took;
  };

  // 1) CORE — byte-identical across users (no quality gate; the day's big news).
  const coreMajor = fillSection(['major_events'], 'major_events', CORE_LABEL.major_events, 'core', CORE.major_events, false);
  const coreIndia = fillSection(['india'], 'india', CORE_LABEL.india, 'core', CORE.india, false);
  const coreWorld = fillSection(['world'], 'world', CORE_LABEL.world, 'core', CORE.world, false);

  // 2) Phase A — round-robin the user's selected sections, AREA_QUOTA cap each.
  const cap = new Map<SectionKey, number>();
  for (let progress = true; order.length < MAX && progress; ) {
    progress = false;
    for (const d of defs) {
      if (order.length >= MAX) break;
      if ((cap.get(d.key) ?? 0) >= AREA_QUOTA[d.kind]) continue;
      if (fillSection(matchKeys(d), d.key, d.label, d.kind, 1, true)) { cap.set(d.key, (cap.get(d.key) ?? 0) + 1); progress = true; }
    }
  }

  // 3) Phase B — lean to ceiling: best remaining quality candidate across the
  //    user's sections + india/world overflow (cap ignored).
  const targets: Target[] = [
    ...defs.map((d): Target => ({ key: d.key, keys: matchKeys(d), label: d.label, kind: d.kind })),
    { key: 'india', keys: ['india'], label: CORE_LABEL.india, kind: 'core' },
    { key: 'world', keys: ['world'], label: CORE_LABEL.world, kind: 'core' },
  ];
  for (let progress = true; order.length < MAX && progress; ) {
    progress = false;
    let best: { key: SectionKey; label: string; kind: SectionKind; s: DedupedStory } | null = null;
    for (const t of targets) {
      const c = candidatesFor(t.keys)[0];
      if (!c) continue;
      if (FLAGS.qualityFloor && isScoredWeak(c)) continue; // unscored allowed; scored-weak skipped
      if (!best || scoreRank(c) > scoreRank(best.s)) best = { key: t.key, label: t.label, kind: t.kind, s: c };
    }
    if (best) { place(best.key, best.label, best.kind, best.s); progress = true; }
  }

  // 4) slice to this edition's ceiling (monotonic), regroup into sections.
  const cut = order.slice(0, bounds.ceiling);
  const belowFloor = cut.length < bounds.floor;
  const sections = groupSections(cut);

  // ── per-user placement + candidacy diagnostics ──────────────────────────────
  const perSec = sections.map((s) => `${s.key}:${s.eventIds.length}`).join(' ');
  const coreKind = sections.filter((s) => s.kind === 'core').reduce((n, s) => n + s.eventIds.length, 0);
  console.log(
    `[route] ${user.userId} ${edition} — placed ${cut.length}/${bounds.ceiling} · ` +
    `core-fill major ${coreMajor}/${CORE.major_events} india ${coreIndia}/${CORE.india} world ${coreWorld}/${CORE.world} ` +
    `(=${coreMajor + coreIndia + coreWorld}) · core-kind ${coreKind} · personalised ${cut.length - coreKind}` +
    `${belowFloor ? ` · SHORT (<floor ${bounds.floor}: quality over count)` : ''} · [${perSec}]`,
  );
  if (defs.length) {
    const avail = defs.map((d) => {
      const keys = matchKeys(d);
      const cand = pool.stories.filter((s) => keys.some((k) => s.candidateSections.includes(k)));
      const strong = cand.filter((s) => s.nw != null && s.nw >= WEAK_NW).length;
      const uns = cand.filter((s) => s.nw == null).length;
      const got = sections.find((s) => s.key === d.key)?.eventIds.length ?? 0;
      const via = d.baseSection && d.baseSection !== d.key ? `+${d.baseSection}` : '';
      return `${d.key}${via}{cand ${cand.length}: nw≥${WEAK_NW} ${strong}, unscored ${uns} → placed ${got}}`;
    }).join(' · ');
    console.log(`[route] ${user.userId} candidacy — ${avail}`);
  } else {
    console.log(`[route] ${user.userId} candidacy — zero-selection user (core + india/world backfill only).`);
  }

  return {
    userId: user.userId,
    date: pool.date,
    edition,
    sections,
    targetCount: bounds.ceiling,
    ceilingReached: order.length >= bounds.ceiling,
    wim: {},
  };
};

function groupSections(items: PlacementItem[]): RoutedSection[] {
  const map = new Map<SectionKey, RoutedSection>();
  const seen: SectionKey[] = [];
  for (const it of items) {
    let sec = map.get(it.key);
    if (!sec) { sec = { key: it.key, label: it.label, kind: it.kind, eventIds: [] }; map.set(it.key, sec); seen.push(it.key); }
    sec.eventIds.push(it.eventId);
  }
  const core = CORE_ORDER.filter((k) => map.has(k)).map((k) => map.get(k)!);
  const rest = seen.filter((k) => !CORE_ORDER.includes(k)).map((k) => map.get(k)!);
  return [...core, ...rest];
}
