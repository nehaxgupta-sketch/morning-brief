// src/lib/whitelist.ts
//
// Sprint 11 — single source of truth for the Tier-1 source whitelist.
// Sprint 12 — added regional sources for city-tail fetches.
// Sprint 12.5.1 — added Beatroot News (credible curated journalism brand,
//                 founder Faye D'Souza, Mumbai, fact-checked / non-partisan).
//
// Previously this list was duplicated inline in both generate-brief.tsx and
// personalise-briefs.tsx. The two copies drifted: the personalise-briefs copy
// was missing Live Law, Bar & Bench, PIB, RBI, SEBI, and other specialist
// sources. This was the root cause of Sprint 10's "Law & Policy returned 0
// hits" issue — every story Bar & Bench / Live Law published was correctly
// found by gpt-4o but then dropped by the (incomplete) whitelist check.
//
// Both files now import from here. Do NOT inline-copy these domains anywhere
// else — drift is what created the original bug.
//
// Sprint 12: added regional sources for city tail coverage. These pass the
// whitelist check the same way as national sources. They are tracked
// separately so the city-tail fetcher can prompt the model to PRIORITISE
// regional outlets for city-specific stories.

// ─── National / global Tier-1 ───────────────────────────────────────────────
export const TIER_1_DOMAINS = new Set<string>([
  // ─── Global wires + papers of record ──────────────────────────────────────
  'reuters.com',
  'apnews.com',
  'bloomberg.com',
  'ft.com',
  'wsj.com',
  'nytimes.com',
  'washingtonpost.com',
  'bbc.com',
  'bbc.co.uk',
  'economist.com',
  'theguardian.com',
  'aljazeera.com',
  'abc.net.au',

  // ─── India — wires + papers of record ─────────────────────────────────────
  'ptinews.com',
  'aninews.in',
  'thehindu.com',
  'thehindubusinessline.com',
  'indianexpress.com',
  'newindianexpress.com',
  'hindustantimes.com',
  'ndtv.com',
  'timesofindia.indiatimes.com',
  'deccanherald.com',
  'telegraphindia.com',                // Kolkata / East India
  'tribuneindia.com',                  // Punjab / Haryana / Himachal

  // ─── India — business / markets ───────────────────────────────────────────
  'livemint.com',
  'business-standard.com',
  'economictimes.indiatimes.com',
  'financialexpress.com',
  'moneycontrol.com',
  'businesstoday.in',

  // ─── India — digital + magazine journalism ────────────────────────────────
  'theprint.in',
  'scroll.in',
  'thewire.in',
  'indiatoday.in',
  'outlookindia.com',
  'thequint.com',
  'caravanmagazine.in',
  'thenewsminute.com',                 // South India regional
  // Sprint 12.5.1 — Beatroot News (Faye D'Souza, founded 2020, Mumbai;
  // fact-checked, non-partisan, no clickbait headlines). App-first publisher;
  // articles primarily exist inside the Beatroot app, but URLs on
  // beatrootnews.com and app.beatrootnews.com pass the whitelist if Perplexity
  // / gpt-4o surface them. NOTE: because Beatroot is primarily an Ember SPA
  // without crawlable article URLs, web search engines may not surface their
  // content often — see Sprint 13 backlog for a possible RSS/API integration.
  'beatrootnews.com',

  // ─── India — specialist (legal, environment) ──────────────────────────────
  'livelaw.in',
  'barandbench.com',
  'downtoearth.org.in',

  // ─── Government / institutional primary sources ───────────────────────────
  'rbi.org.in',
  'sebi.gov.in',
  'mospi.gov.in',
  'pib.gov.in',
  'bls.gov',
  'treasury.gov',
  'federalreserve.gov',
  'imf.org',
  'worldbank.org',
  'who.int',

  // ─── Specialist (allowed where general sources don't cover) ───────────────
  'espncricinfo.com',
  'espn.com',
  'variety.com',
  'hollywoodreporter.com',
  'nature.com',
  'science.org',
  'statnews.com',
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
]);

// ─── Regional sources (Sprint 12) ───────────────────────────────────────────
// These pass the whitelist check (added to TIER_1_DOMAINS below) AND are
// tracked here separately so the city-tail prompt can name them explicitly.
// City → preferred regional sources mapping lives in REGIONAL_BY_CITY.

export const REGIONAL_DOMAINS = new Set<string>([
  // Mumbai / Pune / Western Maharashtra
  'mid-day.com',
  'freepressjournal.in',
  // Bengaluru / Karnataka
  'bangaloremirror.indiatimes.com',
  // Chennai / Tamil Nadu
  'dtnext.in',
  // Hyderabad / Telangana
  'telanganatoday.com',
  // Ahmedabad / Gujarat
  'ahmedabadmirror.com',
  // Kerala
  'onmanorama.com',
  // Note: Telegraph India (East), Tribune India (North), News Minute (South),
  // Deccan Herald (Bengaluru) are already in TIER_1_DOMAINS above. They will
  // ALSO appear in REGIONAL_BY_CITY mappings.
]);

// Merge regional domains into TIER_1_DOMAINS so existing whitelist checks
// accept them without changes. The Set's add() is idempotent.
for (const d of Array.from(REGIONAL_DOMAINS)) {
  TIER_1_DOMAINS.add(d);
}

// ─── City → preferred regional sources mapping ──────────────────────────────
// Used by the city-tail prompt to direct gpt-4o-mini-search-preview to the
// right local outlets. Values reference both TIER_1 and REGIONAL_DOMAINS keys.
//
// Keys are lowercased. The matcher in generate-brief uses .toLowerCase().trim()
// — "Delhi / NCR" → "delhi / ncr".

export const REGIONAL_BY_CITY: Record<string, string[]> = {
  'mumbai':         ['mid-day.com', 'freepressjournal.in', 'hindustantimes.com', 'indianexpress.com'],
  'pune':           ['mid-day.com', 'freepressjournal.in', 'hindustantimes.com', 'indianexpress.com'],
  'bengaluru':      ['deccanherald.com', 'bangaloremirror.indiatimes.com', 'thenewsminute.com', 'thehindu.com'],
  'bangalore':      ['deccanherald.com', 'bangaloremirror.indiatimes.com', 'thenewsminute.com', 'thehindu.com'],
  'chennai':        ['thehindu.com', 'dtnext.in', 'newindianexpress.com', 'thenewsminute.com'],
  'hyderabad':      ['telanganatoday.com', 'thehindu.com', 'newindianexpress.com', 'deccanherald.com'],
  'delhi / ncr':    ['hindustantimes.com', 'indianexpress.com', 'thehindu.com', 'theprint.in'],
  'delhi':          ['hindustantimes.com', 'indianexpress.com', 'thehindu.com', 'theprint.in'],
  'kolkata':        ['telegraphindia.com', 'hindustantimes.com', 'indianexpress.com', 'thehindu.com'],
  'ahmedabad':      ['ahmedabadmirror.com', 'indianexpress.com', 'timesofindia.indiatimes.com'],
  'jaipur':         ['hindustantimes.com', 'indianexpress.com', 'tribuneindia.com'],
  'lucknow':        ['hindustantimes.com', 'indianexpress.com', 'thehindu.com'],
  'chandigarh':     ['tribuneindia.com', 'hindustantimes.com', 'indianexpress.com'],
  'kochi':          ['onmanorama.com', 'thehindu.com', 'newindianexpress.com', 'thenewsminute.com'],
  'indore':         ['freepressjournal.in', 'hindustantimes.com', 'indianexpress.com'],
  'bhopal':         ['freepressjournal.in', 'hindustantimes.com', 'indianexpress.com'],
  'nagpur':         ['hindustantimes.com', 'indianexpress.com', 'freepressjournal.in'],
  'surat':          ['ahmedabadmirror.com', 'indianexpress.com', 'timesofindia.indiatimes.com'],
  'visakhapatnam':  ['thehindu.com', 'newindianexpress.com', 'deccanherald.com'],
  'coimbatore':     ['thehindu.com', 'dtnext.in', 'newindianexpress.com'],
  'vadodara':       ['ahmedabadmirror.com', 'indianexpress.com', 'timesofindia.indiatimes.com'],
};

// Extract a normalised hostname from a URL. Strips www./m./amp. prefixes so
// mobile and AMP subdomains of whitelisted publishers pass the check.
export function extractHostname(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase()
      .replace(/^www\./, '')
      .replace(/^m\./, '')
      .replace(/^amp\./, '');
  } catch {
    return null;
  }
}

// Accept exact match or any subdomain of a whitelisted domain.
export function isWhitelistedSource(url: string | undefined | null): boolean {
  const host = extractHostname(url);
  if (!host) return false;
  for (const allowed of Array.from(TIER_1_DOMAINS)) {
    if (host === allowed || host.endsWith('.' + allowed)) return true;
  }
  return false;
}

// Sprint 12: detect whether a URL is from a regional source. Used by the
// city-tail fetcher to log used_regional=true so admin can see whether
// city stories are coming from regional vs national outlets.
export function isRegionalSource(url: string | undefined | null): boolean {
  const host = extractHostname(url);
  if (!host) return false;
  for (const allowed of Array.from(REGIONAL_DOMAINS)) {
    if (host === allowed || host.endsWith('.' + allowed)) return true;
  }
  return false;
}

// Resolve a URL to its normalised publisher domain (for diversity caps).
// Returns the matched whitelisted root domain when applicable.
export function publisherKey(url: string | undefined | null): string | null {
  const host = extractHostname(url);
  if (!host) return null;
  for (const allowed of Array.from(TIER_1_DOMAINS)) {
    if (host === allowed || host.endsWith('.' + allowed)) return allowed;
  }
  return null;
}

// Human-readable publisher name for prompts and logging.
const PUBLISHER_LABELS: Record<string, string> = {
  'reuters.com': 'Reuters',
  'apnews.com': 'AP',
  'bloomberg.com': 'Bloomberg',
  'ft.com': 'Financial Times',
  'wsj.com': 'Wall Street Journal',
  'nytimes.com': 'New York Times',
  'washingtonpost.com': 'Washington Post',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'economist.com': 'The Economist',
  'theguardian.com': 'The Guardian',
  'aljazeera.com': 'Al Jazeera',
  'abc.net.au': 'ABC News Australia',
  'ptinews.com': 'PTI',
  'aninews.in': 'ANI',
  'thehindu.com': 'The Hindu',
  'thehindubusinessline.com': 'The Hindu BusinessLine',
  'indianexpress.com': 'Indian Express',
  'newindianexpress.com': 'New Indian Express',
  'hindustantimes.com': 'Hindustan Times',
  'ndtv.com': 'NDTV',
  'timesofindia.indiatimes.com': 'Times of India',
  'deccanherald.com': 'Deccan Herald',
  'telegraphindia.com': 'Telegraph India',
  'tribuneindia.com': 'Tribune India',
  'livemint.com': 'Mint',
  'business-standard.com': 'Business Standard',
  'economictimes.indiatimes.com': 'Economic Times',
  'financialexpress.com': 'Financial Express',
  'moneycontrol.com': 'Moneycontrol',
  'businesstoday.in': 'Business Today',
  'theprint.in': 'The Print',
  'scroll.in': 'Scroll',
  'thewire.in': 'The Wire',
  'indiatoday.in': 'India Today',
  'outlookindia.com': 'Outlook India',
  'thequint.com': 'The Quint',
  'caravanmagazine.in': 'The Caravan',
  'thenewsminute.com': 'The News Minute',
  'beatrootnews.com': 'Beatroot News',
  'livelaw.in': 'Live Law',
  'barandbench.com': 'Bar and Bench',
  'downtoearth.org.in': 'Down To Earth',
  // Sprint 12 regional additions:
  'mid-day.com': 'Mid-Day',
  'freepressjournal.in': 'Free Press Journal',
  'bangaloremirror.indiatimes.com': 'Bangalore Mirror',
  'dtnext.in': 'DT Next',
  'telanganatoday.com': 'Telangana Today',
  'ahmedabadmirror.com': 'Ahmedabad Mirror',
  'onmanorama.com': 'Onmanorama',
};

export function publisherLabel(url: string | undefined | null): string | null {
  const key = publisherKey(url);
  if (!key) return null;
  return PUBLISHER_LABELS[key] || key;
}
