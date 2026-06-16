// src/pages/api/score-extras.tsx
//
// Sprint 14.2 — scoring for the products the main `score` stage doesn't cover:
//   - PERSONALISED briefs: same 7-dim rubric as the standard brief, but we
//     score a SAMPLE (one representative ready brief per edition per day) to
//     keep cost and noise down. Written to brief_scores with
//     edition = 'personalised:<edition>'.
//   - STORYLINES: a running narrative needs a different rubric than a brief,
//     so it gets 5 dimensions (accuracy / currency / coherence / sourcing /
//     significance) written to the storyline_scores table.
//
// Separate endpoint (not bolted onto the 4,300-line generate-brief.tsx) on
// purpose. Auth + cost logging mirror the other endpoints. Runs from /admin
// (RUN FULL PIPELINE includes it) and can be a cron.
//
// Body: {} = both; { "mode": "personalised" } or { "mode": "storylines" }.
//
// Sprint 14.5 — storyline scoring is gated. Scoring is internal QA only (it is
// never shown to readers), so we no longer score every active storyline; we
// score those a user FOLLOWS or that are new/updated today. Detection and the
// story-so-far narrative (in generate-brief.tsx) stay broad so the Stories tab
// is populated for new users — this change only trims wasted scorer calls.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { logOpenAICost, extractUsageFromChatCompletion } from '@/lib/cost-log';
import { attachLogCapture } from '@/lib/log-capture';

export const config = { maxDuration: 300 };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SCORE_MODEL = 'gpt-4o-mini';
const MAX_STORYLINES = 12; // cap per run to bound cost

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function authorise(req: NextApiRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!secret) return true;
  if (token && token === secret) return true;
  if (token) {
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) return true;
    } catch { /* fall through */ }
  }
  return false;
}

function getISTDate(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function extractJsonObject(text: string): any {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const clamp10 = (n: any) => {
  const v = typeof n === 'number' ? Math.round(n) : parseInt(String(n ?? 0), 10);
  return isNaN(v) ? 0 : Math.max(0, Math.min(10, v));
};

async function callScorer(prompt: string, detail: string): Promise<any> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: SCORE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await response.json();
  const usage = extractUsageFromChatCompletion(data);
  void logOpenAICost({
    phase: 'score',
    model: SCORE_MODEL,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    detail,
  });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Empty scorer response (${detail})`);
  return extractJsonObject(text);
}

// ─── Personalised briefs (7-dim brief rubric, sampled) ──────────────────────

const BRIEF_LIST_SECTIONS = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news', 'topics'];

function emptyBriefSectionCount(content: any): number {
  let empty = 0;
  let present = 0;
  for (const k of BRIEF_LIST_SECTIONS) {
    if (Array.isArray(content?.[k])) {
      present++;
      if (content[k].length === 0) empty++;
    }
  }
  return present > 0 ? empty : 0;
}

async function scorePersonalisedBrief(edition: string, content: any): Promise<any> {
  const compact = JSON.stringify(content).slice(0, 26000);
  const prompt = `You are the quality auditor for Morning Brief, scoring a PERSONALISED ${edition} edition for an urban Indian professional. Be honest; most production briefs score 50-62/70.

Score each 0-10:
1. dim_coverage — are the day's most consequential stories present for this reader?
2. dim_field_completeness — every story has its required fields populated (no nulls/placeholders)?
3. dim_india_anchor — are stories tied to a specific Indian impact/transmission channel?
4. dim_source_quality — diverse, authoritative sources (no single publisher dominating)?
5. dim_editorial_sharpness — specific names/numbers/dates over generic phrasing?
6. dim_currentness — headlines describe today's development, not stale narrative?
7. dim_relevance — right mix and depth for THIS reader's personalisation?

BRIEF CONTENT:
${compact}

Return ONLY JSON: {"dim_coverage":N,"dim_field_completeness":N,"dim_india_anchor":N,"dim_source_quality":N,"dim_editorial_sharpness":N,"dim_currentness":N,"dim_relevance":N,"notes":"2-3 sentences naming strongest and weakest dimension"}`;

  const p = await callScorer(prompt, `personalised:${edition}`);
  const dims = {
    dim_coverage: clamp10(p.dim_coverage),
    dim_field_completeness: clamp10(p.dim_field_completeness),
    dim_india_anchor: clamp10(p.dim_india_anchor),
    dim_source_quality: clamp10(p.dim_source_quality),
    dim_editorial_sharpness: clamp10(p.dim_editorial_sharpness),
    dim_currentness: clamp10(p.dim_currentness),
    dim_relevance: clamp10(p.dim_relevance),
  };
  // Same deterministic empty-section penalty as the standard scorer.
  const empty = emptyBriefSectionCount(content);
  const penalty = empty * 5;
  dims.dim_coverage = Math.max(0, dims.dim_coverage - penalty);
  dims.dim_field_completeness = Math.max(0, dims.dim_field_completeness - penalty);
  const total = Object.values(dims).reduce((a, b) => a + b, 0);
  const notes = (typeof p.notes === 'string' ? p.notes.slice(0, 700) : '')
    + (empty > 0 ? ` [auto-penalty: ${empty} empty section(s), -${penalty} on coverage & field completeness]` : '');
  return { ...dims, total, notes };
}

async function runPersonalised() {
  const today = getISTDate();
  const { data, error } = await supabase
    .from('personalised_briefs')
    .select('edition, content, status, generated_at')
    .eq('date', today)
    .in('status', ['ready', 'fallback'])
    .order('generated_at', { ascending: true });
  if (error) return { ok: false, error: `personalised read failed: ${error.message}` };

  const editions = ['5min', '10min', 'deep'];
  const results: Record<string, any> = {};
  // One representative (the first ready) per edition.
  await Promise.all(editions.map(async (ed) => {
    const row = (data || []).find((r: any) => r.edition === ed && r.content);
    if (!row) { results[ed] = { status: 'skipped', reason: 'no ready personalised brief' }; return; }
    try {
      const scored = await scorePersonalisedBrief(ed, row.content);
      const { error: insErr } = await supabase.from('brief_scores').upsert(
        { date: today, edition: `personalised:${ed}`, ...scored, max_score: 70 },
        { onConflict: 'date,edition' },
      );
      if (insErr) { results[ed] = { status: 'db_error', reason: insErr.message }; return; }
      results[ed] = { status: 'ready', total: scored.total };
    } catch (e: any) {
      results[ed] = { status: 'failed', reason: e?.message || String(e) };
    }
  }));
  return { ok: true, results };
}

// ─── Storylines (5-dim narrative rubric) ────────────────────────────────────

async function scoreStoryline(line: any, events: any[]): Promise<any> {
  const compact = JSON.stringify({
    title: line.title,
    story_so_far: line.story_so_far,
    confidence: line.confidence,
    events: events.slice(0, 12).map((e) => ({ date: e.date, headline: e.headline, source: e.source, source_url: e.source_url })),
  }).slice(0, 20000);

  const prompt = `You are the quality auditor for Morning Brief's "Follow a Story" feature. You score one STORYLINE — a running narrative built from tagged news events over time. Be honest; a healthy storyline scores 32-42/50.

Score each 0-10:
1. dim_accuracy — is "story_so_far" factually consistent with its events? No claims the events don't support?
2. dim_currency — does "story_so_far" reflect the LATEST event, or is it stale?
3. dim_coherence — does it read as ONE coherent thread with a clear through-line, not a pile of loosely-related clippings?
4. dim_sourcing — are the events well-sourced and reasonably diverse (not one outlet)?
5. dim_significance — is this a GENUINE ongoing story worth a reader following, vs a one-off that won't develop?

STORYLINE:
${compact}

Return ONLY JSON: {"dim_accuracy":N,"dim_currency":N,"dim_coherence":N,"dim_sourcing":N,"dim_significance":N,"notes":"2-3 sentences naming strongest and weakest dimension"}`;

  const p = await callScorer(prompt, `storyline:${line.slug || line.id}`);
  const dims = {
    dim_accuracy: clamp10(p.dim_accuracy),
    dim_currency: clamp10(p.dim_currency),
    dim_coherence: clamp10(p.dim_coherence),
    dim_sourcing: clamp10(p.dim_sourcing),
    dim_significance: clamp10(p.dim_significance),
  };
  const total = Object.values(dims).reduce((a, b) => a + b, 0);
  return { ...dims, total, notes: typeof p.notes === 'string' ? p.notes.slice(0, 700) : '' };
}

async function runStorylines() {
  const today = getISTDate();
  const { data: lines, error } = await supabase
    .from('storylines')
    .select('id, slug, title, story_so_far, confidence, status, last_event_at')
    .eq('status', 'active')
    .order('last_event_at', { ascending: false })
    .limit(MAX_STORYLINES);
  if (error) return { ok: false, error: `storylines read failed: ${error.message}` };
  if (!lines || lines.length === 0) return { ok: true, results: {}, note: 'no active storylines' };

  // Sprint 14.5: gate scoring to storylines a user FOLLOWS or that are
  // new/updated today. Scoring is internal QA and never shown to readers, so
  // there's no reader benefit to scoring stale, unfollowed narratives — this
  // just trims wasted scorer calls. (Detection and story-so-far generation are
  // unchanged and stay broad, so the Stories tab is still populated for new
  // users to discover and follow.)
  const { data: followRows } = await supabase
    .from('storyline_follows')
    .select('storyline_id');
  const followed = new Set(((followRows || []) as any[]).map((r) => r.storyline_id));
  const eligible = (lines as any[]).filter((l) =>
    followed.has(l.id) || String(l.last_event_at || '').slice(0, 10) === today,
  );
  if (eligible.length === 0) {
    return { ok: true, results: {}, note: 'no followed or fresh storylines to score today' };
  }
  console.log(`[score:storylines] ${eligible.length}/${lines.length} eligible (followed or fresh) — scoring those.`);

  // Pull recent events for the eligible storylines in one query.
  const ids = eligible.map((l: any) => l.id);
  const { data: evRows } = await supabase
    .from('storyline_events')
    .select('storyline_id, date, headline, source, source_url')
    .in('storyline_id', ids)
    .order('date', { ascending: false });
  const eventsByLine: Record<string, any[]> = {};
  for (const e of (evRows || []) as any[]) {
    (eventsByLine[e.storyline_id] ||= []).push(e);
  }

  const results: Record<string, any> = {};
  // Light concurrency to bound TPM.
  const queue = [...eligible];
  async function worker() {
    while (queue.length) {
      const line = queue.shift();
      if (!line) return;
      try {
        const scored = await scoreStoryline(line, eventsByLine[line.id] || []);
        const { error: insErr } = await supabase.from('storyline_scores').upsert(
          { date: today, storyline_id: line.id, slug: line.slug, ...scored, max_score: 50 },
          { onConflict: 'date,storyline_id' },
        );
        results[line.slug || line.id] = insErr ? { status: 'db_error', reason: insErr.message } : { status: 'ready', total: scored.total };
      } catch (e: any) {
        results[line.slug || line.id] = { status: 'failed', reason: e?.message || String(e) };
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { ok: true, results };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  attachLogCapture(res); // Sprint 14.5: tee server logs into the JSON response
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: 'Missing OPENAI_API_KEY' });
  if (!(await authorise(req))) return res.status(401).json({ ok: false, error: 'Unauthorised' });

  const mode = (req.body || {}).mode as string | undefined;
  const out: any = { ok: true, date: getISTDate() };

  try {
    if (!mode || mode === 'personalised') out.personalised = await runPersonalised();
    if (!mode || mode === 'storylines') out.storylines = await runStorylines();
    return res.status(200).json(out);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
