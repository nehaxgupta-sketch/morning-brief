// src/lib/whitelist.ts
//
// Sprint 11 — single source of truth for the Tier-1 source whitelist.
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
  'ptinews.com',                       // Press Trust of India (wire)
  'aninews.in',                        // Asian News International
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

  // ─── India — specialist (legal, environment) ──────────────────────────────
  'livelaw.in',                        // Court / legal news — Law & Policy
  'barandbench.com',                   // Court / legal news — Law & Policy
  'downtoearth.org.in',                // Environment / public health

  // ─── Government / institutional primary sources ───────────────────────────
  'rbi.org.in',
  'sebi.gov.in',
  'mospi.gov.in',                      // Ministry of Statistics
  'pib.gov.in',                        // Press Information Bureau
  'bls.gov',                           // US Bureau of Labor Statistics
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
// Array.from() avoids the downlevel-iteration TS error on Set<string>.
export function isWhitelistedSource(url: string | undefined | null): boolean {
  const host = extractHostname(url);
  if (!host) return false;
  for (const allowed of Array.from(TIER_1_DOMAINS)) {
    if (host === allowed || host.endsWith('.' + allowed)) return true;
  }
  return false;
}

// Resolve a URL to its normalised publisher domain (for diversity caps).
// Returns the matched whitelisted root domain when applicable.
// e.g. 'https://m.indianexpress.com/article/...' → 'indianexpress.com'.
// Returns null for non-whitelisted URLs.
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
  'livelaw.in': 'Live Law',
  'barandbench.com': 'Bar and Bench',
  'downtoearth.org.in': 'Down To Earth',
};

export function publisherLabel(url: string | undefined | null): string | null {
  const key = publisherKey(url);
  if (!key) return null;
  return PUBLISHER_LABELS[key] || key;
}
