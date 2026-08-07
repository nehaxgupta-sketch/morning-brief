// src/lib/brief/write-facts.ts  —  STEP 4: facts once, full depth, used union only
//
// Writes each PLACED event once, user- and section-agnostic (D3). No
// why_it_matters — that's per-user (step 5). Editions are depth-views of this
// one Article: `hook` is the 5-min line; facts/background/what_happens_next/
// analysis are the 10-min body; deep synthesises across Articles separately.
//
// Batched (chunks of 8) to keep call count down. Per Ledger D16, a failed chunk
// degrades to raw-body fallbacks for those stories — it never fails the run.
//
// ── Sprint 29.1 fix (100% raw-body fallback) ─────────────────────────────────
// The prior version asked for a top-level JSON array and transport parsed with an
// OBJECT extractor, so the array was dropped, `list` was [], every story fell
// back — and NOTHING logged (the parse didn't throw). Three changes here:
//   1) Ask for an OBJECT `{"stories":[…]}` — the single most robust shape across
//      every parser path (transport is now array-OR-object tolerant regardless).
//   2) Accept array | {stories|items|articles|data}, and match by `i` OR by
//      position (models sometimes drop/renumber `i`).
//   3) When a 200 yields 0 parsed for a chunk, LOG the shape (ledger #19) — never
//      fall back silently again.

import type { DedupedPool, DedupedStory, Article, ArticleStore, StepWriteFacts } from './types';
import { chatJson } from './transport';

const CHUNK = parseInt(process.env.BRIEF_WRITE_CHUNK || '8', 10);
const SEARCH = (process.env.BRIEF_WRITER_SEARCH || 'off').toLowerCase() === 'on';

const REGISTER =
  'You write for urban Indian professionals. Register: calm, analytical, FT/Economist — never breathless. ' +
  'Anchor significance to the Indian household/professional where relevant. British-Indian spelling. No hype, no emoji.';

function buildPrompt(stories: DedupedStory[]): string {
  const items = stories.map((s, i) =>
    `--- STORY ${i} ---\nHEADLINE: ${s.headline}\nSOURCE: ${s.source}\nBODY: ${(s.body || '').slice(0, 1200)}`,
  ).join('\n\n');
  return (
    `${REGISTER}\n\n` +
    `For each story below, write a factual, non-personalised treatment. Return ONLY a JSON object ` +
    `(no prose, no markdown) of the exact form {"stories": [ ... ]}, where each element of "stories" ` +
    `is an object with EXACTLY these keys:\n` +
    `  i                 (the story number, matching the STORY n label)\n` +
    `  headline          (clean, ≤ 110 chars)\n` +
    `  hook              (one sentence, ≤ 160 chars — the single most important thing; used in the 5-min edition)\n` +
    `  facts             (2–4 sentences: what happened, concrete)\n` +
    `  background        (1–3 sentences of context)\n` +
    `  what_happens_next (1–2 sentences)\n` +
    `  analysis          (1–3 sentences: the general significance — NOT addressed to any specific reader)\n\n` +
    `Return one element per story, in order. Do not invent facts beyond the body; if the body is thin, ` +
    `keep fields short and factual.\n\n${items}`
  );
}

function fallback(s: DedupedStory): Article {
  const body = (s.body || s.headline).trim();
  return {
    eventId: s.eventId, headline: s.headline, hook: body.split(/(?<=[.!?])\s/)[0].slice(0, 160),
    facts: body.slice(0, 400), background: '', what_happens_next: '', analysis: '',
    source: s.source, source_url: s.source_url,
    candidateSections: s.candidateSections, geo: s.geo,
    interests: s.interests, industries: s.industries, city_tags: s.city_tags, topic_tags: s.topic_tags,
    nw: s.nw, eventCorr: s.eventCorr, must_include: s.must_include,
  };
}

function toArticle(s: DedupedStory, w: any): Article {
  const str = (v: any, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
  return {
    eventId: s.eventId,
    headline: str(w.headline, s.headline),
    hook: str(w.hook, (s.body || s.headline).slice(0, 160)),
    facts: str(w.facts, (s.body || '').slice(0, 400)),
    background: str(w.background), what_happens_next: str(w.what_happens_next), analysis: str(w.analysis),
    source: s.source, source_url: s.source_url,
    candidateSections: s.candidateSections, geo: s.geo,
    interests: s.interests, industries: s.industries, city_tags: s.city_tags, topic_tags: s.topic_tags,
    nw: s.nw, eventCorr: s.eventCorr, must_include: s.must_include,
  };
}

// Coerce whatever transport returned into a list of per-story objects.
function toList(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    return parsed.stories || parsed.items || parsed.articles || parsed.data || [];
  }
  return [];
}

export const writeFacts: StepWriteFacts = async (pool: DedupedPool, usedEventIds) => {
  const used = new Set(usedEventIds);
  const stories = pool.stories.filter((s) => used.has(s.eventId));
  const byEventId: Record<number, Article> = {};
  let written = 0, failed = 0;

  for (let i = 0; i < stories.length; i += CHUNK) {
    const idx = i / CHUNK;
    const chunk = stories.slice(i, i + CHUNK);
    try {
      const parsed = await chatJson(buildPrompt(chunk), { maxTokens: 3200, tag: 'write-facts', search: SEARCH });
      const list = toList(parsed);
      // Index by `i` where present, else fall back to array position.
      const byIdx = new Map<number, any>();
      list.forEach((w: any, k: number) => {
        const n = Number(w?.i);
        byIdx.set(Number.isFinite(n) ? n : k, w);
      });
      let chunkWritten = 0;
      chunk.forEach((s, j) => {
        const w = byIdx.get(j) ?? list[j];
        if (w && typeof w === 'object') { byEventId[s.eventId] = toArticle(s, w); written++; chunkWritten++; }
        else { byEventId[s.eventId] = fallback(s); failed++; }
      });
      if (chunkWritten === 0) {
        const shape = Array.isArray(parsed) ? `array(${list.length})` : `object keys=[${parsed && typeof parsed === 'object' ? Object.keys(parsed).join(',') : typeof parsed}]`;
        console.warn(`[write-facts] chunk ${idx}: 200 but parsed 0/${chunk.length} — SHAPE MISMATCH (${shape}). head=${JSON.stringify(parsed).slice(0, 220)}`);
      } else if (chunkWritten < chunk.length) {
        console.warn(`[write-facts] chunk ${idx}: matched ${chunkWritten}/${chunk.length} (model returned ${list.length} item(s)) — rest fell back.`);
      } else {
        console.log(`[write-facts] chunk ${idx}: wrote ${chunkWritten}/${chunk.length}.`);
      }
    } catch (e: any) {
      console.warn(`[write-facts] chunk ${idx} threw (${e?.message || e}) — raw-body fallback for ${chunk.length}.`);
      for (const s of chunk) { byEventId[s.eventId] = fallback(s); failed++; }
    }
  }

  console.log(`[write-facts] ${stories.length} used events → written ${written}, fallback ${failed}.`);
  return { date: pool.date, byEventId, markets: pool.markets };
};
