// src/lib/brief/write-deep.ts  —  the deep edition (synthesis across articles)
//
// Not a story list: reads the routed Articles' facts+analysis and synthesises
// three patterns, a long read, watching-this-week, and a signature stat/quote.
// One call per user over their routed set. Degrades to a minimal deep on failure.

import type { RoutedBrief, ArticleStore, DeepContent } from './types';
import { chatJson } from './transport';

const REGISTER =
  'You are the editorial voice for urban Indian professionals — analytical, FT/Economist, connects dots across stories. ' +
  'British-Indian spelling. No hype, no emoji.';

export async function writeDeep(routed: RoutedBrief, store: ArticleStore): Promise<DeepContent> {
  const articles = routed.sections
    .flatMap((s) => s.eventIds).map((id) => store.byEventId[id]).filter(Boolean);
  const material = articles
    .map((a, i) => `[${i}] ${a.headline} — ${a.facts} ${a.analysis || ''}`.trim())
    .join('\n');

  const prompt =
    `${REGISTER}\n\n` +
    `From the stories below, produce a weekly-editorial synthesis. Return ONLY JSON (no prose/markdown) with EXACTLY:\n` +
    `  three_patterns: array of EXACTLY 3 { title, body (2–4 sentences connecting several stories), stories_connected (array of headlines) }\n` +
    `  long_read: { title, body (4–6 sentences on the most important throughline) }\n` +
    `  watching_this_week: array of 3 { title, body (1–2 sentences) }\n` +
    `  signature: { one_number: { value, context }, one_quote: { quote, attribution, context } | null }\n\n` +
    `Do not invent facts beyond the stories.\n\n${material}`;

  try {
    const o = await chatJson(prompt, { maxTokens: 2800, tag: 'write-deep' });
    return normalise(o, articles);
  } catch (e: any) {
    console.warn(`[write-deep] ${routed.userId} failed (${e?.message || e}) — minimal deep.`);
    return minimal(articles);
  }
}

const str = (v: any, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);

function normalise(o: any, articles: any[]): DeepContent {
  const patterns = Array.isArray(o?.three_patterns) ? o.three_patterns : [];
  const watch = Array.isArray(o?.watching_this_week) ? o.watching_this_week : [];
  return {
    three_patterns: patterns.slice(0, 3).map((p: any) => ({
      title: str(p?.title, 'Pattern'), body: str(p?.body),
      stories_connected: Array.isArray(p?.stories_connected) ? p.stories_connected.map((x: any) => String(x)) : [],
    })),
    long_read: { title: str(o?.long_read?.title, 'The week'), body: str(o?.long_read?.body) },
    watching_this_week: watch.slice(0, 3).map((w: any) => ({ title: str(w?.title, 'Watch'), body: str(w?.body) })),
    signature: {
      one_number: { value: str(o?.signature?.one_number?.value), context: str(o?.signature?.one_number?.context) },
      one_quote: o?.signature?.one_quote?.quote
        ? { quote: str(o.signature.one_quote.quote), attribution: str(o.signature.one_quote.attribution), context: str(o.signature.one_quote.context) }
        : null,
    },
  };
}

function minimal(articles: any[]): DeepContent {
  return {
    three_patterns: [],
    long_read: { title: 'Today in brief', body: articles.slice(0, 3).map((a) => a.headline).join('; ') },
    watching_this_week: [],
    signature: { one_number: { value: '', context: '' }, one_quote: null },
  };
}
