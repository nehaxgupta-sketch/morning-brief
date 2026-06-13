// src/pages/api/storylines.tsx
//
// Sprint 13 — Follow a Story: user-initiated storyline creation.
//
// Two actions, both POST, both requiring a logged-in user's supabase session
// token in Authorization: Bearer <token> (the user is derived from the token,
// never trusted from the body):
//
//   { action: 'create-and-follow', story: { headline, summary, source, source_url } }
//     → qualifies the story with gpt-4o-mini (same qualifying test as the
//       pipeline's auto-detection). If it qualifies: creates the storyline
//       (origin 'user'), inserts the seed event, inserts the follow row, and
//       returns { ok, qualified: true, storyline }. If not: { ok, qualified:
//       false, reason } — the UI shows "ONE-OFF STORY". Fast (~3-5s).
//
//   { action: 'backfill', storylineId }
//     → ONE-TIME "how we got here": a gpt-4o-mini-search-preview call that
//       writes story_so_far + up to 4 historical milestone events. The client
//       fires this without awaiting it; if it never completes, the morning
//       mode=storylines stage self-heals (it backfills any active storyline
//       with a null story_so_far). ~15-25s.
//
// Caps respected: creation refuses past 25 ACTIVE storylines system-wide.
// Following an EXISTING storyline never touches this API — the client writes
// storyline_follows directly under RLS.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { isWhitelistedSource } from '@/lib/whitelist';
import { logOpenAICost, extractUsageFromChatCompletion } from '@/lib/cost-log';

export const config = { maxDuration: 60 };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const STORYLINE_MAX_ACTIVE = 25;

function getISTDate(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

function slugifyTitle(t: string): string {
  const s = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || `storyline-${Date.now()}`;
}

function extractJsonObject(text: string): any {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ─── Model calls ─────────────────────────────────────────────────────────────

async function callMiniJson(prompt: string, label: string, maxTokens = 800): Promise<any> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await response.json();
  const usage = extractUsageFromChatCompletion(data);
  void logOpenAICost({
    phase: 'storyline', model: 'gpt-4o-mini',
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens, detail: label,
  });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Empty model response (${label}): ${JSON.stringify(data).slice(0, 300)}`);
  return extractJsonObject(text);
}

async function callSearchJson(prompt: string, label: string): Promise<any | null> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini-search-preview',
        web_search_options: {},
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
      }),
    });
    const data = await response.json();
    if (response.status !== 200) {
      console.warn(`[storylines-api:${label}] search model ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return null;
    }
    const usage = extractUsageFromChatCompletion(data);
    void logOpenAICost({
      phase: 'storyline', model: 'gpt-4o-mini-search-preview',
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens, detail: label,
    });
    const text = data?.choices?.[0]?.message?.content || '';
    return text ? extractJsonObject(text) : null;
  } catch (err: any) {
    console.warn(`[storylines-api:${label}] ${err?.message || err}`);
    return null;
  }
}

// ─── Event insert (URL-level dedup; the DB unique index is the backstop) ────

async function insertEvent(
  storylineId: string,
  ev: { date: string; headline: string; summary: string; source: string; source_url: string; origin: string },
): Promise<void> {
  if (ev.source_url) {
    const { data: hit } = await supabase
      .from('storyline_events').select('id')
      .eq('storyline_id', storylineId).eq('source_url', ev.source_url).limit(1);
    if (hit && hit.length > 0) return;
  }
  const { error } = await supabase.from('storyline_events').insert({
    storyline_id: storylineId,
    date: ev.date,
    headline: ev.headline.slice(0, 300),
    summary: ev.summary ? ev.summary.slice(0, 800) : null,
    source: ev.source || null,
    source_url: ev.source_url || null,
    origin: ev.origin,
  });
  if (error && !String(error.message || '').toLowerCase().includes('duplicate')) {
    console.warn(`[storylines-api] event insert failed: ${error.message}`);
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function actionCreateAndFollow(userId: string, story: any, res: NextApiResponse) {
  const headline = String(story?.headline || '').trim();
  const summary = String(story?.summary || '').trim();
  const source = String(story?.source || '').trim();
  const sourceUrl = String(story?.source_url || '').trim();
  if (headline.length < 5) {
    return res.status(400).json({ ok: false, error: 'story.headline is required' });
  }

  const today = getISTDate();

  // 1. Qualify — the same test the pipeline applies to auto-detection.
  const qualifyPrompt = `You decide whether a news story deserves a "storyline" — a named, ongoing narrative that accumulates updates over days or weeks (e.g. "US–Iran nuclear standoff", "RBI rate-cut cycle"). Today is ${today}.

STORY: "${headline}" — ${summary.slice(0, 300)}

Qualifying test (ALL must hold):
- Multi-day arc: clearly a chapter in a continuing situation, not a self-contained event
- Expected future developments: a reader would plausibly ask "what happened next?" in coming days/weeks
- Recurring named entities: specific actors/institutions that will keep appearing in coverage
One-off events (accidents, match results, product launches, weather) do NOT qualify even if big. An election RESULT is an event; an election SEASON is a storyline.

ALWAYS provide a crisp 3-7 word title naming the story topic — even when qualified=false (the user may still choose to track it).

Return ONLY JSON:
{ "qualified": true|false, "title": "<crisp 3-7 word title - ALWAYS provided>", "confidence": "high"|"normal", "reason": "<one line>" }`;

  // Sprint 13.3 (locked with Neha): a user follow is NEVER refused - the
  // choice is theirs. The qualify call now only supplies the storyline TITLE
  // and confidence. Short-arc stories that get no updates go dormant in 7
  // days and conclude in 30; the lifecycle is the gatekeeper, not this API.
  // (Pipeline AUTO-creation keeps the strict qualifying test - the system
  // never nudges users toward junk; it just does not overrule them.)
  let verdict: any = null;
  try {
    verdict = await callMiniJson(qualifyPrompt, `qualify:${headline.slice(0, 40)}`);
  } catch (e: any) {
    console.warn(`[storylines-api] qualify call failed (continuing with headline as title): ${e?.message || e}`);
  }

  const title = (typeof verdict?.title === 'string' && verdict.title.trim().length >= 4)
    ? verdict.title.trim().slice(0, 140)
    : headline.slice(0, 80);
  const slug = slugifyTitle(title);
  const confidence = verdict?.qualified === true && verdict?.confidence === 'high' ? 'high' : 'normal';

  // 2. Reuse an existing storyline if the slug already exists (any status —
  //    a user re-following a concluded narrative revives it).
  const { data: existing } = await supabase
    .from('storylines').select('id, title, confidence, status').eq('slug', slug).maybeSingle();

  let storylineId: string;
  if (existing) {
    storylineId = existing.id;
    if (existing.status !== 'active') {
      await supabase.from('storylines')
        .update({ status: 'active', last_event_at: today, updated_at: new Date().toISOString() })
        .eq('id', storylineId);
    }
  } else {
    // 3. Respect the 25-active system cap.
    const { count } = await supabase
      .from('storylines').select('id', { count: 'exact', head: true }).eq('status', 'active');
    if ((count || 0) >= STORYLINE_MAX_ACTIVE) {
      return res.status(200).json({
        ok: false,
        error: `Storyline limit reached (${STORYLINE_MAX_ACTIVE} active). Older storylines conclude automatically — try again in a few days.`,
      });
    }
    const { data: created, error: cErr } = await supabase
      .from('storylines')
      .insert({ slug, title, confidence, status: 'active', origin: 'user', last_event_at: today })
      .select('id')
      .single();
    if (cErr || !created) {
      return res.status(500).json({ ok: false, error: `Create failed: ${cErr?.message || 'no row'}` });
    }
    storylineId = created.id;
  }

  // 4. Seed event + follow row.
  await insertEvent(storylineId, {
    date: today, headline, summary, source,
    source_url: isWhitelistedSource(sourceUrl) ? sourceUrl : '',
    origin: 'tag',
  });
  const { error: fErr } = await supabase
    .from('storyline_follows')
    .upsert({ user_id: userId, storyline_id: storylineId }, { onConflict: 'user_id,storyline_id' });
  if (fErr) {
    return res.status(500).json({ ok: false, error: `Follow failed: ${fErr.message}` });
  }

  return res.status(200).json({
    ok: true, qualified: true,
    storyline: { id: storylineId, title, confidence },
  });
}

async function actionBackfill(storylineId: string, res: NextApiResponse) {
  const { data: line, error } = await supabase
    .from('storylines')
    .select('id, slug, title, story_so_far')
    .eq('id', storylineId)
    .maybeSingle();
  if (error || !line) {
    return res.status(404).json({ ok: false, error: 'Storyline not found' });
  }
  if (line.story_so_far) {
    // Already backfilled (e.g. double-tap or pipeline got there first).
    return res.status(200).json({ ok: true, skipped: 'story_so_far already present' });
  }

  const today = getISTDate();
  const { data: seedEv } = await supabase
    .from('storyline_events')
    .select('headline, summary')
    .eq('storyline_id', line.id)
    .order('date', { ascending: false })
    .limit(1);
  const seed = seedEv?.[0];

  const prompt = `You are building the "how we got here" context for a news storyline titled "${line.title}".${seed ? ` The latest development: "${seed.headline} — ${(seed.summary || '').slice(0, 200)}".` : ''} Today is ${today}.

Search the web for the KEY PRIOR MILESTONES of this storyline (the 2-4 moments a new reader needs to understand the arc), and write a neutral 3-4 sentence "story so far" in a calm, analytical register (Economist/FT), ending with why it matters for Indian readers where relevant.

WRITING RULES for story_so_far: plain prose only — NO markdown links, NO URLs, NO citation brackets, NO "([domain](url))" references. Sources belong in the milestones array, never in the prose.

SOURCE RULES: milestone source_urls must be direct article URLs from major reputable outlets (Reuters, AP, Bloomberg, FT, BBC, The Guardian, Al Jazeera, The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, NDTV, Times of India).

Return ONLY this JSON, no markdown:
{
  "story_so_far": "<3-4 sentences>",
  "milestones": [ { "date": "YYYY-MM-DD", "headline": "...", "summary": "1-2 sentences", "source": "Publisher", "source_url": "https://..." } ]
}`;

  const bf = await callSearchJson(prompt, `backfill:${line.slug}`);
  if (!bf) {
    return res.status(200).json({ ok: false, error: 'Backfill fetch failed — the morning pipeline will retry.' });
  }

  // Dedup milestones within the batch: search results often report the same
  // development via two publishers (e.g. BS + TOI on the same announcement).
  const sigWords = (h: string) => new Set(String(h).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
  const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of Array.from(a)) if (b.has(w)) n++; return n; };
  const seen: Set<string>[] = [];
  const rawMilestones = Array.isArray(bf.milestones) ? bf.milestones.slice(0, 4) : [];
  const milestones = rawMilestones.filter((ms: any) => {
    const w = sigWords(ms?.headline || '');
    if (seen.some(prev => overlap(prev, w) >= 3)) return false;
    seen.push(w);
    return true;
  });
  for (const ms of milestones) {
    if (!ms?.headline) continue;
    await insertEvent(line.id, {
      date: typeof ms.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ms.date) ? ms.date : today,
      headline: String(ms.headline),
      summary: typeof ms.summary === 'string' ? ms.summary : '',
      source: typeof ms.source === 'string' ? ms.source : '',
      source_url: isWhitelistedSource(ms.source_url) ? ms.source_url : '',
      origin: 'backfill',
    });
  }
  if (typeof bf.story_so_far === 'string' && bf.story_so_far.length > 40) {
    await supabase.from('storylines')
      .update({ story_so_far: bf.story_so_far.slice(0, 1500), updated_at: new Date().toISOString() })
      .eq('id', line.id);
  }

  return res.status(200).json({ ok: true, milestones: milestones.length });
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: 'Missing OPENAI_API_KEY' });

  // Auth: user identity comes from the session token, never from the body.
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ ok: false, error: 'Missing Authorization: Bearer <session token>' });
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return res.status(401).json({ ok: false, error: 'Invalid session — please log in again.' });
  }
  const userId = userData.user.id;

  const { action, story, storylineId } = (req.body || {}) as any;

  try {
    if (action === 'create-and-follow') {
      return await actionCreateAndFollow(userId, story, res);
    }
    if (action === 'backfill') {
      if (!storylineId) return res.status(400).json({ ok: false, error: 'storylineId required' });
      return await actionBackfill(String(storylineId), res);
    }
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}. Use 'create-and-follow' or 'backfill'.` });
  } catch (e: any) {
    console.error('[storylines-api] top-level error:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
