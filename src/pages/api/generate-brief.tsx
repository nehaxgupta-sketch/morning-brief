import type { NextApiRequest, NextApiResponse } from 'next';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function fetchNewsFromOpenAI() {
  const prompt = `You are a news editor. Search the web and summarise today's top stories across these categories. Return ONLY a JSON object, no markdown, no backticks, no extra text.

Return this exact structure:
{
  "world": [
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" }
  ],
  "india": [
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" }
  ],
  "markets": {
    "summary": "2-3 sentence overview of markets today",
    "indices": [
      { "name": "Sensex", "change": "+0.4%" },
      { "name": "Nifty", "change": "-0.1%" },
      { "name": "S&P 500", "change": "+0.6%" },
      { "name": "Nasdaq", "change": "+1.1%" }
    ]
  },
  "sport": { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
  "culture": { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" }
}

Use only real news from today. Be factual and neutral.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: prompt,
    }),
  });

  const data = await response.json();
  console.log('OpenAI raw response:', JSON.stringify(data));
  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) throw new Error(`No response from OpenAI. Raw: ${JSON.stringify(data)}`);

  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    console.log('Fetching news from OpenAI...');
    const rawStories = await fetchNewsFromOpenAI();
    console.log('News fetched successfully');
    return res.status(200).json({ success: true, rawStories });
  } catch (error: any) {
    console.error('Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}