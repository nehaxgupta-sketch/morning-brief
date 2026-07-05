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

// ════════════════════════════════════════════════════════════════════════════
// Sprint 22 — UNIFIED section model (no "standard" vs "personalised" backend).
//
// A section is just: a SELECTOR over the one RSS pool + a label/icon + a
// 'why it matters' framing. "Standard" = preselected for everyone, general
// framing. "Personalised" = user-chosen, personal framing. Same fetch, cluster,
// dedup, precedence, floor budget. Perplexity (URL hallucinations) and Google
// News (nolink) are both retired here.
//
// Three selector kinds — most personalisation is a SELECTOR over the pool we
// already fetch (no extra feed); only cities (hyperlocal) and a couple of niche
// topics carry their own RSS feed:
//   • section  → pull from a standard section's slice of the pool (its sec: tag)
//   • feedTag  → pull items carrying a dedicated feed's tag (e.g. interest:startups)
//   • keywords → match the pool on these terms (spans sections; e.g. "AI")
// A def may combine them; the consumer (generate-brief) unions the matches.
// ════════════════════════════════════════════════════════════════════════════

export interface PersonalSectionDef {
  label: string;
  icon: string;
  section?: Section;   // pool-selector: this standard section's items
  feedTag?: string;    // dedicated-feed selector: items carrying this tag
  keywords?: string[]; // keyword selector over the pool (lowercased contains-match)
  why: string;         // 'why it matters' framing hint passed to the writer
}

// ── Cities — validated IE pattern (pfeedcheck 2026-06-28): all metros 200 items,
//    on-domain links. cityFeed(city) → the IE city RSS; unknown cities fall back
//    to their slug, and (at fetch) to REGIONAL_BY_CITY mastheads if IE lacks them.
const IE_CITY_SLUG: Record<string, string> = {
  bengaluru: 'bangalore', bangalore: 'bangalore', bombay: 'mumbai', mumbai: 'mumbai',
  'new delhi': 'delhi', delhi: 'delhi', ncr: 'delhi', 'delhi / ncr': 'delhi',
  calcutta: 'kolkata', kolkata: 'kolkata', madras: 'chennai', chennai: 'chennai',
  pune: 'pune', hyderabad: 'hyderabad', ahmedabad: 'ahmedabad', lucknow: 'lucknow',
  jaipur: 'jaipur', chandigarh: 'chandigarh',
};
export function citySlug(city: string): string {
  const key = String(city || '').trim().toLowerCase();
  return IE_CITY_SLUG[key] || key.replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
}
export function cityFeed(city: string): string {
  return `https://indianexpress.com/section/cities/${citySlug(city)}/feed/`;
}

// ── Interests — keyed by the display name the user picks (a fixed taxonomy). ──
export const INTEREST_SECTIONS: Record<string, PersonalSectionDef> = {
  'Business & Economy':       { label: 'Business & Economy', icon: '💼', section: 'business', why: 'how it moves the economy, companies, and prices' },
  'Markets & Investing':      { label: 'Markets & Investing', icon: '📈', section: 'markets_news', feedTag: 'sec:markets', why: 'what it means for your portfolio and savings' },
  'Technology':               { label: 'Technology', icon: '💻', section: 'technology', why: 'how the tech shift reshapes work and daily life' },
  'Artificial Intelligence':  { label: 'AI & Technology', icon: '🤖', section: 'technology', keywords: ['ai', 'artificial intelligence', 'llm', 'openai', 'anthropic', 'machine learning', 'chip', 'semiconductor', 'data centre', 'data center'], why: 'where AI is actually landing, beyond the hype' },
  'Science':                  { label: 'Science & Tech', icon: '🔬', section: 'technology', keywords: ['research', 'study', 'scientists', 'space', 'isro', 'discovery', 'physics', 'biology'], why: 'the science worth understanding this week' },
  'Environment & Climate':    { label: 'Climate', icon: '🌱', section: 'climate_health', why: 'the climate and environment stakes for India' },
  'Health & Wellness':        { label: 'Health', icon: '🩺', section: 'climate_health', keywords: ['health', 'hospital', 'disease', 'medical', 'drug', 'vaccine', 'mental health'], why: 'what it means for your health and care' },
  'Sport':                    { label: 'Sport', icon: '🏏', section: 'sport', why: "the day's results and what they set up" },
  'Cricket':                  { label: 'Cricket & Sport', icon: '🏏', section: 'sport', keywords: ['cricket', 'bcci', 'icc', 'test', 'odi', 't20', 'ipl', 'ranji'], why: "the cricket that matters, plus the day's sport" },
  'Football':                 { label: 'Football & Sport', icon: '⚽', section: 'sport', keywords: ['football', 'fifa', 'premier league', 'isl', 'champions league', 'la liga'], why: 'football news, plus the wider sport day' },
  'Formula 1':                { label: 'F1 & Sport', icon: '🏎️', section: 'sport', keywords: ['formula 1', 'f1', 'grand prix', 'verstappen', 'mclaren', 'ferrari'], why: 'the F1 picture, plus the wider sport day' },
  'Culture & Arts':           { label: 'Culture & Arts', icon: '🎭', section: 'culture', why: 'the culture conversation worth following' },
  'Film & OTT':               { label: 'Film & OTT', icon: '🎬', section: 'culture', keywords: ['film', 'movie', 'ott', 'netflix', 'bollywood', 'box office', 'streaming', 'series'], why: "what's worth watching and why it matters" },
  'Music':                    { label: 'Music', icon: '🎵', section: 'culture', keywords: ['music', 'album', 'concert', 'song', 'singer', 'band'], why: 'the music news worth your time' },
  'Books & Literature':       { label: 'Books', icon: '📚', section: 'culture', keywords: ['book', 'author', 'novel', 'literature', 'publishing', 'writer'], why: 'books and ideas worth knowing about' },
  'World Affairs':            { label: 'World', icon: '🌍', section: 'world', why: 'the global shifts that reach India' },
  'Indian Politics':          { label: 'Politics & Policy', icon: '🏛️', section: 'india', keywords: ['parliament', 'modi', 'election', 'bjp', 'congress', 'policy', 'supreme court', 'cabinet'], why: 'the politics and policy that affect you' },
  'Startups':                 { label: 'Startups', icon: '🚀', feedTag: 'interest:startups', keywords: ['startup', 'funding', 'venture capital', 'seed', 'series a', 'unicorn', 'founder'], why: 'the startup moves shaping the ecosystem' },
  'Geopolitics':              { label: 'Geopolitics', icon: '🗺️', section: 'world', keywords: ['geopolitics', 'diplomacy', 'foreign policy', 'sanctions', 'border', 'treaty', 'summit', 'tariff'], why: 'the power shifts and what they mean for India' },
  'Personal Finance':         { label: 'Personal Finance', icon: '💰', section: 'business', keywords: ['mutual fund', 'tax', 'savings', 'loan', 'emi', 'rbi rate', 'upi', 'insurance', 'fd'], why: 'the money decisions this affects' },
};

// ── Professions — keyed by the profession value on the profile. ──
export const PROFESSION_SECTIONS: Record<string, PersonalSectionDef> = {
  healthcare: { label: 'Healthcare', icon: '🩺', section: 'climate_health', keywords: ['hospital', 'drug', 'icmr', 'medical', 'health', 'clinical', 'pharma', 'usfda', 'patient'], why: 'for healthcare professionals — practice, policy, and pipeline' },
  legal:      { label: 'Law & Courts', icon: '⚖️', feedTag: 'prof:legal', keywords: ['supreme court', 'high court', 'judgment', 'legal', 'bench', 'litigation', 'bar council', 'verdict'], why: 'for legal professionals — judgments and the practice of law' },
  finance:    { label: 'Finance', icon: '🏦', section: 'business', keywords: ['rbi', 'banking', 'npa', 'fintech', 'upi', 'sebi', 'nbfc', 'bond', 'liquidity'], why: 'for finance professionals — rates, regulation, and flows' },
  tech:       { label: 'Tech Industry', icon: '💻', section: 'technology', keywords: ['it industry', 'software', 'layoffs', 'hiring', 'cloud', 'saas', 'startup', 'developer'], why: 'for tech professionals — the industry and the work' },
  pharma:     { label: 'Pharma', icon: '💊', section: 'climate_health', keywords: ['pharma', 'usfda', 'drug pricing', 'clinical trial', 'api', 'generics', 'biotech'], why: 'for pharma professionals — approvals, pricing, and trials' },
  education:  { label: 'Education', icon: '🎓', section: 'india', keywords: ['education', 'nep', 'university', 'exam', 'ugc', 'school', 'college', 'iit'], why: 'for education professionals — policy and the sector' },
  marketing:  { label: 'Marketing & Media', icon: '📣', section: 'business', keywords: ['advertising', 'media', 'brand', 'd2c', 'marketing', 'campaign', 'agency'], why: 'for marketing professionals — brands, media, and spend' },
};

// City 'why it matters' framing is generic (per resident); the writer fills the city name.
export const CITY_WHY = 'how this affects daily life — commute, costs, civic services — for a {city} resident';

// ── RETIRED (Sprint 22): the Google-News query templates. Personalisation is now
//    RSS + pool-selectors (above). Kept as empty exports so importers don't break;
//    remove once nothing reads them (Stages 2–4). ─────────────────────────────
export const DESK_QUERIES: Record<string, string[]> = {};
export const CITY_QUERIES: Record<string, string> = {};
export const CITY_PATTERN = '';
export const INTEREST_QUERIES: Record<string, string> = {};
export const INTEREST_PATTERN = '';
export const PROFESSION_QUERIES: Record<string, string> = {};
export const PROFESSION_PATTERN = '';
export const FOLLOW_PATTERN = '{terms} when:7d'; // follows TBD in the unified model

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

  // ==== Sprint 26 (F5) — India-entertainment feeds for the Bollywood desk ====
  // The Bollywood & Entertainment desk had ONE ent feed (Deadline, US trade), so
  // the search model kept inventing citations to legit-but-unfed India outlets
  // that then died at the whitelist gate (8/8 dropped, 2 empty sections). These
  // three add real India film-trade URLs to the pool so the desk can SELECT from
  // whitelisted sources instead of padding. Each follows the SAME per-publisher
  // URL pattern already proven for that source's other feeds above (IE
  // /section/<x>/feed/, Hindu /<x>/feeder/default.rss, HT /feeds/rss/<x>/rssfeed.xml),
  // so they are the highest-probability-to-resolve options — but every URL is
  // unverified: VALIDATE LIVE FROM VERCEL (feedcheck) before trusting, and flip
  // verified:true per row once it returns HTTP 200 + parseable on-domain items.
  { source: 'Indian Express', tier: 3, url: 'https://indianexpress.com/section/entertainment/feed/',
    sections: ['culture'], tags: ['src:indianexpress', 'sec:entertainment'], verified: false },
  { source: 'The Hindu', tier: 3, url: 'https://www.thehindu.com/entertainment/feeder/default.rss',
    sections: ['culture'], tags: ['src:thehindu', 'sec:entertainment'], verified: false },
  { source: 'Hindustan Times', tier: 3, url: 'https://www.hindustantimes.com/feeds/rss/entertainment/rssfeed.xml',
    sections: ['culture'], tags: ['src:ht', 'sec:entertainment'], verified: false },

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

  // ==== Sprint 22 — niche personalisation feeds (validated 2026-06-28, pfeedcheck) ====
  // They carry interest:/prof: tags the personalisation selectors pull on, and
  // also enrich the shared pool's business/india/markets slices.
  { source: 'Inc42', tier: 2, url: 'https://inc42.com/feed/',
    sections: ['business', 'technology'], tags: ['src:inc42', 'interest:startups', 'sec:business'], verified: true },
  { source: 'YourStory', tier: 2, url: 'https://yourstory.com/feed',
    sections: ['business'], tags: ['src:yourstory', 'interest:startups', 'sec:business'], verified: true },
  { source: 'Bar & Bench', tier: 2, url: 'https://www.barandbench.com/feed',
    sections: ['india'], tags: ['src:barandbench', 'prof:legal', 'interest:legal', 'sec:india'], verified: true },
  { source: 'Moneycontrol', tier: 2, url: 'https://www.moneycontrol.com/rss/latestnews.xml',
    sections: ['business', 'markets_news'], tags: ['src:moneycontrol', 'sec:markets'], verified: true },
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
