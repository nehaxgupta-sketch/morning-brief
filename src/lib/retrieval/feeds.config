/**
 * feeds.config.ts — Morning Brief Sprint 15 verified feed manifest (Phase 0 output).
 *
 * Two flavours of feed (build-plan §3.1):
 *   SECTION_FEEDS = publisher-curated streams = the standard-coverage backbone.
 *   QUERY_*       = Google News RSS turns any search into a live feed = the
 *                   personalisation engine (cities / interests / professions / desks / follows).
 *
 * Phase 0 rule: every SECTION_FEEDS entry must PASS validate-feeds.cjs before Phase 1.
 * Any FAIL -> set `verified: false` and replace with a Google News query feed scoped
 * to that publisher (e.g. q=site:thehindu.com when:1d), per build-plan §5.1.
 *
 * Tags carried into the shared pool are exactly what the existing deterministic
 * personaliser (scoreStory) keys off — do NOT rename a tag without updating it.
 */

export type Section =
  | 'major_events' | 'world' | 'india' | 'business'
  | 'technology' | 'climate_health' | 'sport' | 'culture' | 'markets_news';

export type SourceTier = 1 | 2 | 3; // from whitelist.ts sourceTier()

export interface SectionFeed {
  source: string;
  tier: SourceTier;
  url: string;
  sections: Section[];
  tags: string[];
  verified: boolean; // set true once it PASSes validate-feeds.cjs
}

/** Google News RSS — India English locale. Interpolate an encoded q-value. */
export const GOOGLE_NEWS_BASE =
  'https://news.google.com/rss/search?q={q}&hl=en-IN&gl=IN&ceid=IN:en';

export function googleNewsFeed(q: string): string {
  return GOOGLE_NEWS_BASE.replace('{q}', encodeURIComponent(q));
}

export type QueryKind = 'wire' | 'city' | 'interest' | 'profession' | 'desk' | 'follow' | 'source';

export interface QueryTemplate {
  kind: QueryKind;
  /** tag-slug pattern; {name}/{slug}/{storyId} filled at build time */
  slug: string;
  /** Google News q= value; {name}/{terms} filled at build time */
  q: string;
  tags: string[];
}

/** World wires whose public RSS is discontinued — covered via Google News (§5.1). */
export const WIRE_FEEDS: QueryTemplate[] = [
  { kind: 'wire', slug: 'src:reuters', q: 'site:reuters.com when:1d', tags: ['src:reuters', 'sec:world'] },
  { kind: 'wire', slug: 'src:ap',      q: 'site:apnews.com when:1d',  tags: ['src:ap', 'sec:world'] },
];

/**
 * Sprint 15 — DEDICATED feeds for the whitelist expansion ("wire direct feeds").
 * Each strong new source gets a guaranteed daily pull rather than only appearing
 * when a topic search happens to surface it.
 *   - Sources that publish RSS  -> added to SECTION_FEEDS below (verified:false).
 *   - Sources without usable RSS (or paywalled) -> a dedicated site-scoped Google
 *     News feed here (reliable; the Google News pattern already passed Phase 0).
 * Validate, then keep whatever passes; anything that fails still works via the
 * normal personalisation search, so nothing is lost.
 */
export const NEW_SOURCE_QUERY_FEEDS: QueryTemplate[] = [
  // World / geopolitics
  { kind: 'source', slug: 'src:afp',          q: 'site:afp.com when:1d',             tags: ['src:afp', 'sec:world'] },
  { kind: 'source', slug: 'src:scmp',         q: 'site:scmp.com when:1d',            tags: ['src:scmp', 'sec:world'] },
  { kind: 'source', slug: 'src:nikkei',       q: 'site:asia.nikkei.com when:1d',     tags: ['src:nikkei', 'sec:world'] },
  // Business (subscription / no clean RSS)
  { kind: 'source', slug: 'src:theken',       q: 'site:the-ken.com when:2d',         tags: ['src:theken', 'sec:business'] },
  { kind: 'source', slug: 'src:tmc',          q: 'site:themorningcontext.com when:2d', tags: ['src:tmc', 'sec:business'] },
  { kind: 'source', slug: 'src:ndtvprofit',   q: 'site:ndtvprofit.com when:1d',      tags: ['src:ndtvprofit', 'sec:business'] },
  { kind: 'source', slug: 'src:fortuneindia', q: 'site:fortuneindia.com when:2d',    tags: ['src:fortuneindia', 'sec:business'] },
  { kind: 'source', slug: 'src:cnbc',         q: 'site:cnbc.com when:1d',            tags: ['src:cnbc', 'sec:business'] },
  // Climate / health
  { kind: 'source', slug: 'src:dialogue',     q: 'site:dialogue.earth when:3d',      tags: ['src:dialogue', 'sec:climate'] },
  { kind: 'source', slug: 'src:indiaspend',   q: 'site:indiaspend.com when:3d',      tags: ['src:indiaspend', 'sec:climate'] },
  // Fact-check / sport
  { kind: 'source', slug: 'src:boom',         q: 'site:boomlive.in when:2d',         tags: ['src:boom', 'sec:india'] },
  { kind: 'source', slug: 'src:athletic',     q: 'site:theathletic.com when:2d',     tags: ['src:athletic', 'sec:sport'] },
];

/** The 6 live desks as fixed query bundles (§5.5); SECTION_FEEDS supply the rest. */
export const DESK_QUERIES: Record<string, string[]> = {
  markets:       ['(Sensex OR Nifty OR rupee OR FII) when:1d'],
  business:      ['(earnings OR M&A OR IPO OR results) India when:2d'],
  tech:          ['(AI OR chips OR cybersecurity OR big tech OR data centre) when:2d'],
  entertainment: ['(Bollywood OR OTT OR box office OR music OR film) India when:2d'],
  sport:         ['cricket when:2d', 'football when:2d', 'tennis when:2d', 'F1 when:2d', 'badminton when:2d'],
  politics:      ['(Parliament OR Modi OR Supreme Court OR election OR policy) India when:2d'],
};

/** Named city seeds (§5.2). Any other city falls back to CITY_PATTERN. Tag city:<name>. */
export const CITY_QUERIES: Record<string, string> = {
  mumbai:    '"Mumbai" (BMC OR water OR local trains OR civic) when:2d',
  delhi:     '"Delhi" (MCD OR pollution OR civic OR Metro) when:2d',
  bengaluru: '"Bengaluru" (BBMP OR BWSSB OR traffic OR water) when:2d',
  hyderabad: '"Hyderabad" (GHMC OR civic OR Metro) when:2d',
  chennai:   '"Chennai" (civic OR water OR Metro) when:2d',
  pune:      '"Pune" (PMC OR civic OR traffic) when:2d',
};
export const CITY_PATTERN = '"{name}" (civic OR municipal OR water OR transport) when:2d';

/**
 * Named interest seeds (§5.3). Tag interest:<slug>.
 * Standard interests that already map to a shared section (Business, World, …)
 * need NO extra feed — they reuse SECTION_FEEDS.
 */
export const INTEREST_QUERIES: Record<string, string> = {
  ai:          '(artificial intelligence OR AI) (India OR global) when:2d',
  cricket:     'cricket (India OR ICC OR Test OR ODI) when:2d',
  football:    '(football OR FIFA OR "Champions League") when:2d',
  startups:    '(startup OR "venture capital" OR funding) India when:2d',
  climate:     '(climate OR environment OR monsoon OR pollution) India when:2d',
  finance:     '("personal finance" OR mutual funds OR tax OR RBI rates) India when:2d',
  cinema:      '(Bollywood OR OTT OR film release OR streaming) India when:2d',
  geopolitics: '(geopolitics OR foreign policy OR diplomacy) India when:2d',
};
export const INTEREST_PATTERN = '({terms}) India when:2d';

/** Named profession seeds (§5.4). Tag prof:<slug>. */
export const PROFESSION_QUERIES: Record<string, string> = {
  healthcare: '(healthcare OR hospital OR drug approval OR ICMR OR medical) India when:2d',
  legal:      '(Supreme Court OR High Court OR judgment OR legal) India when:2d',
  finance:    '(RBI OR banking OR NPA OR fintech OR UPI) India when:2d',
  tech:       '(IT industry OR software OR layoffs OR hiring OR cloud) India when:2d',
  pharma:     '(pharma OR USFDA OR drug pricing OR clinical trial) India when:2d',
  education:  '(education policy OR NEP OR university OR exam) India when:2d',
  marketing:  '(advertising OR media OR brand OR D2C) India when:2d',
};
export const PROFESSION_PATTERN = '({terms}) India when:2d';

/** A followed story = a persisted query feed (§5.6); capped at 25 active. Tag follow:<storyId>. */
export const FOLLOW_PATTERN = '{terms} when:7d';

export interface MarketTicker { symbol: string; label: string; }
export const MARKET_TICKERS: MarketTicker[] = [
  { symbol: '^BSESN', label: 'Sensex' },
  { symbol: '^NSEI',  label: 'Nifty 50' },
  { symbol: '^DJI',   label: 'Dow Jones' },
  { symbol: '^IXIC',  label: 'Nasdaq' },
];

/**
 * The backbone. `verified` flips to true per row once validate-feeds.cjs PASSes it.
 * Sections drive which shared section an item lands in; tags drive personalisation.
 */
export const SECTION_FEEDS: SectionFeed[] = [
  // ---- The Hindu (T3) ----
  { source: 'The Hindu', tier: 3, url: 'https://www.thehindu.com/news/national/feeder/default.rss',
    sections: ['india', 'major_events'], tags: ['src:thehindu', 'sec:india'], verified: false },
  { source: 'The Hindu', tier: 3, url: 'https://www.thehindu.com/news/international/feeder/default.rss',
    sections: ['world'], tags: ['src:thehindu', 'sec:world'], verified: false },
  { source: 'The Hindu', tier: 3, url: 'https://www.thehindu.com/business/feeder/default.rss',
    sections: ['business'], tags: ['src:thehindu', 'sec:business'], verified: false },
  { source: 'The Hindu', tier: 3, url: 'https://www.thehindu.com/sport/feeder/default.rss',
    sections: ['sport'], tags: ['src:thehindu', 'sec:sport'], verified: false },

  // ---- Indian Express (T3) ----
  { source: 'Indian Express', tier: 3, url: 'https://indianexpress.com/section/india/feed/',
    sections: ['india', 'major_events'], tags: ['src:indianexpress', 'sec:india'], verified: false },
  { source: 'Indian Express', tier: 3, url: 'https://indianexpress.com/section/world/feed/',
    sections: ['world'], tags: ['src:indianexpress', 'sec:world'], verified: false },
  { source: 'Indian Express', tier: 3, url: 'https://indianexpress.com/section/business/feed/',
    sections: ['business'], tags: ['src:indianexpress', 'sec:business'], verified: false },
  { source: 'Indian Express', tier: 3, url: 'https://indianexpress.com/section/technology/feed/',
    sections: ['technology'], tags: ['src:indianexpress', 'sec:tech'], verified: false },

  // ---- Hindustan Times (T3) ----
  { source: 'Hindustan Times', tier: 3, url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml',
    sections: ['india', 'major_events'], tags: ['src:ht', 'sec:india'], verified: false },
  { source: 'Hindustan Times', tier: 3, url: 'https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml',
    sections: ['world'], tags: ['src:ht', 'sec:world'], verified: false },

  // ---- Times of India (T3) ----
  { source: 'Times of India', tier: 3, url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    sections: ['major_events', 'india'], tags: ['src:toi', 'sec:top'], verified: false },
  { source: 'Times of India', tier: 3, url: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms',
    sections: ['world'], tags: ['src:toi', 'sec:world'], verified: false },
  { source: 'Times of India', tier: 3, url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms',
    sections: ['business'], tags: ['src:toi', 'sec:business'], verified: false },

  // ---- NDTV (T3) ----
  { source: 'NDTV', tier: 3, url: 'https://feeds.feedburner.com/ndtvnews-india-news',
    sections: ['india', 'major_events'], tags: ['src:ndtv', 'sec:india'], verified: false },
  { source: 'NDTV', tier: 3, url: 'https://feeds.feedburner.com/ndtvnews-world-news',
    sections: ['world'], tags: ['src:ndtv', 'sec:world'], verified: false },

  // ---- Mint (T2) ----
  { source: 'Mint', tier: 2, url: 'https://www.livemint.com/rss/markets',
    sections: ['business', 'markets_news'], tags: ['src:mint', 'sec:markets'], verified: false },
  { source: 'Mint', tier: 2, url: 'https://www.livemint.com/rss/companies',
    sections: ['business'], tags: ['src:mint', 'sec:business'], verified: false },

  // ---- Business Standard (T2) ----
  { source: 'Business Standard', tier: 2, url: 'https://www.business-standard.com/rss/markets-106.rss',
    sections: ['business', 'markets_news'], tags: ['src:bs', 'sec:markets'], verified: false },

  // ---- Scroll (T2) ----
  { source: 'Scroll', tier: 2, url: 'https://feeds.feedburner.com/ScrollinArticles.rss',
    sections: ['india', 'culture'], tags: ['src:scroll', 'sec:india'], verified: false },

  // ---- Deccan Herald (T3) ----
  { source: 'Deccan Herald', tier: 3, url: 'https://www.deccanherald.com/rss-feed/52',
    sections: ['india'], tags: ['src:dh', 'sec:india'], verified: false },

  // ---- World wires (T3) ----
  { source: 'BBC', tier: 3, url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    sections: ['world', 'major_events'], tags: ['src:bbc', 'sec:world'], verified: false },
  { source: 'BBC', tier: 3, url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
    sections: ['technology'], tags: ['src:bbc', 'sec:tech'], verified: false },
  { source: 'The Guardian', tier: 3, url: 'https://www.theguardian.com/world/rss',
    sections: ['world'], tags: ['src:guardian', 'sec:world'], verified: false },
  { source: 'Al Jazeera', tier: 3, url: 'https://www.aljazeera.com/xml/rss/all.xml',
    sections: ['world'], tags: ['src:aljazeera', 'sec:world'], verified: false },

  // ==== Sprint 15 — dedicated RSS feeds for the whitelist expansion ====
  // (Publishers that offer a real RSS feed. Validate before trusting; any that
  //  fail fall back to a site-scoped Google News feed — see NEW_SOURCE_QUERY_FEEDS.)
  { source: 'The Diplomat', tier: 2, url: 'https://thediplomat.com/feed/',
    sections: ['world'], tags: ['src:diplomat', 'sec:world'], verified: false },
  { source: 'CNN', tier: 2, url: 'http://rss.cnn.com/rss/edition_world.rss',
    sections: ['world', 'major_events'], tags: ['src:cnn', 'sec:world'], verified: false },
  { source: 'Rest of World', tier: 2, url: 'https://restofworld.org/feed/',
    sections: ['technology', 'world'], tags: ['src:restofworld', 'sec:tech'], verified: false },
  { source: 'MIT Technology Review', tier: 2, url: 'https://www.technologyreview.com/feed/',
    sections: ['technology'], tags: ['src:mittr', 'sec:tech'], verified: false },
  { source: 'Medianama', tier: 2, url: 'https://www.medianama.com/feed/',
    sections: ['technology'], tags: ['src:medianama', 'sec:tech'], verified: false },
  { source: 'Mongabay India', tier: 2, url: 'https://india.mongabay.com/feed/',
    sections: ['climate_health', 'india'], tags: ['src:mongabay', 'sec:climate'], verified: false },
  { source: 'Carbon Brief', tier: 2, url: 'https://www.carbonbrief.org/feed/',
    sections: ['climate_health'], tags: ['src:carbonbrief', 'sec:climate'], verified: false },
  { source: 'Alt News', tier: 2, url: 'https://www.altnews.in/feed/',
    sections: ['india', 'major_events'], tags: ['src:altnews', 'sec:india'], verified: false },
  { source: 'Deadline', tier: 2, url: 'https://deadline.com/feed/',
    sections: ['culture'], tags: ['src:deadline', 'sec:entertainment'], verified: false },
];

/**
 * Coverage gaps the build plan flags to lean on query feeds (§5.1 notes):
 *   - Reuters / AP: WIRE_FEEDS above.
 *   - climate_health: weak dedicated publisher feeds -> query feeds + the
 *     Sprint 15 climate sources (Mongabay, Carbon Brief, Dialogue Earth, IndiaSpend).
 *   - sport / culture breadth: reinforced by DESK_QUERIES + interest queries.
 *
 * Sources added to the whitelist for VARIETY but without a dedicated feed
 * (they appear via the normal personalisation search): The Lancet (research
 * journal), Sportstar (already covered as thehindu.com), Mathrubhumi, Eenadu,
 * Sakshi, Daily Thanthi, Deccan Chronicle, EastMojo, Gujarat Samachar
 * (regional — surfaced through the city query feeds + REGIONAL_BY_CITY).
 */
