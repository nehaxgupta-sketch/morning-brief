// src/pages/api/brief.ts  (the orchestrator — "run.ts")
//
// Runs the pipeline, captures logs + cost PER STEP, and (mode=full) saves the
// run and briefs to Supabase. Steps run sequentially, so the console tee is safe.
//
//   mode=fetch   → fetch → dedupe
//   mode=route   → fetch → dedupe → route
//   mode=full    → … → write-facts → (write-wim → assemble | write-deep) → SAVE
//   mode=history → recent runs (window=7d | month)

import type { NextApiRequest, NextApiResponse } from 'next';
import type { UserSelections, Edition, DedupedPool, RoutedBrief, EditionBrief } from '@/lib/brief/types';
import { getISTDate } from '@/lib/brief/primitives';
import { fetchBrief } from '@/lib/brief/fetch';
import { dedupeBrief } from '@/lib/brief/dedupe';
import { routeBrief } from '@/lib/brief/route';
import { writeFacts } from '@/lib/brief/write-facts';
import { writeWim } from '@/lib/brief/write-wim';
import { writeDeep } from '@/lib/brief/write-deep';
import { assembleBrief } from '@/lib/brief/assemble';
import { resetCost, snapshotCost } from '@/lib/brief/transport';
import { saveRun, saveEditions, loadRuns, type StepRow } from '@/lib/brief/persist';

export const config = { maxDuration: 300 };

// ── Per-step log + cost capture ──────────────────────────────────────────────
interface StepResult<T = any> {
  name: string; ok: boolean; ms: number; error?: string;
  cost_usd: number; tokens_in: number; tokens_out: number; logs: string[]; result?: T;
}

const delta = (c0: ReturnType<typeof snapshotCost>) => {
  const c1 = snapshotCost();
  return { cost_usd: +(c1.usd - c0.usd).toFixed(5), tokens_in: c1.inTok - c0.inTok, tokens_out: c1.outTok - c0.outTok };
};

async function runStep<T>(name: string, fn: () => T | Promise<T>): Promise<StepResult<T>> {
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const cap = (level: 'log' | 'warn' | 'error') => (...args: any[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' '));
    (orig[level] as (...a: any[]) => void)(...args);
  };
  console.log = cap('log'); console.warn = cap('warn'); console.error = cap('error');
  const c0 = snapshotCost(); const t0 = Date.now();
  try {
    const result = await fn();
    return { name, ok: true, ms: Date.now() - t0, ...delta(c0), logs, result };
  } catch (e: any) {
    return { name, ok: false, ms: Date.now() - t0, ...delta(c0), error: e?.message || String(e), logs };
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  }
}
const safe = (a: any) => { try { return JSON.stringify(a); } catch { return String(a); } };
const strip = (s: StepResult) => ({ name: s.name, ok: s.ok, ms: s.ms, error: s.error, cost_usd: s.cost_usd, tokens_in: s.tokens_in, tokens_out: s.tokens_out, logs: s.logs });
const toRow = (s: StepResult): StepRow => ({ name: s.name, ok: s.ok, ms: s.ms, cost_usd: s.cost_usd || 0, tokens_in: s.tokens_in || 0, tokens_out: s.tokens_out || 0, logs: s.logs });
const byId = (sel: UserSelections[], id: string) => sel.find((s) => s.userId === id) || { userId: id, cities: [], interests: [], industries: [] };

// ── Orchestrated runs ────────────────────────────────────────────────────────
export async function runFetch(selections: UserSelections[], date: string) {
  const s1 = await runStep('fetch', () => fetchBrief(selections, date));
  if (!s1.ok) return { steps: [s1], pool: null as DedupedPool | null };
  const s2 = await runStep('dedupe', () => dedupeBrief(s1.result!));
  return { steps: [s1, s2], pool: (s2.ok ? s2.result : null) as DedupedPool | null };
}

const runRouteStep = (pool: DedupedPool, sel: UserSelections[], edition: Edition) =>
  runStep('route', () => sel.map((u) => routeBrief(pool, u, edition)));

async function persistRun(date: string, edition: Edition, steps: StepResult[], sel: UserSelections[], briefs: EditionBrief[], poolSize = 0) {
  const runId = await saveRun({
    run_date: date, mode: 'full', edition, ok: steps.every((s) => s.ok),
    steps: steps.map(toRow), meta: { user_count: sel.length, pool_size: poolSize },
  });
  if (runId && briefs.length) await saveEditions(runId, briefs);
  return runId;
}

export async function runFull(selections: UserSelections[], date: string, edition: Edition) {
  const f = await runFetch(selections, date);
  if (!f.pool) return { steps: f.steps, briefs: [] as EditionBrief[], runId: null as string | null };
  const pool = f.pool;

  const s3 = await runRouteStep(pool, selections, edition);
  const routed: RoutedBrief[] = s3.ok ? s3.result! : [];

  const used = Array.from(new Set(routed.flatMap((b) => b.sections.flatMap((s) => s.eventIds))));
  const s4 = await runStep('write-facts', () => writeFacts(pool, used));
  if (!s4.ok) {
    const steps = [...f.steps, s3, s4];
    return { steps, briefs: [] as EditionBrief[], runId: await persistRun(date, edition, steps, selections, [], pool.stories.length) };
  }
  const store = s4.result!;

  let steps: StepResult[]; let briefs: EditionBrief[];
  if (edition === 'deep') {
    const s5 = await runStep('write-deep', () => Promise.all(routed.map(async (b) => ({ ...assembleBrief(b, store), deep: await writeDeep(b, store) }))));
    briefs = s5.ok ? s5.result! : [];
    steps = [...f.steps, s3, s4, s5];
  } else {
    const s5 = await runStep('write-wim', () => Promise.all(routed.map((b) => writeWim(b, store, byId(selections, b.userId)))));
    const withWim: RoutedBrief[] = s5.ok ? s5.result! : routed;
    const s6 = await runStep('assemble', () => withWim.map((b) => assembleBrief(b, store)));
    briefs = s6.ok ? s6.result! : [];
    steps = [...f.steps, s3, s4, s5, s6];
  }
  const runId = await persistRun(date, edition, steps, selections, briefs, pool.stories.length);
  return { steps, briefs, runId };
}

// ── Profiles → UserSelections[] ──────────────────────────────────────────────
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
  resetCost();
  const mode = String(req.query.mode || req.body?.mode || 'fetch');
  const date = String(req.body?.date || getISTDate());
  const edition = (req.body?.edition || req.query.edition || '10min') as Edition;
  const full = req.query.full === '1' || req.query.full === 'true';

  if (mode === 'history') {
    const window = String(req.query.window || '7d');
    const since = new Date(Date.now() - (window === 'month' ? 31 : 7) * 864e5).toISOString();
    return res.status(200).json({ mode, window, since, runs: await loadRuns(since) });
  }

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
    const s3: StepResult<RoutedBrief[]> = f.pool
      ? await runRouteStep(f.pool, selections, edition)
      : { name: 'route', ok: false, ms: 0, cost_usd: 0, tokens_in: 0, tokens_out: 0, logs: [], result: [] };
    const briefs: RoutedBrief[] = s3.result || [];
    return res.status(200).json({
      mode, date, edition, steps: [...f.steps, s3].map(strip),
      briefs: briefs.map((b) => ({
        userId: b.userId, total: b.sections.reduce((n, s) => n + s.eventIds.length, 0), ceilingReached: b.ceilingReached,
        sections: b.sections.map((s) => ({ key: s.key, kind: s.kind, count: s.eventIds.length })),
      })),
    });
  }

  if (mode === 'full') {
    const { steps, briefs, runId } = await runFull(selections, date, edition);
    return res.status(200).json({ mode, date, edition, runId, steps: steps.map(strip), briefs });
  }

  return res.status(400).json({ error: `unknown mode "${mode}" (fetch | route | full | history).` });
}
