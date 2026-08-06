// src/lib/brief/persist.ts  —  save runs + editions, load history
//
// Best-effort: a persistence failure logs a warning and returns null/[] — it
// never crashes a pipeline run. TODO(wire): the Supabase client import below is
// inferred — adjust to your client if the path differs.

import type { EditionBrief } from './types';

export interface StepRow {
  name: string; ok: boolean; ms: number;
  cost_usd: number; tokens_in: number; tokens_out: number; logs: string[];
}
export interface RunRecord {
  run_date: string; mode: string; edition?: string; ok: boolean;
  steps: StepRow[]; meta: Record<string, any>;
}

async function client(): Promise<any | null> {
  try {
    const mod: any = await import('@/lib/supabase'); // adjust to your client export
    return mod.supabaseAdmin || mod.supabase || mod.default || null;
  } catch (e: any) {
    console.warn('[persist] supabase client unavailable:', e?.message || e);
    return null;
  }
}

export async function saveRun(rec: RunRecord): Promise<string | null> {
  const db = await client();
  if (!db) return null;
  const total = rec.steps.reduce((n, s) => n + (s.cost_usd || 0), 0);
  const { data, error } = await db
    .from('brief_runs')
    .insert({
      run_date: rec.run_date, mode: rec.mode, edition: rec.edition ?? null, ok: rec.ok,
      total_cost_usd: Number(total.toFixed(5)), steps: rec.steps, meta: rec.meta,
    })
    .select('id')
    .single();
  if (error) { console.warn('[persist] saveRun failed:', error.message); return null; }
  return data?.id ?? null;
}

export async function saveEditions(runId: string, briefs: EditionBrief[]): Promise<number> {
  const db = await client();
  if (!db || !briefs.length) return 0;
  const rows = briefs.map((b) => ({
    run_id: runId, run_date: b.date, user_id: b.userId, edition: b.edition, content: b,
  }));
  const { error } = await db.from('brief_editions').insert(rows);
  if (error) { console.warn('[persist] saveEditions failed:', error.message); return 0; }
  return rows.length;
}

// Lightweight run list for the admin history (no heavy step logs).
export async function loadRuns(sinceISO: string): Promise<any[]> {
  const db = await client();
  if (!db) return [];
  const { data, error } = await db
    .from('brief_runs')
    .select('id, created_at, run_date, mode, edition, ok, total_cost_usd, meta')
    .gte('created_at', sinceISO)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) { console.warn('[persist] loadRuns failed:', error.message); return []; }
  return data || [];
}
