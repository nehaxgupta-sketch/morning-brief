// test-gpt5-local.mjs
//
// Run from your terminal, not Vercel. No timeout limit, so we see what
// gpt-5 with high reasoning effort actually does.
//
// HOW TO RUN (PowerShell, from your morning-brief folder):
//
//   $env:OPENAI_API_KEY = "sk-..."   # paste your real key (one-time per shell)
//   node test-gpt5-local.mjs
//
// Your OPENAI_API_KEY is in your .env.local file — open that, copy the value.
//
// Expect this to take 60-180 seconds. Be patient. It'll print progress.

import fs from 'node:fs';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  // Try to read from .env.local automatically
  try {
    const envFile = fs.readFileSync('.env.local', 'utf8');
    const match = envFile.match(/OPENAI_API_KEY\s*=\s*["']?([^"'\n]+)["']?/);
    if (match) {
      process.env.OPENAI_API_KEY = match[1].trim();
      console.log('✓ Read OPENAI_API_KEY from .env.local');
    }
  } catch {
    // No .env.local
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set. Run:');
  console.error('   $env:OPENAI_API_KEY = "sk-..."');
  console.error('   node test-gpt5-local.mjs');
  process.exit(1);
}

// ─── Tier-1 whitelist ──────────────────────────────────────────────────────

const TIER_1_DOMAINS = new Set([
  'reuters.com','apnews.com','bloomberg.com','ft.com','wsj.com',
  'nytimes.com','washingtonpost.com','bbc.com','bbc.co.uk',
  'economist.com','theguardian.com','aljazeera.com',
  'thehindu.com','thehindubusinessline.com','indianexpress.com',
  'newindianexpress.com','hindustantimes.com','livemint.com',
  'business-standard.com','economictimes.indiatimes.com',
  'financialexpress.com','theprint.in','scroll.in',
  'timesofindia.indiatimes.com','ndtv.com','deccanherald.com',
  'thewire.in','moneycontrol.com','businesstoday.in',
  'espncricinfo.com','variety.com','hollywoodreporter.com',
  'nature.com','science.org','statnews.com',
  'techcrunch.com','theverge.com','arstechnica.com','wired.com',
]);

function isWhitelisted(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const allowed of TIER_1_DOMAINS) {
      if (host === allowed || host.endsWith('.' + allowed)) return true;
    }
    return false;
  } catch { return false; }
}

function getISTDate() {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split('T')[0];
}

function extractJsonObject(text) {
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

const today = getISTDate();

const prompt = `You are the news desk for Morning Brief, a daily intelligence brief for thoughtful Indian readers. Today is ${today}. Your job: produce a comprehensive raw news dossier covering the entire day's events.

You are a reasoning model with access to the web_search tool. Use it aggressively and iteratively. A complete dossier requires 10-15 separate searches. For each section, plan searches, run them, evaluate gaps, run follow-up searches. Do not stop until every required section has the target story count from Tier-1 sources.

SEARCH PLAN — run AT LEAST these searches plus follow-ups:
  1. Top India news today (politics, government, courts, business)
  2. Major Indian business / corporate news today
  3. Indian market close today — Sensex, Nifty values and drivers
  4. Top world news today (geopolitics, government, conflicts)
  5. US / Europe / China major news today
  6. Technology and AI news today (product launches, regulation)
  7. Climate / extreme weather / environment news today
  8. Major health story today
  9. Today's biggest sport story (IPL when April-June)
  10. Today's culture / entertainment story
  11-15. Follow-ups: confirm developing stories, find Indian angles, fill gaps

SECTIONS (every one must be present):
  • major_events:    3-4 stories — sustained multi-day themes
  • world:           5-7 stories — 24-hr global news outside India
  • india:           5-7 stories — 24-hr national news
  • business:        3-4 stories — corporate, earnings, M&A, regulatory
  • markets:         Sensex, Nifty, S&P 500, Nasdaq + 2-3 sentence India-anchored summary
  • technology:      2-3 stories
  • climate_health:  2-3 stories
  • sport:           1-2 stories
  • culture:         1-2 stories

SOURCE WHITELIST — cite ONLY from:
GLOBAL: Reuters, AP, Bloomberg, FT, WSJ, NYT, Washington Post, BBC, Guardian, Economist, Al Jazeera.
INDIA: The Hindu, Indian Express, Hindustan Times, NDTV, New Indian Express, The Print, Scroll, Times of India, Deccan Herald, The Wire, Mint, Business Standard, Economic Times, Financial Express, Hindu BusinessLine, Moneycontrol, Business Today.
SPECIALIST (only when general sources don't cover): ESPNCricinfo (sport), Variety / Hollywood Reporter (entertainment), Nature / Science / STAT (health/science), TechCrunch / The Verge / Ars Technica / Wired (tech).

NOT ALLOWED: aggregators, social media, opinion blogs, WMO/WHO/UN press releases, regional papers, US-local papers, generic .com domains.

source_url MUST be a direct article URL. No homepages. No /economy or /news section pages. NEVER fabricate.

QUALITY: recency 48hrs (major_events up to 7 days). Order by consequence. No duplication across sections. must_include: true on day's 5 dominant stories.

OUTPUT — return ONLY this JSON, no markdown:
{
  "major_events": [ { "headline": "...", "body": "2-3 factual sentences", "source": "Publisher Name", "source_url": "https://...", "published_at": "YYYY-MM-DD", "must_include": false } ],
  "world": [],
  "india": [],
  "business": [],
  "markets": { "summary": "...", "indices": [ { "name": "Sensex", "change": "+0.4%" }, { "name": "Nifty", "change": "-0.1%" }, { "name": "S&P 500", "change": "+0.6%" }, { "name": "Nasdaq", "change": "+1.1%" } ] },
  "technology": [],
  "climate_health": [],
  "sport": [],
  "culture": []
}`;

console.log(`\n🚀 Calling gpt-5 with reasoning effort 'high' for ${today}`);
console.log(`   This will take 60-180 seconds. Be patient...\n`);

const startTime = Date.now();

const response = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'gpt-5',
    tools: [{ type: 'web_search' }],
    tool_choice: 'auto',
    reasoning: { effort: 'high' },
    input: prompt,
    max_output_tokens: 16000,
  }),
});

const data = await response.json();
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

console.log(`✓ Response received in ${elapsed}s. Status: ${response.status}\n`);

if (!response.ok || data.error) {
  console.error('❌ API error:');
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}

const output = Array.isArray(data.output) ? data.output : [];
const searchCalls = output.filter(o => o.type === 'web_search_call');
const reasoningItems = output.filter(o => o.type === 'reasoning');
const messageItem = output.find(o => o.type === 'message');

console.log(`📊 OUTPUT BREAKDOWN`);
console.log(`   Total output items: ${output.length}`);
console.log(`   Web searches:       ${searchCalls.length}`);
console.log(`   Reasoning items:    ${reasoningItems.length}\n`);

console.log(`🔍 SEARCH QUERIES`);
searchCalls.forEach((s, i) => {
  const q = s?.action?.query || s?.action?.type || 'unknown';
  console.log(`   ${i + 1}. ${q}`);
});

const usage = data.usage || {};
const inputTokens = usage.input_tokens || 0;
const outputTokens = usage.output_tokens || 0;
const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;

console.log(`\n💰 COST`);
const inputCost = (inputTokens / 1_000_000) * 1.25;
const outputCost = (outputTokens / 1_000_000) * 10.00;
const searchCost = searchCalls.length * 0.010;
const totalCost = inputCost + outputCost + searchCost;
console.log(`   Input  ${inputTokens} tok = $${inputCost.toFixed(4)}`);
console.log(`   Output ${outputTokens} tok (reasoning=${reasoningTokens}) = $${outputCost.toFixed(4)}`);
console.log(`   ${searchCalls.length} searches × $0.01 = $${searchCost.toFixed(4)}`);
console.log(`   TOTAL: $${totalCost.toFixed(4)}\n`);

// Parse JSON output
let parsed = null;
const text = messageItem?.content?.find(c => c.type === 'output_text')?.text
          || messageItem?.content?.[0]?.text;
if (text) {
  try { parsed = extractJsonObject(text); }
  catch (e) { console.error(`❌ JSON parse failed: ${e.message}`); }
}

if (parsed) {
  console.log(`📰 SECTION COUNTS`);
  let whitelisted = 0, nonWhitelisted = 0;
  const nonWhitelistedExamples = [];

  for (const key of ['major_events','world','india','business','technology','climate_health','sport','culture']) {
    const arr = parsed[key] || [];
    console.log(`   ${key.padEnd(18)} ${arr.length} stories`);
    for (const story of arr) {
      if (isWhitelisted(story?.source_url)) whitelisted++;
      else {
        nonWhitelisted++;
        if (nonWhitelistedExamples.length < 5) {
          nonWhitelistedExamples.push({ section: key, url: story?.source_url, headline: (story?.headline||'').slice(0,70) });
        }
      }
    }
  }
  console.log(`   markets_indices    ${(parsed.markets?.indices || []).length}`);

  console.log(`\n✅ WHITELIST CHECK`);
  console.log(`   Whitelisted:     ${whitelisted}`);
  console.log(`   Non-whitelisted: ${nonWhitelisted}`);
  if (nonWhitelistedExamples.length) {
    console.log(`   Examples of non-whitelisted:`);
    nonWhitelistedExamples.forEach(e => {
      console.log(`     [${e.section}] ${e.headline}`);
      console.log(`        ${e.url}`);
    });
  }

  // Save full output for review
  fs.writeFileSync('test-gpt5-output.json', JSON.stringify(parsed, null, 2));
  console.log(`\n💾 Full output saved to test-gpt5-output.json`);
}
