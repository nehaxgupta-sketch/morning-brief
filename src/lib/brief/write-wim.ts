// src/lib/brief/write-wim.ts  —  STEP 5: why-it-matters, per section, per user
//
// The ONLY per-user layer (D3 + rider A): a synthesis of how each PERSONALISED
// section served this reader — not a per-story line. Core (major/india/world)
// stays factual, so it gets no WIM. One batched call per user across all their
// personalised sections; the carried UnifiedDef.why is the fallback seed.
//
// ── Sprint 29.2 hardening (silent seed fallback) ─────────────────────────────
// The prior version asked the model to return a JSON object keyed by the exact
// section key ('city:bangalore', 'Markets & Investing'). LLMs don't reliably
// echo keys with colons/spaces/'&', so a mismatch silently fell every section
// back to its static seed with NO log — indistinguishable from a working run.
// Fixes: (1) key each section by an INDEX and ask for {"sections":[{i, why}]},
// so the model never has to reproduce a fiddly key; match by i OR position.
// (2) LOG a shape-mismatch when a 200 yields 0 usable why-strings (ledger #19),
// so a seed fallback is visible. The transport parse is now array-or-object
// tolerant too, so a stray top-level array no longer wipes the WIM.

import type { RoutedBrief, ArticleStore, UserSelections, SectionKey, StepWriteWim } from './types';
import { chatJson } from './transport';
import { interestDef, industryDef } from './config';

const REGISTER =
  'You write for one urban Indian professional. Warm but concise, analytical, FT/Economist. ' +
  'Explain why the section as a whole matters to THIS reader today — connect the stories, do not summarise them one by one. ' +
  '2–3 sentences per section. British-Indian spelling. No hype, no emoji.';

function seedWhy(key: SectionKey): string {
  const i = interestDef(key); if (i?.why) return i.why;
  if (key.startsWith('prof:')) { const p = industryDef(key.slice(5)); if (p?.why) return p.why; }
  return '';
}

// Coerce whatever transport returned into a list of per-section objects.
function toList(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return parsed.sections || parsed.items || parsed.data || [];
  return [];
}

export const writeWim: StepWriteWim = async (routed: RoutedBrief, store: ArticleStore, user: UserSelections) => {
  const personalised = routed.sections.filter((s) => s.kind !== 'core' && s.eventIds.length > 0);
  if (personalised.length === 0) return routed;

  const blocks = personalised.map((sec, i) => {
    const heads = sec.eventIds
      .map((id) => store.byEventId[id])
      .filter(Boolean)
      .map((a) => `- ${a.headline} — ${a.facts}`)
      .join('\n');
    return `SECTION ${i} ("${sec.label}"):\n${heads}`;
  }).join('\n\n');

  const prompt =
    `${REGISTER}\n\n` +
    `Reader — cities: ${user.cities.join(', ') || 'none'}; interests: ${user.interests.join(', ') || 'none'}; ` +
    `industries: ${user.industries.join(', ') || 'none'}.\n\n` +
    `For each SECTION below, write its why-it-matters. Return ONLY a JSON object (no prose, no markdown) of the ` +
    `form {"sections": [ {"i": <the section number>, "why": "<2–3 sentences>"} ]}, one element per section, in order.\n\n` +
    `${blocks}`;

  const wim: Record<SectionKey, string> = { ...routed.wim };
  try {
    const parsed = await chatJson(prompt, { maxTokens: 1600, tag: 'write-wim' });
    const list = toList(parsed);
    const byIdx = new Map<number, any>();
    list.forEach((w: any, k: number) => {
      const n = Number(w?.i);
      byIdx.set(Number.isFinite(n) ? n : k, w);
    });
    let matched = 0;
    personalised.forEach((sec, i) => {
      const w = byIdx.get(i) ?? list[i];
      const why = w && typeof w.why === 'string' && w.why.trim() ? w.why.trim() : '';
      if (why) { wim[sec.key] = why; matched++; }
      else wim[sec.key] = seedWhy(sec.key);
    });
    if (matched === 0) {
      const shape = Array.isArray(parsed) ? `array(${list.length})` : `object keys=[${parsed && typeof parsed === 'object' ? Object.keys(parsed).join(',') : typeof parsed}]`;
      console.warn(`[write-wim] ${user.userId}: 200 but 0/${personalised.length} why-strings parsed — SHAPE MISMATCH (${shape}), seed fallback. head=${JSON.stringify(parsed).slice(0, 220)}`);
    } else if (matched < personalised.length) {
      console.warn(`[write-wim] ${user.userId}: ${matched}/${personalised.length} sections got model WIM; rest seeded.`);
    }
  } catch (e: any) {
    console.warn(`[write-wim] ${user.userId} threw (${e?.message || e}) — seed why fallback for ${personalised.length}.`);
    for (const sec of personalised) wim[sec.key] = seedWhy(sec.key);
  }

  console.log(`[write-wim] ${user.userId} ${routed.edition}: ${personalised.length} personalised sections.`);
  return { ...routed, wim };
};
