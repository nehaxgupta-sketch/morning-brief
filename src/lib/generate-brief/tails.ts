// src/lib/generate-brief/tails.ts
//
// Modularization stage 7 - per-user "tail" feeds, moved verbatim: city / interest
// / industry retrieval via direct RSS + sonar-pro, recent-URL exclusion (§26).
// Distinct from the shared brief. The modeTailFetch entry point stays in the route
// and calls this. Only `export` added to top-level declarations.

import {
  getISTDate,
  extractJsonObject,
} from '@/lib/generate-brief/utils';
import {
  OPENAI_API_KEY,
  supabase,
} from '@/lib/generate-brief/env';
import {
  PERPLEXITY_API_KEY,
} from '@/lib/generate-brief/fetch';
import {
  isWhitelistedSource,
} from '@/lib/whitelist';
import {
  logOpenAICost,
  extractUsageFromChatCompletion,
  extractUsageFromResponses,
} from '@/lib/cost-log';
import {
  fetchStoriesFromFeeds,
} from '@/lib/rss-retrieval';
import {
  applyCitySafety,
} from '@/lib/editorial-safety';

// ============================================================================
// SECTION 26:  TAILS (city / interest / industry)
// ----------------------------------------------------------------------------
// Per-user tail fetches that top up the personalised surface: city, interest,
// and industry feeds (direct RSS + sonar-pro), recent-URL exclusion, and
// modeTailFetch. Distinct from the shared brief; consumed at personalise time.
// Fns:   fetchCityTail, fetchInterestTail, fetchIndustryTail, modeTailFetch
// Flags: TAIL_RSS, TAIL_RECENCY_HOURS, TAIL_MODEL
// ============================================================================
export interface TailStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
  why_it_matters?: string; // Sprint 14.5: real per-story relevance, not a template
}

// Sprint 14.7b: tails moved to Perplexity sonar-pro (recency filter +
// search_domain_filter) to escape gpt-4o-mini-search-preview's 6000 TPM wall,
// which 429'd most tail jobs and left ~15/22 sections empty on 06-16. Override
// via TAIL_FETCH_MODEL (e.g. 'gpt-4o' or 'gpt-4o-mini-search-preview').
export const TAIL_MODEL = 'sonar-pro';

// Sprint 12 — exposed for admin override. Defaults to the cheap mini model;
// flip via env var TAIL_FETCH_MODEL='gpt-4o' to test the quality/cost trade-off.
export function getTailModel(): string {
  const envModel = process.env.TAIL_FETCH_MODEL;
  return envModel && envModel.trim() ? envModel.trim() : TAIL_MODEL;
}

// ─── Sprint 19 — RSS personalization registries ─────────────────────────────
// City-edition and topical feeds from WHITELISTED publishers, retrieved via the
// engine (fetchStoriesFromFeeds), which whitelist-checks and freshness-filters
// every story exactly like the main pool. Keys MATCH the REGIONAL_BY_CITY /
// TOPIC_SOURCES keys (lowercased) so the tail finds them by the same costDetail.
// This is a SEED list — tune it from the `[tail:rss ...]` reachability log: a
// dead or wrong feed URL simply yields zero items (the section is then omitted),
// and can NEVER produce a fabricated story URL (the engine only emits links it
// actually pulled from a live feed). Confirmed URL patterns:
//   The Hindu      : https://www.thehindu.com/news/cities/<City>/feeder/default.rss
//   Indian Express : https://indianexpress.com/section/cities/<city>/feed/
export const thCity = (c: string) => `https://www.thehindu.com/news/cities/${c}/feeder/default.rss`;
export const ieCity = (c: string) => `https://indianexpress.com/section/cities/${c}/feed/`;
export const CITY_FEEDS: Record<string, string[]> = {
  'mumbai':        [ieCity('mumbai'), thCity('mumbai')],
  'delhi':         [ieCity('delhi'), thCity('Delhi')],
  'delhi / ncr':   [ieCity('delhi'), thCity('Delhi')],
  'bengaluru':     [ieCity('bangalore'), thCity('bangalore')],
  'bangalore':     [ieCity('bangalore'), thCity('bangalore')],
  'chennai':       [ieCity('chennai'), thCity('chennai')],
  'hyderabad':     [ieCity('hyderabad'), thCity('Hyderabad')],
  'kolkata':       [ieCity('kolkata')],
  'pune':          [ieCity('pune')],
  'ahmedabad':     [ieCity('ahmedabad')],
  'jaipur':        [ieCity('jaipur')],
  'lucknow':       [ieCity('lucknow'), thCity('Lucknow')],
  'chandigarh':    [ieCity('chandigarh'), thCity('Chandigarh')],
  'kochi':         [thCity('Kochi'), ieCity('kochi')],
  'coimbatore':    [thCity('Coimbatore'), ieCity('coimbatore')],
  'visakhapatnam': [thCity('Visakhapatnam'), ieCity('visakhapatnam')],
  'indore':        [ieCity('indore')],
  'bhopal':        [ieCity('bhopal')],
  'nagpur':        [ieCity('nagpur')],
  'surat':         [ieCity('surat')],
  'vadodara':      [ieCity('vadodara')],
  'guwahati':      [ieCity('guwahati')],
};
// Non-standard interests only (interests mapped to a standard section in
// personalise-briefs.tsx are already served from the shared RSS brief and never
// reach this path). Topics with no confident whitelisted feed are omitted →
// that interest section is simply skipped rather than faked.
export const INTEREST_FEEDS: Record<string, string[]> = {
  'food & travel':               ['https://www.thehindu.com/life-and-style/food/feeder/default.rss', 'https://indianexpress.com/section/lifestyle/food-wine/feed/'],
  'personal finance':            ['https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss', 'https://www.livemint.com/rss/money'],
  'education':                   ['https://indianexpress.com/section/education/feed/', 'https://www.thehindu.com/education/feeder/default.rss'],
  'law & policy':                ['https://www.barandbench.com/feed', 'https://www.livelaw.in/rss/top-stories'],
  'startups & entrepreneurship': ['https://yourstory.com/feed', 'https://inc42.com/feed/'],
  'climate':                     ['https://india.mongabay.com/feed/', 'https://www.downtoearth.org.in/rss/all'],
  'health':                      ['https://www.thehindu.com/sci-tech/health/feeder/default.rss'],
  'psychology':                  ['https://www.sciencedaily.com/rss/mind_brain/psychology.xml'],
};

// Default ON; set TAIL_RSS=false to revert the city/interest tails to Perplexity.
export const TAIL_RSS = (process.env.TAIL_RSS || 'true').toLowerCase() !== 'false';

// Retrieve a tail section's candidates from real feeds. Returns up to `cap`
// candidates (the downstream Claude-select / finalise step then picks and caps
// to 3); why_it_matters is left for that step to derive, never fabricated here.
export async function fetchTailFromFeeds(label: string, feeds: string[], cap: number = 12): Promise<TailStory[]> {
  try {
    const { stories, reachability } = await fetchStoriesFromFeeds(feeds, { concurrency: 4 });
    console.log(`[tail:rss ${label}] ${reachability}`);
    return stories.slice(0, cap).map((s) => ({
      headline: s.headline,
      body: s.body || '',
      source: s.source || wlPublisherLabel(s.source_url) || 'Source',
      source_url: s.source_url,
      published_at: s.published_at,
    }));
  } catch (e: any) {
    console.warn(`[tail:rss ${label}] feed retrieval failed (${e?.message || e}) — section will be empty.`);
    return [];
  }
}

export async function callTailFetch(
  prompt: string,
  label: string,
  costPhase: 'city' | 'interest' | 'industry' | 'storyline',
  costDetail: string,
  skipDomainFilter: boolean = false,
): Promise<TailStory[]> {
  // Sprint 19 — RSS personalization. City and interest tails retrieve from real
  // feeds (whitelisted, freshness-filtered) instead of Perplexity (which
  // fabricated URLs). A key with no configured feed returns [] → the section is
  // omitted, never faked. Industry and storyline keep their existing path.
  if (TAIL_RSS && (costPhase === 'city' || costPhase === 'interest')) {
    const fKey = (costDetail || '').toLowerCase().trim();
    const feeds = costPhase === 'city' ? (CITY_FEEDS[fKey] || []) : (INTEREST_FEEDS[fKey] || []);
    if (feeds.length === 0) {
      console.log(`[tail:rss ${label}] no feed configured for "${fKey}" — omitting (no fabricated fallback).`);
      return [];
    }
    return fetchTailFromFeeds(label, feeds);
  }
  const model = getTailModel();

  // Sprint 14.7b: domain allowlist for this tail (city -> regional mastheads,
  // interest/industry -> topical sources). <= 20 per Perplexity's cap.
  // Sprint 14.7c: skipDomainFilter forces a broad search — used as a fallback
  // when the domain-restricted query returns nothing (Perplexity indexes some
  // local / vernacular sites thinly).
  const dKey = (costDetail || '').toLowerCase().trim();
  const tailDomains = skipDomainFilter ? [] : (costPhase === 'city'
    ? (REGIONAL_BY_CITY[dKey] || [])
    : (TOPIC_SOURCES[dKey] || [])).slice(0, 20);

  // gpt-4o-mini-search-preview uses /v1/chat/completions with web_search_options.
  // gpt-4o (fallback / override) uses /v1/responses with tools: [{type: 'web_search_preview'}].
  // We support both paths so TAIL_FETCH_MODEL can switch between them.

  let text = '';
  try {
    if (model.startsWith('sonar')) {
      // Perplexity path — recency filter + optional domain allowlist. Escapes
      // the search-preview TPM wall that caused the tail empties.
      if (!PERPLEXITY_API_KEY) {
        console.warn(`[tail:${label}] PERPLEXITY_API_KEY not set — cannot run Perplexity tail.`);
        return [];
      }
      const pplxBody: any = {
        model,
        messages: [
          { role: 'system', content: 'You are a news retrieval engine. Return ONLY valid JSON. No markdown, no preamble.' },
          { role: 'user', content: prompt },
        ],
        search_recency_filter: (costPhase === 'storyline') ? 'day' : 'week',
        return_citations: true,
        temperature: 0.2,
        max_tokens: 2500,
      };
      if (tailDomains.length) pplxBody.search_domain_filter = tailDomains;
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PERPLEXITY_API_KEY}` },
        body: JSON.stringify(pplxBody),
      });
      const data = await response.json();
      if (response.status !== 200) {
        console.warn(`[tail:${label}] ${model} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
        return [];
      }
      const usage = data?.usage || {};
      void logOpenAICost({
        phase: costPhase,
        model,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        detail: costDetail,
      });
      text = data?.choices?.[0]?.message?.content || '';
    } else if (model === 'gpt-4o-mini-search-preview') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          web_search_options: {},
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2500,
        }),
      });
      const data = await response.json();
      if (response.status !== 200) {
        console.warn(`[tail:${label}] ${model} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
        return [];
      }
      const usage = extractUsageFromChatCompletion(data);
      void logOpenAICost({
        phase: costPhase,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        detail: costDetail,
      });
      text = data?.choices?.[0]?.message?.content || '';
    } else {
      // gpt-4o via /v1/responses path (existing pattern from personalise-briefs).
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          tools: [{ type: 'web_search_preview' }],
          tool_choice: { type: 'web_search_preview' },
          input: prompt,
          max_output_tokens: 2500,
        }),
      });
      const data = await response.json();
      if (response.status !== 200) {
        console.warn(`[tail:${label}] ${model} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
        return [];
      }
      const usage = extractUsageFromResponses(data);
      void logOpenAICost({
        phase: costPhase,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        detail: costDetail,
      });
      text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text || '';
    }
  } catch (err: any) {
    console.warn(`[tail:${label}] network/api error: ${err?.message || err}`);
    return [];
  }

  if (!text) {
    console.warn(`[tail:${label}] empty text in response`);
    return [];
  }

  let parsed: any;
  try {
    parsed = extractJsonObject(text);
  } catch (err: any) {
    console.warn(`[tail:${label}] JSON parse failed: ${err.message}. Preview: ${text.slice(0, 300)}`);
    return [];
  }

  const raw = Array.isArray(parsed?.stories) ? parsed.stories : [];
  const candidates: TailStory[] = [];
  for (const s of raw) {
    if (!s || typeof s.headline !== 'string' || typeof s.body !== 'string' || typeof s.source !== 'string') continue;
    if (!isWhitelistedSource(s.source_url)) {
      console.warn(`[tail:${label}] dropping non-whitelisted source: ${s.source_url}`);
      continue;
    }
    candidates.push(s as TailStory);
  }
  // Sprint 14.5: editorial sensitivity for city tails — keep crime/tragedy out
  // of the lead and cap it, so a "your city" section isn't dominated by a
  // single murder/suicide item with light framing. (Reorder before the cap.)
  const ordered = costPhase === 'city' ? applyCitySafety(candidates) : candidates;
  if (costPhase === 'city' && ordered.length < candidates.length) {
    console.log(`[tail:${label}] city-safety dropped ${candidates.length - ordered.length} sensitive item(s) from the top set.`);
  }
  return ordered.slice(0, 3);
}

// 7-day used-URL lookup for cross-day dedup.
export async function loadRecentUsedUrls(tailType: string, tailKey: string): Promise<string[]> {
  const today = getISTDate();
  const sevenDaysAgo = getISTDate(-7);
  const { data, error } = await supabase
    .from('tail_used_urls')
    .select('source_url')
    .eq('tail_type', tailType)
    .eq('tail_key', tailKey)
    .gte('date', sevenDaysAgo)
    .lte('date', today);
  if (error) {
    console.warn(`[tail:dedup] used-url lookup failed for ${tailType}/${tailKey}: ${error.message}`);
    return [];
  }
  return (data || []).map((r: any) => r.source_url).filter(Boolean);
}

export function formatExcludeBlock(urls: string[]): string {
  if (urls.length === 0) return '';
  const trimmed = urls.slice(0, 30); // cap prompt size
  return `\nEXCLUDE — these URLs were already surfaced in the last 7 days; do NOT include them again:\n${trimmed.map((u) => `- ${u}`).join('\n')}\n`;
}

export async function fetchCityTail(city: string): Promise<{ stories: TailStory[]; usedRegional: boolean }> {
  const today = getISTDate();
  const cityNormalised = city.toLowerCase().trim();
  const regional = REGIONAL_BY_CITY[cityNormalised] || [];
  const regionalLabels = regional
    .map((d) => wlPublisherLabel(`https://${d}/`) || d)
    .join(', ');

  const excludeUrls = await loadRecentUsedUrls('city', cityNormalised);

  const regionalBlock = regional.length > 0
    ? `\nPREFERRED REGIONAL SOURCES for ${city} — search these FIRST: ${regionalLabels}. These local outlets typically have stories that national papers' city editions miss.\n`
    : '';

  const prompt = `You are sourcing local news for ${city}, India. Today is ${today}.

Search the web for the 1-3 most consequential stories from ${city} in the last 24-36 hours. Civic and municipal news, major events in the city, notable incidents, local policy changes, transport, business openings/closures, urban issues, weather.

If nothing genuinely newsworthy happened, return an empty array. Do not pad with national stories.
${regionalBlock}${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from these publishers:
National: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, The Print, Scroll, Times of India, Deccan Herald, The Wire, NDTV, Moneycontrol, India Today, The Quint, Outlook India.
Regional: Telegraph India (East), Tribune India (North), The News Minute (South), New Indian Express, Mid-Day (Mumbai/Pune), Free Press Journal (Mumbai/MP), Bangalore Mirror, DT Next (Chennai), Telangana Today, Ahmedabad Mirror, Onmanorama (Kerala).
Wires: PTI, ANI.
No aggregators, no social media, no Google News redirects.

Return ONLY a JSON object — no markdown, no commentary:
{
  "stories": [
    {
      "headline": "clear factual headline (max 120 chars)",
      "body": "2-3 sentence factual summary — paraphrase, do not quote at length",
      "why_it_matters": "ONE concrete sentence on why this matters to a resident of ${city} (commute, costs, safety, civic services, local economy). No filler.",
      "source": "publication name",
      "source_url": "https://... direct article link",
      "published_at": "${today}"
    }
  ]
}`;

  let stories = await callTailFetch(prompt, `city:${city}`, 'city', city);
  if (stories.length === 0) {
    // Sprint 14.7c: broad fallback when the local-masthead filter returns nothing.
    stories = await callTailFetch(prompt, `city:${city}`, 'city', city, true);
  }
  const usedRegional = stories.some((s) => isRegionalSource(s.source_url));
  return { stories, usedRegional };
}

export async function fetchInterestTail(interest: string): Promise<TailStory[]> {
  const today = getISTDate();
  const interestKey = interest.toLowerCase().trim();
  // Sprint 19 — with RSS tails on, only non-standard interests (those with a
  // configured feed) need a tail; standard interests are served from the shared
  // sections. Skip the rest entirely rather than calling callTailFetch twice
  // (the first returns [], triggering the retry) and logging "no feed configured"
  // for each attempt.
  if (TAIL_RSS && !INTEREST_FEEDS[interestKey]) return [];
  const excludeUrls = await loadRecentUsedUrls('interest', interestKey);

  // Q4-C: 7-day window for interest tails. Allow features, analyses, and
  // trend pieces from the last week when no fresh 24h news exists.
  const prompt = `You are sourcing content about "${interest}" for an India-focused daily brief. Today is ${today}.

Two-pass strategy:
1. FIRST PASS — search for 24-48h news developments on ${interest}. Major announcements, policy moves, milestones, events. India focus preferred but global if globally significant.
2. SECOND PASS (only if first pass yields fewer than 3 stories) — search for recent feature articles, analyses, trend pieces, or thoughtful explainers published in the LAST 7 DAYS on ${interest}. Recent developments, current trends, important shifts. Still from whitelisted publishers only.

Return 1-3 total stories combining both passes. Paraphrase content into 2-3 factual sentences — do NOT quote at length. Headlines should be your own factual summary, not the original article's title verbatim.
${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from these publishers:
Global: Reuters, AP, Bloomberg, FT, WSJ, NYT, WaPo, BBC, The Guardian, The Economist, Al Jazeera, ABC News Australia.
India national: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, The Print, Scroll, Deccan Herald, The Wire, NDTV, India Today, The Quint, Outlook India, Caravan, Moneycontrol, Financial Express, Business Today, Economic Times, New Indian Express, Telegraph India, Tribune India, The News Minute.
India wires: PTI, ANI.
India specialist: Live Law, Bar & Bench (law), Down To Earth (environment/health).
Government primary: PIB, RBI, SEBI, MoSPI.
Specialist (where general sources don't cover): Nature, Science, STAT, TechCrunch, The Verge, Wired, Variety, Hollywood Reporter, ESPNCricinfo, ESPN.

Return ONLY a JSON object — no markdown:
{
  "stories": [
    { "headline": "your factual summary headline", "body": "2-3 sentence paraphrased summary", "why_it_matters": "ONE concrete sentence on why a reader who follows ${interest} should care — name the specific stake. No filler.", "source": "Publisher Name", "source_url": "https://...", "published_at": "${today}" }
  ]
}`;

  let stories = await callTailFetch(prompt, `interest:${interest}`, 'interest', interest);
  if (stories.length === 0) stories = await callTailFetch(prompt, `interest:${interest}`, 'interest', interest, true);
  return stories;
}

export async function fetchIndustryTail(industry: string): Promise<TailStory[]> {
  const today = getISTDate();
  const industryKey = industry.toLowerCase().trim();
  const excludeUrls = await loadRecentUsedUrls('industry', industryKey);

  const prompt = `You are sourcing news with MATERIAL RELEVANCE to the "${industry}" sector for an India-focused daily brief targeting working professionals. Today is ${today}.

"Material relevance" means anything that moves the sector's economics or operations — NOT only stories about ${industry} companies. Include:
- Policy / regulatory changes that affect the sector (budgets, duties, compliance rules, court rulings)
- Macro moves that hit its cost base or demand (rates, rupee, commodity and energy prices, trade policy)
- Supply-chain, infrastructure, and technology shifts the sector must respond to
- The classics: earnings, deals, funding, leadership moves, sector-wide trends

Two-pass strategy:
1. FIRST PASS — search for 24-48h developments materially relevant to ${industry} (per the definition above). India focus preferred; include global moves that affect Indian operators.
2. SECOND PASS (only if first pass yields fewer than 3 stories) — search for feature articles, analyses, or trend pieces published in the LAST 7 DAYS on ${industry}. Industry shifts, regulatory trajectories, market shifts.

Return 1-3 total stories. Paraphrase into 2-3 factual sentences — do NOT quote at length. Every story's body MUST end with one sentence naming the specific transmission channel to ${industry} (e.g. "For pharma: imported API costs rise as the rupee weakens.").
${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from:
Global wires/papers: Reuters, AP, Bloomberg, FT, WSJ, NYT, WaPo, BBC, The Guardian, The Economist.
India national & business: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, Financial Express, Moneycontrol, Business Today, The Hindu BusinessLine, NDTV, India Today.
India digital: The Print, Scroll, The Wire, Caravan.
India wires: PTI, ANI.
Government primary: RBI, SEBI, MoSPI, PIB.
Specialist: TechCrunch, The Verge, Wired (tech), Nature/Science/STAT (health/pharma), Variety/Hollywood Reporter (media), ESPN/ESPNCricinfo (sport).

Return ONLY a JSON object — no markdown:
{
  "stories": [
    { "headline": "your factual summary headline", "body": "2-3 sentence paraphrased summary", "why_it_matters": "ONE concrete sentence naming the transmission channel to the ${industry} sector (costs, demand, regulation, supply chain). No filler.", "source": "Publisher Name", "source_url": "https://...", "published_at": "${today}" }
  ]
}`;

  let stories = await callTailFetch(prompt, `industry:${industry}`, 'industry', industry);
  if (stories.length === 0) stories = await callTailFetch(prompt, `industry:${industry}`, 'industry', industry, true);
  return stories;
}

export interface TailFetchResult {
  tail_type: 'city' | 'interest' | 'industry';
  tail_key: string;
  display_name: string;
  stories: TailStory[];
  status: 'ready' | 'empty' | 'failed';
  reason?: string;
  usedRegional?: boolean;
}

