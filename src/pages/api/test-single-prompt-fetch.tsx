// src/pages/api/test-single-prompt-fetch.tsx
//
// ONE-OFF TEST. Not part of the production pipeline.
//
// Purpose: prove out the "ChatGPT-style" single-prompt fetch.
// One API call to gpt-4o with web_search_preview. The model decides how many
// times to search. We log everything so we can calculate exact cost.
//
// How to use:
//   1. Drop into src/pages/api/
//   2. Commit + push (Vercel auto-deploys)
//   3. POST to /api/test-single-prompt-fetch with empty body
//   4. Read Vercel logs to see:
//      - How many web_search_call items the model made
//      - How many sections came back with how many stories
//      - Token counts (input / output / search content)
//      - Total cost
//   5. The full raw_stories JSON comes back in the response so you can eyeball it.
//
// What "success" looks like:
//   - All 9 standard sections present (major_events, world, india, business,
//     markets, technology, climate_health, sport, culture)
//   - 4+ stories in india/world/major_events; 2+ in others
//   - All source URLs from Tier-1 whitelisted publishers
//   - Cost under $0.50 per run
//
// If it works, we replace fetchNewsFromOpenAI in generate-brief.tsx with this
// approach. If it fails (sparse sections, fabricated URLs, etc.) we know the
// monolithic approach can't work and fall back to consolidated buckets.

import type { NextApiRequest, NextApiResponse } from 'next';

export const config = { maxDuration: 60 };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ─── Tier-1 whitelist (mirror of generate-brief.tsx for the test) ──────────

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

// ─── Date helper ────────────────────────────────────────────────────────────

function getISTDate(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split('T')[0];
}

// ─── JSON extraction ────────────────────────────────────────────────────────

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

// ─── The big prompt ─────────────────────────────────────────────────────────

function buildPrompt(today: string): string {
  return `You are the news desk for Morning Brief, a daily intelligence brief for thoughtful Indian readers. Today is ${today}. Your job: produce a comprehensive raw news dossier covering the entire day's events.

═══════════════════════════════════════════════
SEARCH STRATEGY — read this carefully
═══════════════════════════════════════════════
You have the web_search_preview tool. USE IT AGGRESSIVELY. A good fetch makes 10-15 separate searches across the day's coverage. ONE search returning a roundup page is NOT enough — that's how briefs get sparse. Plan your searches by section:

  • Run a search for major Indian news today
  • Run a search for major world/international news today
  • Run a search for Indian business and corporate news today
  • Run a search for Indian and global markets close today (Sensex, Nifty, S&P, Nasdaq)
  • Run a search for technology and AI news today
  • Run a search for climate / extreme weather / health news today
  • Run a search for today's biggest sport story (IPL especially in April-June)
  • Run a search for today's culture / entertainment story
  • Run extra searches for any developing story you need to confirm or expand

Iterate. If a search returns a roundup, follow up with searches for specific stories you saw mentioned. Aim to confirm every story from at least one Tier-1 source.

═══════════════════════════════════════════════
SECTIONS REQUIRED — output ALL of these
═══════════════════════════════════════════════
Mandatory sections (must be present even if some are empty arrays on quiet days):

  • major_events:    3-4 stories — sustained, multi-day themes shaping the week (ongoing wars, election cycles, IPL final stage, major policy rollouts). Distinct from 24-hour news.
  • world:           5-7 stories — 24-hour global news outside India, spread across regions.
  • india:           5-7 stories — 24-hour national news (government, courts, business deals, accidents, state-level developments of national significance, city developments).
  • business:        3-4 stories — corporate news, earnings, M&A, regulatory actions. Indian + global.
  • markets:         Sensex, Nifty, S&P 500, Nasdaq with today's actual closing/latest values + 2-3 sentence India-anchored summary of market direction.
  • technology:      2-3 stories — meaningful product launches, AI developments, big-tech regulation, cybersecurity.
  • climate_health:  2-3 stories — climate disasters, environmental policy, major health stories with concrete impact.
  • sport:           1-2 stories — the day's biggest sport story (IPL when relevant; cricket dominates Indian sport).
  • culture:         1-2 stories — biggest culture/entertainment story (film, arts, books, music, notable cultural moment).

═══════════════════════════════════════════════
SOURCE WHITELIST — strict
═══════════════════════════════════════════════
Cite ONLY from these publishers:
GLOBAL: Reuters, AP, Bloomberg, FT, WSJ, NYT, Washington Post, BBC, Guardian, Economist, Al Jazeera.
INDIA: The Hindu, Indian Express, Hindustan Times, NDTV, New Indian Express, The Print, Scroll, Times of India, Deccan Herald, The Wire, Mint, Business Standard, Economic Times, Financial Express, Hindu BusinessLine, Moneycontrol, Business Today.
SPECIALIST (only when general sources don't cover): ESPNCricinfo (sport), Variety / Hollywood Reporter (entertainment), Nature / Science / STAT (health/science), TechCrunch / The Verge / Ars Technica / Wired (tech).

NOT ALLOWED: aggregators (Google News, MSN, Yahoo), social media, opinion blogs, listicle sites, unfamiliar domains.

source_url must be a DIRECT ARTICLE URL on the publisher's domain. No homepage URLs. No aggregator wrappers. No redirects. If you cannot find a whitelisted article for a section, return an empty array for that section — never fabricate.

═══════════════════════════════════════════════
QUALITY RULES
═══════════════════════════════════════════════
• Recency: every story published within the last 48 hours. major_events allows up to 7 days for sustained themes.
• Order within each section by consequence — index 0 most important.
• must_include flag: set true if the story is one of the day's 5 dominant stories any responsible Indian brief would be embarrassed to omit (election result, IPL final, major ruling, market-moving event).
• No duplication: a story belongs in ONLY ONE section. Pick the section that fits best.

═══════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════
Return ONLY this JSON, no markdown, no commentary:

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

  console.log(`[test] Starting single-prompt fetch for ${today}`);

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      tools: [{ type: 'web_search_preview' }],
      tool_choice: 'auto',
      input: buildPrompt(today),
      max_output_tokens: 8000,
    }),
  });

  const data = await response.json();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`[test] OpenAI status ${response.status}. Elapsed: ${elapsed}s`);

  // ─── Count searches ─────────────────────────────────────────────────────
  const output = Array.isArray(data.output) ? data.output : [];
  const searchCalls = output.filter((o: any) => o.type === 'web_search_call');
  const messageItem = output.find((o: any) => o.type === 'message');

  console.log(`[test] Web searches performed: ${searchCalls.length}`);
  searchCalls.forEach((s: any, i: number) => {
    const action = s?.action?.query || s?.action?.type || 'unknown';
    console.log(`  search ${i + 1}: ${action}`);
  });

  // ─── Token usage ────────────────────────────────────────────────────────
  const usage = data.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  console.log(`[test] Tokens: input=${inputTokens}, output=${outputTokens}`);

  // ─── Cost calculation ───────────────────────────────────────────────────
  // gpt-4o: $2.50 / 1M input, $10 / 1M output
  // web_search_preview: $25 / 1K calls
  const inputCost = (inputTokens / 1_000_000) * 2.50;
  const outputCost = (outputTokens / 1_000_000) * 10.00;
  const searchCost = searchCalls.length * 0.025;
  const totalCost = inputCost + outputCost + searchCost;

  console.log(`[test] Cost breakdown:`);
  console.log(`  input tokens:   $${inputCost.toFixed(4)}`);
  console.log(`  output tokens:  $${outputCost.toFixed(4)}`);
  console.log(`  ${searchCalls.length} searches:    $${searchCost.toFixed(4)}`);
  console.log(`  TOTAL:          $${totalCost.toFixed(4)}`);

  // ─── Parse output JSON ──────────────────────────────────────────────────
  let parsed: any = null;
  let parseError: string | null = null;
  const text = messageItem?.content?.[0]?.text;
  if (text) {
    try {
      parsed = extractJsonObject(text);
    } catch (e: any) {
      parseError = e.message;
      console.error(`[test] JSON parse failed: ${e.message}`);
    }
  } else {
    parseError = 'No message text in response';
  }

  // ─── Section counts ─────────────────────────────────────────────────────
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

  console.log(`[test] Section counts:`, sectionCounts);
  console.log(`[test] Whitelisted stories: ${whitelistedCount}, non-whitelisted: ${nonWhitelistedCount}`);
  if (nonWhitelistedExamples.length > 0) {
    console.log(`[test] Non-whitelisted examples:`, nonWhitelistedExamples);
  }

  return res.status(200).json({
    ok: true,
    elapsed_seconds: parseFloat(elapsed),
    searches_performed: searchCalls.length,
    search_queries: searchCalls.map((s: any) => s?.action?.query || s?.action?.type || 'unknown'),
    tokens: { input: inputTokens, output: outputTokens },
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
