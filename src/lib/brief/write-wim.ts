// src/lib/brief/write-wim.ts  —  STEP 5: why-it-matters, per section, per user
//
// The ONLY per-user layer (D3 + rider A): a synthesis of how each PERSONALISED
// section served this reader — not a per-story line. Core (major/india/world)
// stays factual, so it gets no WIM. One batched call per user across all their
// personalised sections; the carried UnifiedDef.why is the fallback seed.

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

export const writeWim: StepWriteWim = async (routed: RoutedBrief, store: ArticleStore, user: UserSelections) => {
  const personalised = routed.sections.filter((s) => s.kind !== 'core' && s.eventIds.length > 0);
  if (personalised.length === 0) return routed;

  const blocks = personalised.map((sec) => {
    const heads = sec.eventIds
      .map((id) => store.byEventId[id])
      .filter(Boolean)
      .map((a) => `- ${a.headline} — ${a.facts}`)
      .join('\n');
    return `SECTION ${sec.key} ("${sec.label}"):\n${heads}`;
  }).join('\n\n');

  const prompt =
    `${REGISTER}\n\n` +
    `Reader — cities: ${user.cities.join(', ') || 'none'}; interests: ${user.interests.join(', ') || 'none'}; ` +
    `industries: ${user.industries.join(', ') || 'none'}.\n\n` +
    `Return ONLY a JSON object mapping each section key to its why-it-matters string. Keys: ` +
    `${personalised.map((s) => s.key).join(', ')}.\n\n${blocks}`;

  let wim: Record<SectionKey, string> = { ...routed.wim };
  try {
    const obj = await chatJson(prompt, { maxTokens: 1600, tag: 'write-wim' });
    for (const sec of personalised) {
      const v = obj?.[sec.key];
      wim[sec.key] = typeof v === 'string' && v.trim() ? v.trim() : seedWhy(sec.key);
    }
  } catch (e: any) {
    console.warn(`[write-wim] ${user.userId} failed (${e?.message || e}) — seed why fallback.`);
    for (const sec of personalised) wim[sec.key] = seedWhy(sec.key);
  }

  console.log(`[write-wim] ${user.userId} ${routed.edition}: ${personalised.length} personalised sections.`);
  return { ...routed, wim };
};
