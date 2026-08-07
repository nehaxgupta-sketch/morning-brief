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
//   • STARVATION: a story leaves availability only when PLACED. One tagged for
//     india but not taken there (core filled) stays available to any other
//     section it's a candidate for.
//   • QUALITY over COUNT: never place a genuinely-scored-WEAK story to reach a
//     floor; ship short instead.
//   • MONOTONIC: the full placement is built edition-independently to the largest
//     ceiling, then sliced to THIS edition's ceiling → 5min is a prefix of 10min.
//
// ── Sprint 29.1 fix (no personalisation / identical briefs) ──────────────────
// The gate was `(s.nw ?? 0) < WEAK_NW`, which treats an UNSCORED story (nw
// undefined) as weak. But the engine only nw-scores the front-page candidates
// (~120 of ~1,500), so every personalised candidate is unscored → the gate
// dropped them all → Phase A placed nothing → Phase B backfilled india/world to
// the ceiling → every user got the same core-only brief. Ledger #24 fix:
//   • `scoreRank` ranks scored-strong first, then UNSCORED, then scored-weak last.
//   • the gate now excludes ONLY genuinely-scored-weak (nw present AND < WEAK_NW);
//     unscored stories ARE placeable, ranked last. Use `continue`, not `break`.
// Also: route now LOGS per-user placement + candidacy availability (it logged
// nothing before, which is why this defect was invisible in the digest).

import type {
  DedupedPool, DedupedStory, RoutedBrief, RoutedSection, SectionKey, SectionKind, Edition, StepRoute,
} from './types';
import { CORE, EDITION_BOUNDS, AREA_QUOTA, FLAGS, activeDefsForUser } from './config';

const WEAK_NW = parseInt(process.env.BRIEF_WEAK_NW || '3', 10);
const CORE_ORDER: SectionKey[] = ['major_events', 'india', 'world'];
const CORE_LABEL: Record<string, string> = { major_events: 'Top Stories', india: 'India', world: 'World' };

// Ranking key. Scored-strong (nw ≥ WEAK_NW) by nw; UNSCORED (nw == null) just
// below the weakest acceptable score so real nw wins where it exists but
// unscored stories still fill personalised sections; scored-weak last.
function scoreRank(s: DedupedStory): number {
  const nw = s.nw;
  if (nw == null) return WEAK_NW - 0.5;
  if (nw < WEAK_NW) return -1;
  return nw;
}
// A story is blocked ONLY if it was scored and scored weak. Unscored passes.
function isScoredWeak(s: DedupedStory): boolean {
  return s.nw != null && s.nw < WEAK_NW;
}

interface PlacementItem { key: SectionKey; label: string; kind: SectionKind; eventId: number; }

export const routeBrief: StepRoute = (pool: DedupedPool, user, edition: Edition): RoutedBrief => {
  const placed = new Set<number>();
  const order: PlacementItem[] = [];
  const defs = activeDefsForUser(user);
  const bounds = edition === 'deep' ? EDITION_BOUNDS['10min'] : EDITION_BOUNDS[edition];
  const MAX = EDITION_BOUNDS['10min'].ceiling; // build once to the largest ceiling; slice per edition

  const candidatesFor = (key: SectionKey): DedupedStory[] =>
    pool.stories
      .filter((s) => !placed.has(s.eventId) && s.candidateSections.includes(key))
      .sort((a, b) => scoreRank(b) - scoreRank(a) || ((b.eventCorr || 1) - (a.eventCorr || 1)));

  const place = (key: SectionKey, label: string, kind: SectionKind, s: DedupedStory) => {
    placed.add(s.eventId);
    order.push({ key, label, kind, eventId: s.eventId });
  };

  const fillSection = (key: SectionKey, label: string, kind: SectionKind, n: number, gate: boolean): number => {
    let took = 0;
    for (const s of candidatesFor(key)) {
      if (took >= n || order.length >= MAX) break;
      // Skip only genuinely-scored-weak (continue, not break: scoreRank sorts
      // them last, so we keep scanning to reach unscored candidates above them).
      if (gate && FLAGS.qualityFloor && isScoredWeak(s)) continue;
      place(key, label, kind, s);
      took++;
    }
    return took;
  };

  // 1) CORE — byte-identical across users (no quality gate; the day's big news).
  const coreMajor = fillSection('major_events', CORE_LABEL.major_events, 'core', CORE.major_events, false);
  const coreIndia = fillSection('india', CORE_LABEL.india, 'core', CORE.india, false);
  const coreWorld = fillSection('world', CORE_LABEL.world, 'core', CORE.world, false);

  // 2) Phase A — round-robin the user's selected sections, AREA_QUOTA cap each.
  const cap = new Map<SectionKey, number>();
  for (let progress = true; order.length < MAX && progress; ) {
    progress = false;
    for (const d of defs) {
      if (order.length >= MAX) break;
      if ((cap.get(d.key) ?? 0) >= AREA_QUOTA[d.kind]) continue;
      if (fillSection(d.key, d.label, d.kind, 1, true)) { cap.set(d.key, (cap.get(d.key) ?? 0) + 1); progress = true; }
    }
  }

  // 3) Phase B — lean to ceiling: best remaining quality candidate across the
  //    user's sections + india/world overflow (cap ignored). Zero-selection users
  //    fill india/world here.
  const overflow: SectionKey[] = [...defs.map((d) => d.key), 'india', 'world'];
  for (let progress = true; order.length < MAX && progress; ) {
    progress = false;
    let best: { key: SectionKey; label: string; kind: SectionKind; s: DedupedStory } | null = null;
    for (const key of overflow) {
      const c = candidatesFor(key)[0];
      if (!c) continue;
      if (FLAGS.qualityFloor && isScoredWeak(c)) continue; // unscored allowed; scored-weak skipped
      if (!best || scoreRank(c) > scoreRank(best.s)) {
        const d = defs.find((x) => x.key === key);
        best = { key, label: d?.label ?? CORE_LABEL[key] ?? key, kind: d?.kind ?? 'core', s: c };
      }
    }
    if (best) { place(best.key, best.label, best.kind, best.s); progress = true; }
  }

  // 4) slice to this edition's ceiling (monotonic), regroup into sections.
  const cut = order.slice(0, bounds.ceiling);
  const belowFloor = cut.length < bounds.floor;
  const sections = groupSections(cut);

  // ── per-user placement + candidacy diagnostics (route logged nothing before) ─
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
      const cand = pool.stories.filter((s) => s.candidateSections.includes(d.key));
      const strong = cand.filter((s) => s.nw != null && s.nw >= WEAK_NW).length;
      const uns = cand.filter((s) => s.nw == null).length;
      const got = sections.find((s) => s.key === d.key)?.eventIds.length ?? 0;
      return `${d.key}{cand ${cand.length}: nw≥${WEAK_NW} ${strong}, unscored ${uns} → placed ${got}}`;
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
