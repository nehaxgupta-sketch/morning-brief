// src/lib/whitelist.ts
//
// Sprint 11 — single source of truth for the Tier-1 source whitelist.
// Sprint 12 — added regional sources for city-tail fetches.
// Sprint 12.5.1 — added Beatroot News (credible curated journalism brand,
//                 founder Faye D'Souza, Mumbai, fact-checked / non-partisan).
// Sprint 14.7 — added each major metro's LOCAL + VERNACULAR mastheads and
//                 rewrote REGIONAL_BY_CITY so the city fetch reaches the civic
//                 front page (water/transport/governance), not just the
//                 national outlets' tragedy-skewed city coverage. National
//                 papers only cover a city when something dramatic happens, so
//                 a national-only source list structurally biases city sections
//                 toward crime/accidents. The real civic news lives on local
//                 (often Marathi/Bengali/Kannada/Hindi) mastheads.
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

// ─── Regional sources ───────────────────────────────────────────────────────
// These pass the whitelist check (merged into TIER_1_DOMAINS below) AND are
// tracked here separately so the city fetcher can name them explicitly and so
// isRegionalSource() can flag used_regional=true.

export const REGIONAL_DOMAINS = new Set<string>([
  // ─── Sprint 12 set ─────────────────────────────────────────────────────────
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

  // ─── Sprint 14.7 — local + vernacular mastheads (the civic front page) ─────
  // Quality note: these are the established mastheads that actually run each
  // city's civic news. Smaller local-digital sites (e.g. punenow.com) are
  // deliberately NOT added yet — hold them for the numeric per-domain trust
  // score so the trust surface stays clean.
  //
  // Pune / Maharashtra (Marathi owns civic coverage here)
  'esakal.com',                        // Sakal
  'maharashtratimes.com',              // Maharashtra Times (TOI group, Marathi)
  'lokmat.com',                        // Lokmat
  'loksatta.com',                      // Loksatta (Indian Express group, Marathi)
  'punemirror.in',                     // Pune Mirror — verify domain resolves; drop if it 404s
  // Kolkata / West Bengal (Bengali)
  'thestatesman.com',                  // The Statesman (Kolkata broadsheet)
  'anandabazar.com',                   // Anandabazar Patrika
  'bartamanpatrika.com',               // Bartaman
  'eisamay.com',                       // Ei Samay (TOI group, Bengali)
  // Bengaluru / Karnataka (Kannada)
  'prajavani.net',                     // Prajavani
  'vijaykarnataka.com',                // Vijaya Karnataka (TOI group, Kannada)
  'udayavani.com',                     // Udayavani
  // Delhi / NCR (Hindi)
  'jagran.com',                        // Dainik Jagran
  'bhaskar.com',                       // Dainik Bhaskar
  'amarujala.com',                     // Amar Ujala
  'navbharattimes.indiatimes.com',     // Navbharat Times (TOI group, Hindi)
  'livehindustan.com',                 // Hindustan (HT group, Hindi)
  'millenniumpost.in',                 // Millennium Post (Delhi / East)
]);

// Merge regional domains into TIER_1_DOMAINS so existing whitelist checks
// accept them without changes. The Set's add() is idempotent.
for (const d of Array.from(REGIONAL_DOMAINS)) {
  TIER_1_DOMAINS.add(d);
}

// ─── Sprint 14.7b — quality topical sources for INTEREST sections ───────────
// Interests are topical, not local: the right sources are often international
// or specialist outlets an India-news Tier-1 list omits. The earlier interest
// empties (Food & Travel, Personal Finance, Psychology, Parenting) came from
// dropping legitimate outlets like Condé Nast Traveller, National Geographic,
// Forbes India and The Conversation. Added as a curated topical floor; pair
// with TOPIC_SOURCES (below) for targeting.
export const TOPICAL_DOMAINS = new Set<string>([
  // Food & travel
  'cntraveller.in',
  'nationalgeographic.com',
  'travelandleisure.com',
  // Personal finance (India)
  'forbesindia.com',
  // Science / psychology / ideas
  'scientificamerican.com',
  'theconversation.com',
  'sciencedaily.com',
  'aeon.co',
  'theatlantic.com',
  // Startups / entrepreneurship (India ecosystem)
  'yourstory.com',
  'inc42.com',
  'entrackr.com',
]);

for (const d of Array.from(TOPICAL_DOMAINS)) {
  TIER_1_DOMAINS.add(d);
}

// ─── City → preferred regional sources mapping ──────────────────────────────
// Used by the city fetcher (Perplexity search_domain_filter + prompt steering)
// to target the right LOCAL outlets first. Keep each list <= 20 (Perplexity's
// domain-filter cap). Keys are lowercased; the matcher uses .toLowerCase().trim()
// — "Delhi / NCR" → "delhi / ncr".
//
// THE RULE (apply to every city): top local English daily + the 2-3 dominant
// state-language dailies + the relevant national city editions. Cities not yet
// expanded below fall back to nationals; extend them the same way as needed.

export const REGIONAL_BY_CITY: Record<string, string[]> = {
  // ── Expanded in Sprint 14.7 (live cities) ──
  'pune':           ['esakal.com', 'maharashtratimes.com', 'lokmat.com', 'loksatta.com', 'punemirror.in', 'hindustantimes.com', 'indianexpress.com', 'timesofindia.indiatimes.com'],
  'kolkata':        ['telegraphindia.com', 'thestatesman.com', 'anandabazar.com', 'bartamanpatrika.com', 'eisamay.com', 'hindustantimes.com', 'timesofindia.indiatimes.com', 'indianexpress.com'],
  'bengaluru':      ['deccanherald.com', 'bangaloremirror.indiatimes.com', 'thehindu.com', 'prajavani.net', 'vijaykarnataka.com', 'udayavani.com', 'thenewsminute.com', 'timesofindia.indiatimes.com'],
  'bangalore':      ['deccanherald.com', 'bangaloremirror.indiatimes.com', 'thehindu.com', 'prajavani.net', 'vijaykarnataka.com', 'udayavani.com', 'thenewsminute.com', 'timesofindia.indiatimes.com'],
  'delhi / ncr':    ['hindustantimes.com', 'timesofindia.indiatimes.com', 'indianexpress.com', 'thehindu.com', 'theprint.in', 'jagran.com', 'bhaskar.com', 'amarujala.com', 'navbharattimes.indiatimes.com', 'livehindustan.com', 'millenniumpost.in'],
  'delhi':          ['hindustantimes.com', 'timesofindia.indiatimes.com', 'indianexpress.com', 'thehindu.com', 'theprint.in', 'jagran.com', 'bhaskar.com', 'amarujala.com', 'navbharattimes.indiatimes.com', 'livehindustan.com', 'millenniumpost.in'],
  'mumbai':         ['mid-day.com', 'freepressjournal.in', 'maharashtratimes.com', 'loksatta.com', 'lokmat.com', 'hindustantimes.com', 'indianexpress.com', 'timesofindia.indiatimes.com'],

  // ── Sprint 12 entries (nationals; expand per THE RULE above when a user signs up) ──
  'chennai':        ['thehindu.com', 'dtnext.in', 'newindianexpress.com', 'thenewsminute.com'],
  'hyderabad':      ['telanganatoday.com', 'thehindu.com', 'newindianexpress.com', 'deccanherald.com'],
  'ahmedabad':      ['ahmedabadmirror.com', 'indianexpress.com', 'timesofindia.indiatimes.com'],
  'jaipur':         ['hindustantimes.com', 'indianexpress.com', 'tribuneindia.com'],
  'lucknow':        ['hindustantimes.com', 'indianexpress.com', 'thehindu.com', 'amarujala.com', 'jagran.com'],
  'chandigarh':     ['tribuneindia.com', 'hindustantimes.com', 'indianexpress.com'],
  'kochi':          ['onmanorama.com', 'thehindu.com', 'newindianexpress.com', 'thenewsminute.com'],
  'indore':         ['freepressjournal.in', 'bhaskar.com', 'hindustantimes.com', 'indianexpress.com'],
  'bhopal':         ['freepressjournal.in', 'bhaskar.com', 'hindustantimes.com', 'indianexpress.com'],
  'nagpur':         ['hindustantimes.com', 'indianexpress.com', 'lokmat.com', 'freepressjournal.in'],
  'surat':          ['ahmedabadmirror.com', 'indianexpress.com', 'timesofindia.indiatimes.com'],
  'visakhapatnam':  ['thehindu.com', 'newindianexpress.com', 'deccanherald.com'],
  'coimbatore':     ['thehindu.com', 'dtnext.in', 'newindianexpress.com'],
  'vadodara':       ['ahmedabadmirror.com', 'indianexpress.com', 'timesofindia.indiatimes.com'],
};

// ─── Interest / industry → preferred sources (Sprint 14.7b) ─────────────────
// Topical analogue of REGIONAL_BY_CITY. Used by the interest fetch (Perplexity
// search_domain_filter + prompt) and the interest/industry tail fetch. Keep
// each list <= 20. Topics not listed fall back to broad search + the whitelist
// floor. Keys are lowercased.
export const TOPIC_SOURCES: Record<string, string[]> = {
  // Interests
  'food & travel':               ['cntraveller.in', 'nationalgeographic.com', 'travelandleisure.com', 'livemint.com', 'thehindu.com', 'indianexpress.com'],
  'personal finance':            ['livemint.com', 'moneycontrol.com', 'economictimes.indiatimes.com', 'financialexpress.com', 'business-standard.com', 'forbesindia.com'],
  'psychology':                  ['scientificamerican.com', 'theconversation.com', 'sciencedaily.com', 'nature.com', 'thehindu.com'],
  'philosophy':                  ['aeon.co', 'theconversation.com', 'caravanmagazine.in', 'thehindu.com'],
  'education':                   ['thehindu.com', 'indianexpress.com', 'hindustantimes.com', 'theprint.in', 'scroll.in', 'theconversation.com'],
  'parenting':                   ['theconversation.com', 'theatlantic.com', 'thehindu.com', 'indianexpress.com', 'hindustantimes.com'],
  'startups & entrepreneurship': ['yourstory.com', 'inc42.com', 'entrackr.com', 'economictimes.indiatimes.com', 'livemint.com', 'moneycontrol.com', 'techcrunch.com'],
  'law & policy':                ['livelaw.in', 'barandbench.com', 'thehindu.com', 'indianexpress.com', 'thewire.in', 'caravanmagazine.in'],
  // Industries (used by the industry tail)
  'technology':                  ['techcrunch.com', 'theverge.com', 'wired.com', 'arstechnica.com', 'economictimes.indiatimes.com', 'livemint.com', 'moneycontrol.com'],
  'energy':                      ['downtoearth.org.in', 'reuters.com', 'bloomberg.com', 'economictimes.indiatimes.com', 'livemint.com', 'business-standard.com', 'moneycontrol.com'],
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
// city fetcher to log used_regional=true so admin can see whether city
// stories are coming from regional vs national outlets.
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
  // Sprint 14.7 local + vernacular additions:
  'esakal.com': 'Sakal',
  'maharashtratimes.com': 'Maharashtra Times',
  'lokmat.com': 'Lokmat',
  'loksatta.com': 'Loksatta',
  'punemirror.in': 'Pune Mirror',
  'thestatesman.com': 'The Statesman',
  'anandabazar.com': 'Anandabazar Patrika',
  'bartamanpatrika.com': 'Bartaman',
  'eisamay.com': 'Ei Samay',
  'prajavani.net': 'Prajavani',
  'vijaykarnataka.com': 'Vijaya Karnataka',
  'udayavani.com': 'Udayavani',
  'jagran.com': 'Dainik Jagran',
  'bhaskar.com': 'Dainik Bhaskar',
  'amarujala.com': 'Amar Ujala',
  'navbharattimes.indiatimes.com': 'Navbharat Times',
  'livehindustan.com': 'Hindustan',
  'millenniumpost.in': 'Millennium Post',
  // Sprint 14.7b topical additions:
  'cntraveller.in': 'Condé Nast Traveller',
  'nationalgeographic.com': 'National Geographic',
  'travelandleisure.com': 'Travel + Leisure',
  'forbesindia.com': 'Forbes India',
  'scientificamerican.com': 'Scientific American',
  'theconversation.com': 'The Conversation',
  'sciencedaily.com': 'ScienceDaily',
  'aeon.co': 'Aeon',
  'theatlantic.com': 'The Atlantic',
  'yourstory.com': 'YourStory',
  'inc42.com': 'Inc42',
  'entrackr.com': 'Entrackr',
};

export function publisherLabel(url: string | undefined | null): string | null {
  const key = publisherKey(url);
  if (!key) return null;
  return PUBLISHER_LABELS[key] || key;
}
