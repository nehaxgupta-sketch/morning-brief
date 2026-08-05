// src/pages/api/brief.ts  (the orchestrator — "run.ts")
//
// Runs the pipeline and captures logs PER STEP, so a single-step run shows only
// that step's output. Steps run sequentially, so the console tee is safe.
//
// Modes:
//   mode=fetch → fetch → dedupe                         (inspect the pool)
//   mode=route → fetch → dedupe → route                 (inspect per-user allocation)
//   mode=full  → … → write-facts → write-wim → assemble (inspect assembled briefs)
//
// Selections come from the request body (smoke-test immediately) or loadSelections().
// Persistence is deliberately NOT wired yet — we validate the assembled shape
// together first, then add the upsert.

import type { NextApiRequest, NextApiResponse } from 'next';
import type { UserSelections, Edition, DedupedPool, RoutedBrief, EditionBrief } from '@/lib/brief/types';
import { getISTDate } from '@/lib/brief/primitives';
import { fetchBrief } from '@/lib/brief/fetch';
import { dedupeBrief } from '@/lib/brief/dedupe';
import { routeBrief } from '@/lib/brief/route';
import { writeFacts } from '@/lib/brief/write-facts';
import { writeWim } from '@/lib/brief/write-wim';
import { assembleBrief } from '@/lib/brief/assemble';

export const config = { maxDuration: 300 };

// ── Per-step log capture ─────────────────────────────────────────────────────
interface StepResult<T = any> { name: string; ok: boolean; ms: number; error?: string; logs: string[]; result?: T; }

async function runStep<T>(name: string, fn: () => T | Promise<T>): Promise<StepResult<T>> {
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const cap = (level: 'log' | 'warn' | 'error') => (...args: any[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' '));
    (orig[level] as (...a: any[]) => void)(...args);
  };
  console.log = cap('log'); console.warn = cap('warn'); console.error = cap('error');
  const t0 = Date.now();
  try {
    return { name, ok: true, ms: Date.now() - t0, logs, result: await fn() };
  } catch (e: any) {
    return { name, ok: false, ms: Date.now() - t0, error: e?.message || String(e), logs };
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  }
}
const safe = (a: any) => { try { return JSON.stringify(a); } catch { return String(a); } };
const strip = (s: StepResult) => ({ name: s.name, ok: s.ok, ms: s.ms, error: s.error, logs: s.logs });
const byId = (sel: UserSelections[], id: string) => sel.find((s) => s.userId === id) || { userId: id, cities: [], interests: [], industries: [] };

// ── Orchestrated runs ────────────────────────────────────────────────────────
export async function runFetch(selections: UserSelections[], date: string) {
  const s1 = await runStep('fetch', () => fetchBrief(selections, date));
  if (!s1.ok) return { steps: [s1], pool: null as DedupedPool | null };
  const s2 = await runStep('dedupe', () => dedupeBrief(s1.result!));
  return { steps: [s1, s2], pool: (s2.ok ? s2.result : null) as DedupedPool | null };
}

async function runRouteStep(pool: DedupedPool, selections: UserSelections[], edition: Edition) {
  return runStep('route', () => selections.map((u) => routeBrief(pool, u, edition)));
}

export async function runFull(selections: UserSelections[], date: string, edition: Edition) {
  const f = await runFetch(selections, date);
  if (!f.pool) return { steps: f.steps, briefs: [] as EditionBrief[] };
  const pool = f.pool;

  const s3 = await runRouteStep(pool, selections, edition);
  const routed: RoutedBrief[] = s3.ok ? s3.result! : [];

  const used = Array.from(new Set(routed.flatMap((b) => b.sections.flatMap((s) => s.eventIds))));
  const s4 = await runStep('write-facts', () => writeFacts(pool, used));
  if (!s4.ok) return { steps: [...f.steps, s3, s4], briefs: [] as EditionBrief[] };
  const store = s4.result!;

  const s5 = await runStep('write-wim', () => Promise.all(routed.map((b) => writeWim(b, store, byId(selections, b.userId)))));
  const withWim: RoutedBrief[] = s5.ok ? s5.result! : routed;

  const s6 = await runStep('assemble', () => withWim.map((b) => assembleBrief(b, store)));
  return { steps: [...f.steps, s3, s4, s5, s6], briefs: (s6.ok ? s6.result! : []) as EditionBrief[] };
}

// ── Profiles → UserSelections[] ──────────────────────────────────────────────
// TODO(wire): point this at your existing profiles query + Supabase client.
async function loadSelections(): Promise<UserSelections[]> {
  try {
    const { supabaseAdmin } = await import('@/lib/supabase'); // adjust import to your client
    const { data, error } = await supabaseAdmin.from('profiles').select('id, city_current, interests, industries');
    if (error || !data) { console.warn('[run] loadSelections failed:', error?.message); return []; }
    return (data as any[]).map((p) => ({
      userId: p.id,
      cities: [p.city_current].filter(Boolean),
      interests: Array.isArray(p.interests) ? p.interests : [],
      industries: Array.isArray(p.industries) ? p.industries : [],
    }));
  } catch (e: any) {
    console.warn('[run] loadSelections unavailable — pass selections in the request body.', e?.message || e);
    return [];
  }
}

// ── API handler ──────────────────────────────────────────────────────────────
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const mode = String(req.query.mode || req.body?.mode || 'fetch');
  const date = String(req.body?.date || getISTDate());
  const edition = (req.body?.edition || req.query.edition || '10min') as Edition;
  const full = req.query.full === '1' || req.query.full === 'true';
  const selections: UserSelections[] = req.body?.selections || (await loadSelections());

  if (mode === 'fetch') {
    const { steps, pool } = await runFetch(selections, date);
    return res.status(200).json({
      mode, date, steps: steps.map(strip), poolSize: pool?.stories.length ?? 0,
      pool: full ? pool?.stories : pool?.stories.map((s) => ({ eventId: s.eventId, nw: s.nw, headline: s.headline, candidateSections: s.candidateSections })),
    });
  }

  if (mode === 'route') {
    const f = await runFetch(selections, date);
    const s3 = f.pool ? await runRouteStep(f.pool, selections, edition) : { logs: [], ok: false, name: 'route', ms: 0, result: [] as RoutedBrief[] };
    const briefs: RoutedBrief[] = (s3 as any).result || [];
    return res.status(200).json({
      mode, date, edition, steps: [...f.steps, s3].map(strip),
      briefs: briefs.map((b) => ({
        userId: b.userId, total: b.sections.reduce((n, s) => n + s.eventIds.length, 0), ceilingReached: b.ceilingReached,
        sections: b.sections.map((s) => ({ key: s.key, kind: s.kind, count: s.eventIds.length })),
      })),
    });
  }

  if (mode === 'full') {
    const { steps, briefs } = await runFull(selections, date, edition);
    return res.status(200).json({ mode, date, edition, steps: steps.map(strip), briefs });
  }

  return res.status(400).json({ error: `unknown mode "${mode}" (fetch | route | full).` });
}
