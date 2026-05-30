// src/pages/api/personalise-briefs.tsx
//
// Personalisation endpoint for Morning Brief.
// For every user with profiles.brief_type = 'personalised', it takes today's
// shared brief (per edition), asks Claude Haiku how to RE-ORDER the stories for
// that specific reader and which few stories deserve a one-line "why this matters
// to you" note, then writes a personalised copy into personalised_briefs.
//
// Design notes (Sprint 5):
//  - Uses the Supabase SERVICE-ROLE key so it can read every profile and write
//    into the RLS-protected personalised_briefs table from a server cron.
//  - Claude only returns a small re-ordering PLAN (indices + short notes), never
//    rewritten story text. We apply the plan in code, so story text, sources and
//    URLs can never be corrupted or lost.
//  - Every user is isolated in its own try/catch: one bad profile can't abort the
//    whole run.
//  - Degrades gracefully: if Claude's plan is missing or partly invalid, we keep
//    the original order for whatever we can't apply and still produce a valid brief.
//  - The personalised "For you" note is folded into the story body so it renders
//    with zero changes to brief.tsx.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// Give the function the full Hobby-plan budget (the default would be shorter).
export const config = { maxDuration: 60 };

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const EDITIONS = ['5min', '10min', 'deep'] as const;
type Edition = (typeof EDITIONS)[number];

// Keep personalised notes tasteful — never spammy.
const MAX_NOTES_PER_BRIEF = 4;

// Never re-order or annotate these — they aren't story arrays.
const SKIP_KEYS = new Set(['closer', 'markets']);

// ---- Supabase (service role — bypasses RLS) ----
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Today's date in IST as YYYY-MM-DD. Mirrors getISTDate() in generate-brief.tsx.
function getISTDate(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

// jsonb columns come back as objects, but guard against a stringified value too.
function asObject(value: any): any {
  if (value && typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

// Pull just the fields worth personalising on (don't leak the whole profile row).
function profileForPrompt(p: any) {
  return {
    full_name: p.full_name ?? null,
    city_current: p.city_current ?? null,
    city_home: p.city_home ?? null,
    profession: p.profession ?? null,
    industry: p.industry ?? null,
    interests: p.interests ?? null,
    mood_preference: p.mood_preference ?? null,
  };
}

// Is `order` a clean permutation of [0..len-1]?
function isValidOrder(order: any, len: number): order is number[] {
  if (!Array.isArray(order) || order.length !== len) return false;
  const seen = new Set<number>();
  for (const i of order) {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= len) return false;
    if (seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

// Fold a short personalised note into a story's body so it renders everywhere,
// with no frontend changes. (HTML collapses the "\n\n" to a space if brief.tsx
// doesn't preserve newlines — still reads fine either way.)
function appendNote(story: any, note: string) {
  const clean = String(note).trim();
  if (!clean) return;
  const body = typeof story.body === 'string' ? story.body : '';
  story.body = body ? `${body}\n\nFor you — ${clean}` : `For you — ${clean}`;
}

// Build the personalised content from the ORIGINAL brief + Claude's plan.
// Returns counts so we can see (and dry-run) what actually changed.
function applyPlan(original: any, plan: any) {
  // Deep clone so we never mutate the shared brief object.
  const content = JSON.parse(JSON.stringify(original));
  let sectionsReordered = 0;
  let notesAdded = 0;

  if (!plan || typeof plan !== 'object') {
    return { content, sectionsReordered, notesAdded };
  }

  for (const key of Object.keys(content)) {
    if (SKIP_KEYS.has(key)) continue;
    const arr = content[key];
    if (!Array.isArray(arr) || arr.length === 0) continue; // only story arrays

    const sectionPlan = plan[key];
    if (!sectionPlan || typeof sectionPlan !== 'object') continue;

    // 1) Apply notes by ORIGINAL index (before reordering), capped globally.
    const notes = sectionPlan.notes;
    if (notes && typeof notes === 'object') {
      for (const idxStr of Object.keys(notes)) {
        if (notesAdded >= MAX_NOTES_PER_BRIEF) break;
        const idx = Number(idxStr);
        if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) continue;
        const note = notes[idxStr];
        if (typeof note !== 'string' || !note.trim()) continue;
        appendNote(arr[idx], note);
        notesAdded++;
      }
    }

    // 2) Re-order — but only if Claude gave a clean permutation.
    if (isValidOrder(sectionPlan.order, arr.length)) {
      content[key] = sectionPlan.order.map((i: number) => arr[i]);
      const changed = sectionPlan.order.some((i: number, pos: number) => i !== pos);
      if (changed) sectionsReordered++;
    }
  }

  return { content, sectionsReordered, notesAdded };
}

// ---------------------------------------------------------------------------
// Claude call — returns a re-ordering PLAN only
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You personalise a daily news brief for one specific reader.
You receive the reader's profile and today's brief content as JSON.

Your job:
- For each news section (the keys whose values are arrays of stories), decide the best order to show that section's stories for THIS reader. Put stories most relevant to their profession, industry, interests, and cities first.
- Across the ENTIRE brief, pick AT MOST ${MAX_NOTES_PER_BRIEF} stories that are especially relevant to this reader and write a single short note (max ~18 words, addressed to "you") explaining why. Most stories get no note.

Hard rules:
- Re-order stories WITHIN a section only. Never invent, merge, drop, or rewrite stories.
- Do not touch the closer, markets, or any non-array field.
- Refer to original 0-based positions within each section.

Output ONLY one JSON object — no prose, no markdown fences — in EXACTLY this shape:
{
  "<sectionKey>": { "order": [<original indices, every index exactly once>], "notes": { "<originalIndex>": "<short note>" } }
}
Include one entry per array-valued section. "order" must list every original index of that section exactly once. "notes" may be {}. Across all sections combined, include no more than ${MAX_NOTES_PER_BRIEF} notes.`;

async function getPlanFromHaiku(
  profile: any,
  editionContent: any,
  edition: Edition
): Promise<{ plan: any | null; error?: string }> {
  const userPrompt =
    `READER PROFILE:\n${JSON.stringify(profileForPrompt(profile), null, 2)}\n\n` +
    `TODAY'S BRIEF (edition: ${edition}):\n${JSON.stringify(editionContent)}\n\n` +
    `Return the personalisation plan now.`;

  let resp: Response;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
  } catch (e: any) {
    return { plan: null, error: `fetch_failed: ${e?.message || e}` };
  }

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { plan: null, error: `anthropic_${resp.status}: ${data?.error?.message || 'unknown'}` };
  }

  const text = Array.isArray(data?.content)
    ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
    : '';

  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return { plan: JSON.parse(cleaned) };
  } catch {
    return { plan: null, error: 'parse_failed' };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Accept GET or POST so it works from any cron service.
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Optional shared-secret guard. If CRON_SECRET is set, callers must send it as
  // "Authorization: Bearer <secret>". If it's NOT set, the endpoint stays open
  // (same as before) so nothing breaks if you skip the secret step.
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers['authorization'] || '';
    const provided = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const bearer = provided.replace(/^Bearer\s+/i, '').trim();
    const alt =
      (req.headers['x-cron-secret'] as string) ||
      (req.body && (req.body as any).secret) ||
      (req.query.secret as string);
    if (bearer !== expectedSecret && alt !== expectedSecret) {
      return res.status(401).json({ success: false, error: 'Unauthorised' });
    }
  }

  // Optional params (work via POST body or query string).
  const body = req.body && typeof req.body === 'object' ? (req.body as any) : {};
  const onlyUserId: string | undefined = body.userId || (req.query.userId as string) || undefined;
  const dryRun: boolean = body.dryRun === true || req.query.dryRun === 'true';

  // Env sanity so failures are obvious instead of cryptic.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: 'Missing SUPABASE_SERVICE_ROLE_KEY env var' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ success: false, error: 'Missing ANTHROPIC_API_KEY env var' });
  }

  const date = getISTDate();

  // 1) Load today's shared briefs once, map by edition.
  const { data: briefRows, error: briefErr } = await supabase
    .from('briefs')
    .select('edition, status, content')
    .eq('date', date);

  if (briefErr) {
    return res.status(500).json({ success: false, error: `Failed to load briefs: ${briefErr.message}` });
  }

  const briefByEdition: Record<string, any> = {};
  for (const row of briefRows || []) briefByEdition[row.edition] = row;

  // 2) Load personalised users.
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('brief_type', 'personalised');

  if (profErr) {
    return res.status(500).json({ success: false, error: `Failed to load profiles: ${profErr.message}` });
  }

  let users = profiles || [];
  if (onlyUserId) {
    users = users.filter((p: any) => (p.user_id || p.id) === onlyUserId);
  }

  const results: any[] = [];

  // 3) For each user, personalise each edition.
  for (const profile of users) {
    const userId = profile.user_id || profile.id;
    const userResult: any = { userId, fullName: profile.full_name ?? null, editions: {} };

    if (!userId) {
      userResult.error = 'profile row has no user_id/id';
      results.push(userResult);
      continue;
    }

    try {
      // Editions in parallel per user (keeps each user well under the time budget).
      await Promise.all(
        EDITIONS.map(async (edition) => {
          const source = briefByEdition[edition];
          if (!source || source.status === 'failed' || !source.content) {
            userResult.editions[edition] = { status: 'skipped', reason: 'no source brief today' };
            return;
          }

          const editionContent = asObject(source.content);
          const { plan, error } = await getPlanFromHaiku(profile, editionContent, edition);

          if (error || !plan) {
            // No usable plan → write nothing; the app falls back to the shared
            // brief for this edition automatically.
            userResult.editions[edition] = { status: 'fallback', reason: error || 'no plan' };
            return;
          }

          const { content, sectionsReordered, notesAdded } = applyPlan(editionContent, plan);

          if (dryRun) {
            userResult.editions[edition] = { status: 'dry_run', sectionsReordered, notesAdded };
            return;
          }

          const { error: upsertErr } = await supabase
            .from('personalised_briefs')
            .upsert(
              {
                user_id: userId,
                date,
                edition,
                status: 'ready',
                content,
                generated_at: new Date().toISOString(),
              },
              { onConflict: 'user_id,date,edition' }
            );

          if (upsertErr) {
            userResult.editions[edition] = { status: 'db_error', reason: upsertErr.message };
            return;
          }

          userResult.editions[edition] = { status: 'ready', sectionsReordered, notesAdded };
        })
      );
    } catch (e: any) {
      userResult.error = `unexpected: ${e?.message || e}`;
    }

    results.push(userResult);
  }

  const editionsReady = results.reduce(
    (n, r) => n + Object.values(r.editions || {}).filter((e: any) => e.status === 'ready').length,
    0
  );

  return res.status(200).json({
    success: true,
    date,
    dryRun,
    processed: results.length,
    editionsReady,
    results,
  });
}
