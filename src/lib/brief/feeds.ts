// src/lib/brief/feeds.ts
//
// One import surface for the rebuilt pipeline. It re-exports the carried manifest
// from its existing location (feeds.config.ts does NOT move — absolute path) and
// adds the city / interest feed registries lifted verbatim from the retired
// tails.ts. After this, tails.ts can be deleted.
//
// Everything config.ts / dedupe.ts / clustering.ts read (INTEREST_SECTIONS,
// PROFESSION_SECTIONS, citySlug, cityFeed, Section, SECTION_FEEDS,
// googleNewsFeed, …) comes through the re-export below; CITY_FEEDS / INTEREST_FEEDS
// are added here.

export * from '@/lib/retrieval/feeds.config';

// ── City feed helpers + registry (verbatim from tails.ts) ────────────────────
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

// Non-standard interests only (interests that map to a standard section are
// served from the major pool by keyword). Topics with no confident whitelisted
// feed are omitted → that interest is simply drawn from the pool, never faked.
// This is the D6 expansion point: add tier-2/3 cities and more interest feeds here.
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
