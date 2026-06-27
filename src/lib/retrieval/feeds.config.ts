/**
 * feeds.config.ts — Morning Brief feed manifest.
 *
 * Two flavours of feed (build-plan §3.1):
 *   SECTION_FEEDS = publisher-curated streams = the standard-coverage backbone.
 *   QUERY_*       = Google News RSS turns any search into a live feed = the
 *                   personalisation engine (cities / interests / professions / desks / follows).
 *
 * Phase 0 rule: every SECTION_FEEDS entry must PASS validation before Phase 1.
 * Any FAIL -> drop it, or replace with a publisher that has working RSS.
 *
 * Tags carried into the shared pool are exactly what the existing deterministic
 * personaliser (scoreStory) keys off — do NOT rename a tag without updating it.
 *
 * ── Sprint 21 (2026-06-27) ───────────────────────────────────────────────────
 * The gtest diagnostic proved Google News /articles/ links no longer resolve to
 * the real publisher (opaque token → 200 JS shell, never a redirect), so every
 * item from a Google-News query feed was being dropped as `nolink`. The entire
 * wire/specialist tier therefore fetched ZERO for several sprints.
 *
 * Fix: the wire/specialist sources that have real publisher RSS were moved to
 * SECTION_FEEDS (validated live from Vercel's IP via the feedcheck route — which
 * supersedes the old home-IP validate-feeds.cjs because it catches data-centre-IP
 * blocks like Business Standard's 403). Sources with no usable RSS were dropped.
 * WIRE_FEEDS and NEW_SOURCE_QUERY_FEEDS are now empty (see note there).
 *
 * STILL OPEN (Sprint 22): the personalisation query feeds below — CITY_QUERIES,
 * INTEREST_QUERIES, PROFESSION_QUERIES, DESK_QUERIES, FOLLOW_PATTERN — all build
 * Google-News URLs via googleNewsFeed() and are subject to the SAME `nolink`
 * failure. Any personalisation path that fetches through them is silently empty.
 * Verify and migrate them (direct RSS where possible, else Perplexity) next.
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
  verified: boolean; // set true once it PASSes validation
}

/** Google News RSS — India English locale. Interpolate an encoded q-value. */
export const GOOGLE_NEWS_BASE =
  'https://news.google.com/rss/search?q={q}&hl=en-IN&gl=IN&ceid=IN:en';

export function googleNewsFeed(q: string): string {
  return GOOGLE_NEWS_BASE.replace('{q}', encodeURIComponent(q));
}

// ⚠ Sprint 21: anything fetched through googleNewsFeed() currently yields
// `nolink` drops (Google's /articles/ token no longer decodes). The shared
// editions no longer use it (see SECTION_FEEDS). The personalisation feeds below
// still do — migrate them off Google News in Sprint 22.

export type QueryKind = 'wire' | 'city' | 'interest' | 'profession' | 'desk' | 'follow' | 'source';

export interface QueryTemplate {
  kind: QueryKind;
  /** tag-slug pattern; {name}/{slug}/{storyId} filled at build time */
  slug: string;
  /** Google News q= value; {name}/{terms} filled at build time */
  q: string;
  tags: string[];
}

/**
 * Sprint 21 — EMPTIED. WIRE_FEEDS (Reuters, AP) and NEW_SOURCE_QUERY_FEEDS (AFP,
 * SCMP, Nikkei, The Ken, TMC, NDTV Profit, Fortune India, CNBC, Dialogue Earth,
 * IndiaSpend, BOOM, The Athletic) were Google-News site-scoped query feeds for the
 * wire/specialist tier. They all returned items but every item dropped as `nolink`
 * (Google link format change — see header). Resolution by source:
 *   - Have real RSS  → moved to SECTION_FEEDS: CNBC, SCMP, Nikkei, Fortune India,
 *                      Dialogue Earth, BOOM.
 *   - No usable RSS  → dropped: Reuters, AP, AFP, The Ken, The Morning Context,
 *                      The Athletic (paywalled/discontinued); NDTV Profit + IndiaSpend
 *                      (RSS path 404s as tested).
 * Kept as empty exports so importers in rss-retrieval.ts don't break. To bring a
 * wire source back: add it to SECTION_FEEDS if it gains RSS, or route the tier
 * through a news API (Sprint 22 decision if world coverage still shows a gap).
 */
export const WIRE_FEEDS: QueryTemplate[] = [];
export const NEW_SOURCE_QUERY_FEEDS: QueryTemplate[] = [];

/** The 6 live desks as fixed query bundles (§5.5); SECTION_FEEDS supply the rest. */
// ⚠ Sprint 21: these run via googleNewsFeed() → currently `nolink`. Migrate Sprint 22.
export const DESK_QUERIES: Record<string, string[]> = {
  markets:       ['(Sensex OR Nifty OR rupee OR FII) when:1d'],
  business:      ['(earnings OR M&A OR IPO OR results) India when:2d'],
  tech:          ['(AI OR chips OR cybersecurity OR big tech OR data centre) when:2d'],
  entertainment: ['(Bollywood OR OTT OR box office OR music OR film) India when:2d'],
  sport:         ['cricket when:2d', 'football when:2d', 'tennis when:2d', 'F1 when:2d', 'badminton when:2d'],
  politics:      ['(Parliament OR Modi OR Supreme Court OR election OR policy) India when:2d'],
};

/** Named city seeds (§5.2). Any other city falls back to CITY_PATTERN. Tag city:<name>. */
// ⚠ Sprint 21: via googleNewsFeed() → currently `nolink`. Migrate Sprint 22.
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
// ⚠ Sprint 21: via googleNewsFeed() → currently `nolink`. Migrate Sprint 22.
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
// ⚠ Sprint 21: via googleNewsFeed() → currently `nolink`. Migrate Sprint 22.
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
// ⚠ Sprint 21: via googleNewsFeed() → currently `nolink`. Migrate Sprint 22.
export const FOLLOW_PATTERN = '{terms} when:7d';

export interface MarketTicker { symbol: string; label: string; }
export const MARKET_TICKERS: MarketTicker[] = [
  { symbol: '^BSESN', label: 'Sensex' },
  { symbol: '^NSEI',  label: 'Nifty 50' },
  { symbol: '^DJI',   label: 'Dow Jones' },
  { symbol: '^IXIC',  label: 'Nasdaq' },
];

/**
 * The backbone. `verified` flips to true per row once validation PASSes it.
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
  // Sprint 21: markets-106.rss confirmed 403 (data-centre-IP block) from Vercel —
  // removed. Business Standard still passes the whitelist, so its stories surface
  // via other feeds/Perplexity; a dedicated BS feed needs a fetch relay (Sprint 22).

  // ---- Scroll (T2) ----
  { source: 'Scroll', tier: 2, url: 'https://feeds.feedburner.com/ScrollinArticles.rss',
    sections: ['india', 'culture'], tags: ['src:scroll', 'sec:india'], verified: false },

  // ---- Deccan Herald (T3) ----
  // Sprint 21: /rss-feed/52 confirmed 404 — repaired to the working /stories.rss
  // (resolves from /feed; 34 items, on-domain links; validated from Vercel).
  { source: 'Deccan Herald', tier: 3, url: 'https://www.deccanherald.com/stories.rss',
    sections: ['india'], tags: ['src:dh', 'sec:india'], verified: true },

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
    sections: ['climate_health'], tags: ['src:mongabay', 'sec:climate'], verified: false },
  { source: 'Carbon Brief', tier: 2, url: 'https://www.carbonbrief.org/feed/',
    sections: ['climate_health'], tags: ['src:carbonbrief', 'sec:climate'], verified: false },
  { source: 'Alt News', tier: 2, url: 'https://www.altnews.in/feed/',
    sections: ['india', 'major_events'], tags: ['src:altnews', 'sec:india'], verified: false },
  { source: 'Deadline', tier: 2, url: 'https://deadline.com/feed/',
    sections: ['culture'], tags: ['src:deadline', 'sec:entertainment'], verified: false },

  // ==== Sprint 15.1 — reliable "floor" feeds for thin/empty sections ====
  // These publishers are confirmed to answer from Vercel's data-centre IP, so
  // they keep sport / business / climate_health from going empty when the
  // slower or bot-blocked specialist feeds don't respond. India-first where
  // a section feed exists (IE Sport); broad wires (BBC, Guardian) as backstop.
  { source: 'Indian Express', tier: 3, url: 'https://indianexpress.com/section/sports/feed/',
    sections: ['sport'], tags: ['src:indianexpress', 'sec:sport'], verified: false },
  { source: 'BBC', tier: 3, url: 'https://feeds.bbci.co.uk/sport/rss.xml',
    sections: ['sport'], tags: ['src:bbc', 'sec:sport'], verified: false },
  { source: 'BBC', tier: 3, url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    sections: ['business'], tags: ['src:bbc', 'sec:business'], verified: false },
  { source: 'The Guardian', tier: 3, url: 'https://www.theguardian.com/environment/rss',
    sections: ['climate_health'], tags: ['src:guardian', 'sec:climate'], verified: false },

  // ==== Sprint 21 — wire/specialist tier moved to DIRECT RSS ====
  // Relocated off the dead Google-News query lane (see WIRE_FEEDS note). Every URL
  // below returned HTTP 200 + parseable items with on-domain article links when
  // tested live from Vercel's IP on 2026-06-27 (feedcheck) — verified:true.
  { source: 'CNBC', tier: 2, url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html',
    sections: ['world', 'business'], tags: ['src:cnbc', 'sec:world'], verified: true },
  { source: 'South China Morning Post', tier: 2, url: 'https://www.scmp.com/rss/4/feed',
    sections: ['world'], tags: ['src:scmp', 'sec:world'], verified: true },
  { source: 'Nikkei Asia', tier: 2, url: 'https://asia.nikkei.com/rss/feed/nar',
    sections: ['world', 'business'], tags: ['src:nikkei', 'sec:world'], verified: true },
  { source: 'Fortune India', tier: 2, url: 'https://www.fortuneindia.com/stories.rss',
    sections: ['business'], tags: ['src:fortuneindia', 'sec:business'], verified: true },
  { source: 'Dialogue Earth', tier: 2, url: 'https://dialogue.earth/en/feed/',
    sections: ['climate_health'], tags: ['src:dialogue', 'sec:climate'], verified: true },
  { source: 'BOOM', tier: 2, url: 'https://www.boomlive.in/feed',
    sections: ['india'], tags: ['src:boom', 'sec:india'], verified: true },
];

/**
 * Coverage notes (Sprint 21):
 *   - World/business wire tier now fetched via DIRECT RSS (CNBC, SCMP, Nikkei,
 *     plus existing CNN/Diplomat) instead of the dead Google lane.
 *   - climate_health (the thinnest section): Mongabay, Carbon Brief, Dialogue Earth,
 *     plus the Guardian environment floor.
 *   - Reuters / AP / AFP: DROPPED (no public RSS). If a world-coverage gap persists
 *     after these feeds land, the cleanest recovery is a news API for the wire tier
 *     only — decide in Sprint 22 against fresh coverage numbers.
 *   - Sources whitelisted for VARIETY but without a dedicated feed (surfaced via
 *     personalisation search): The Lancet, Mathrubhumi, Eenadu, Sakshi, Daily
 *     Thanthi, Deccan Chronicle, EastMojo, Gujarat Samachar (regional — via city
 *     query feeds + REGIONAL_BY_CITY, once those are migrated off Google News).
 */
