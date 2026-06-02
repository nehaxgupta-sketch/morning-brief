// src/pages/api/test-gpt5-fetch.tsx
//
// PATH B TEST. Single big prompt, but with gpt-5 + the proper reasoning
// web_search tool (NOT web_search_preview). The bet: gpt-5's reasoning lets
// it actually iterate searches the way ChatGPT does, instead of giving up
// after one search like gpt-4o did.
//
// Differences from test-single-prompt-fetch.tsx:
//   - model: 'gpt-5' instead of 'gpt-4o'
//   - tool:  'web_search' (reasoning) instead of 'web_search_preview'
//   - reasoning.effort: 'medium' (high might exceed Vercel's 60s limit)
//   - pricing math updated: gpt-5 is $1.25/M in, $10/M out; web_search
//     reasoning tool is $10/1K calls (cheaper than preview's $25/1K)
//   - reasoning tokens are billed as output — we capture that separately
//
// Same standalone-endpoint pattern. Drop into src/pages/api/, commit, push,
// hit with curl or browser console, read the result.
//
// Hit via PowerShell:
//   Invoke-RestMethod -Uri "https://morning-brief-liart.vercel.app/api/test-gpt5-fetch" -Method POST | ConvertTo-Json -Depth 10
//
// IMPORTANT: gpt-5 with reasoning is SLOW. Expect 30-60 seconds. If it
// times out at 60s, try changing reasoning.effort below from 'medium' to
// 'low' or even 'minimal'. We can also try 'high' once we know it fits.

import type { NextApiRequest, NextApiResponse } from 'next';

export const config = { maxDuration: 60 };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ─── Tier-1 whitelist (mirror of generate-brief.tsx) ───────────────────────

const TIER_1_DOMAINS = new Set<string>([
  'reuters.com', 'apnews.com', 'bloomberg.com', 'ft.com', 'wsj.com',
  'nytimes.com', 'washingtonpost.com', 'bbc.com', 'bbc.co.uk',
  'economist.com', 'theguardian.com', 'aljazeera.com',
  'thehindu.com', 'thehindubusinessline.com', 'indianexpress.com',
  'newindianexpress.com', 'hindustantimes.com', 'livemint.com',
  'business-standard.com', 'economictimes.indiatimes.com',
  'financialexpress.com', 'theprint.in', 'scroll.in',
  'timesofindia.indiatimes.com', 'ndtv.com', 'deccanherald.com',
  'thewire.in', 'moneycontrol.com', 'businesstoday.in',
  'espncricinfo.com', 'variety.com', 'hollywoodreporter.com',
  'nature.com', 'science.org', 'statnews.com',
  'techcrunch.com', 'theverge.com', 'arstechnica.com', 'wired.com',
]);

function isWhitelisted(url: string | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const allowed of Array.from(TIER_1_DOMAINS)) {
      if (host === allowed || host.endsWith('.' + allowed)) return true;
    }
    return false;
  } catch { return false; }
}

function getISTDate(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split('T')[0];
}

function extractJsonObject(text: string): any {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found');
  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('JSON truncated');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ─── Prompt — same as Path A test, refined slightly for reasoning model ────

function buildPrompt(today: string): string {
  return `You are the news desk for Morning Brief, a daily intelligence brief for thoughtful Indian readers. Today is ${today}. Your job: produce a comprehensive raw news dossier covering the entire day's events.

You are a reasoning model with access to the web_search tool. Use it aggressively and iteratively. A complete dossier requires 10-15 separate searches. For each section, plan searches, run them, evaluate gaps, run follow-up searches. Do not stop until every required section has the target story count from Tier-1 sources.

═══════════════════════════════════════════════
SEARCH PLAN
═══════════════════════════════════════════════
Run AT LEAST these searches, plus follow-ups as needed:
  1. Top India news today (politics, government, courts, business)
  2. Major Indian business / corporate news today
  3. Indian market close today — Sensex, Nifty values and drivers
  4. Top world news today (geopolitics, government, conflicts)
  5. US / Europe / China major news today
  6. Technology and AI news today (product launches, regulation)
  7. Climate / extreme weather / environment news today
  8. Major health story today (outbreaks, drug approvals, research)
  9. Today's biggest sport story (IPL when April-June; cricket dominates Indian sport)
  10. Today's culture / entertainment story (film, arts, books, music)
  11-15. Follow-ups: confirm developing stories, find Indian angles on global stories, fill gaps in any thin section

═══════════════════════════════════════════════
SECTIONS REQUIRED (mandatory — every one must be present)
═══════════════════════════════════════════════
  • major_events:    3-4 stories — sustained, multi-day themes shaping the week (ongoing wars, election cycles, major policy rollouts, finals-stage tournaments). Distinct from 24-hour news.
  • world:           5-7 stories — 24-hour global news outside India, spread across regions.
  • india:           5-7 stories — 24-hour national news (government, courts, business deals, state developments, city news of national significance).
  • business:        3-4 stories — corporate news, earnings, M&A, regulatory actions. Indian + global.
  • markets:         Sensex, Nifty, S&P 500, Nasdaq with actual closing values + 2-3 sentence India-anchored summary.
  • technology:      2-3 stories — meaningful product launches, AI developments, big-tech regulation, cybersecurity.
  • climate_health:  2-3 stories — climate disasters, environmental policy, major health stories with concrete impact.
  • sport:           1-2 stories — the day's biggest sport story.
  • culture:         1-2 stories — biggest culture/entertainment story.

═══════════════════════════════════════════════
SOURCE WHITELIST — strict
═══════════════════════════════════════════════
Cite ONLY from these publishers:
GLOBAL: Reuters, AP, Bloomberg, FT, WSJ, NYT, Washington Post, BBC, Guardian, Economist, Al Jazeera.
INDIA: The Hindu, Indian Express, Hindustan Times, NDTV, New Indian Express, The Print, Scroll, Times of India, Deccan Herald, The Wire, Mint, Business Standard, Economic Times, Financial Express, Hindu BusinessLine, Moneycontrol, Business Today.
SPECIALIST (only when general sources don't cover): ESPNCricinfo (sport), Variety / Hollywood Reporter (entertainment), Nature / Science / STAT (health/science), TechCrunch / The Verge / Ars Technica / Wired (tech).

NOT ALLOWED: aggregators (Google News, MSN, Yahoo), social media, opinion blogs, listicle sites, generic .com domains you don't recognise as a tier-1 publisher. Also NOT ALLOWED: WMO, WHO, UN, government press releases, NGO sites, regional papers outside the list above, Cleveland-anything or other US-local papers, tech blogs not on the list.

source_url MUST be a direct article URL on the publisher's domain. No homepage URLs (e.g. business-standard.com/economy is FORBIDDEN — needs /article/specific-headline). No aggregator wrappers. No redirects.

If you cannot find a whitelisted article for a section after 2 searches, search a DIFFERENT angle of the same topic before giving up. Only return an empty array if multiple search angles all fail. NEVER fabricate.

═══════════════════════════════════════════════
QUALITY RULES
═══════════════════════════════════════════════
• Recency: every story published within the last 48 hours. major_events allows up to 7 days for sustained themes.
• Order within each section by consequence — index 0 most important.
• must_include flag: set true if the story is one of the day's 5 dominant stories any responsible Indian brief would be embarrassed to omit.
• No duplication: a story belongs in ONLY ONE section. Pick the best-fitting section.

═══════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════
Return ONLY this JSON, no markdown:

{
  "major_events": [ { "headline": "...", "body": "2-3 factual sentences", "source": "Publisher Name", "source_url": "https://...", "published_at": "YYYY-MM-DD", "must_include": false } ],
  "world": [ /* same shape */ ],
  "india": [ /* same shape */ ],
  "business": [ /* same shape */ ],
  "markets": {
    "summary": "2-3 sentence India-anchored take on today's market direction and drivers",
    "indices": [
      { "name": "Sensex", "change": "+0.4%" },
      { "name": "Nifty", "change": "-0.1%" },
      { "name": "S&P 500", "change": "+0.6%" },
      { "name": "Nasdaq", "change": "+1.1%" }
    ]
  },
  "technology": [ /* same shape */ ],
  "climate_health": [ /* same shape */ ],
  "sport": [ /* same shape, 1-2 entries */ ],
  "culture": [ /* same shape, 1-2 entries */ ]
}`;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const today = getISTDate();
  const startTime = Date.now();

  console.log(`[test-gpt5] Starting reasoning fetch for ${today}`);

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5',
      tools: [{ type: 'web_search' }],   // NOT web_search_preview — reasoning version
      tool_choice: 'auto',
      reasoning: { effort: 'medium' },   // medium is the sweet spot for 60s limit
      input: buildPrompt(today),
      max_output_tokens: 12000,          // higher because reasoning + output both count
    }),
  });

  const data = await response.json();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`[test-gpt5] OpenAI status ${response.status}. Elapsed: ${elapsed}s`);

  // If the request failed at the API level, return the raw error so we can see it.
  if (!response.ok || data.error) {
    console.error('[test-gpt5] API error:', JSON.stringify(data).slice(0, 1000));
    return res.status(response.status || 500).json({
      ok: false,
      elapsed_seconds: parseFloat(elapsed),
      api_error: data.error || data,
    });
  }

  // ─── Inspect the output items ──────────────────────────────────────────
  const output = Array.isArray(data.output) ? data.output : [];
  const searchCalls = output.filter((o: any) => o.type === 'web_search_call');
  const reasoningItems = output.filter((o: any) => o.type === 'reasoning');
  const messageItem = output.find((o: any) => o.type === 'message');

  console.log(`[test-gpt5] Output items: ${output.length} total`);
  console.log(`[test-gpt5] Web searches: ${searchCalls.length}`);
  console.log(`[test-gpt5] Reasoning items: ${reasoningItems.length}`);

  searchCalls.forEach((s: any, i: number) => {
    const action = s?.action?.query || s?.action?.type || 'unknown';
    console.log(`  search ${i + 1}: ${action}`);
  });

  // ─── Token usage ────────────────────────────────────────────────────────
  const usage = data.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
  const visibleOutputTokens = outputTokens - reasoningTokens;

  console.log(`[test-gpt5] Tokens: input=${inputTokens}, output=${outputTokens} (reasoning=${reasoningTokens}, visible=${visibleOutputTokens})`);

  // ─── Cost calculation ───────────────────────────────────────────────────
  // gpt-5: $1.25/M input, $10/M output (reasoning tokens count as output)
  // web_search (reasoning): $10/1K calls
  const inputCost = (inputTokens / 1_000_000) * 1.25;
  const outputCost = (outputTokens / 1_000_000) * 10.00;
  const searchCost = searchCalls.length * 0.010;
  const totalCost = inputCost + outputCost + searchCost;

  console.log(`[test-gpt5] Cost:`);
  console.log(`  input tokens:   $${inputCost.toFixed(4)}`);
  console.log(`  output tokens:  $${outputCost.toFixed(4)} (incl ${reasoningTokens} reasoning tokens = $${((reasoningTokens / 1_000_000) * 10).toFixed(4)})`);
  console.log(`  ${searchCalls.length} searches:    $${searchCost.toFixed(4)}`);
  console.log(`  TOTAL:          $${totalCost.toFixed(4)}`);

  // ─── Parse output JSON ──────────────────────────────────────────────────
  let parsed: any = null;
  let parseError: string | null = null;
  const text = messageItem?.content?.find((c: any) => c.type === 'output_text')?.text
            || messageItem?.content?.[0]?.text;
  if (text) {
    try { parsed = extractJsonObject(text); }
    catch (e: any) { parseError = e.message; console.error(`[test-gpt5] JSON parse failed: ${e.message}`); }
  } else {
    parseError = 'No message text in response';
  }

  // ─── Section counts + whitelist check ───────────────────────────────────
  const sectionCounts: Record<string, number> = {};
  let whitelistedCount = 0;
  let nonWhitelistedCount = 0;
  const nonWhitelistedExamples: { section: string; url: string; headline: string }[] = [];

  if (parsed) {
    for (const key of ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture']) {
      const arr = parsed[key];
      if (Array.isArray(arr)) {
        sectionCounts[key] = arr.length;
        for (const story of arr) {
          if (isWhitelisted(story?.source_url)) {
            whitelistedCount++;
          } else {
            nonWhitelistedCount++;
            if (nonWhitelistedExamples.length < 5) {
              nonWhitelistedExamples.push({
                section: key,
                url: story?.source_url || '(no url)',
                headline: (story?.headline || '').slice(0, 80),
              });
            }
          }
        }
      } else {
        sectionCounts[key] = 0;
      }
    }
    sectionCounts['markets_indices'] = Array.isArray(parsed.markets?.indices) ? parsed.markets.indices.length : 0;
  }

  console.log(`[test-gpt5] Section counts:`, sectionCounts);
  console.log(`[test-gpt5] Whitelisted: ${whitelistedCount}, non-whitelisted: ${nonWhitelistedCount}`);

  return res.status(200).json({
    ok: true,
    model: 'gpt-5',
    reasoning_effort: 'medium',
    elapsed_seconds: parseFloat(elapsed),
    searches_performed: searchCalls.length,
    search_queries: searchCalls.map((s: any) => s?.action?.query || s?.action?.type || 'unknown'),
    reasoning_steps: reasoningItems.length,
    tokens: {
      input: inputTokens,
      output_total: outputTokens,
      output_reasoning: reasoningTokens,
      output_visible: visibleOutputTokens,
    },
    cost: {
      input: parseFloat(inputCost.toFixed(4)),
      output: parseFloat(outputCost.toFixed(4)),
      searches: parseFloat(searchCost.toFixed(4)),
      total: parseFloat(totalCost.toFixed(4)),
    },
    parse_error: parseError,
    section_counts: sectionCounts,
    whitelist_check: {
      whitelisted: whitelistedCount,
      non_whitelisted: nonWhitelistedCount,
      non_whitelisted_examples: nonWhitelistedExamples,
    },
    raw_stories: parsed,
  });
}
