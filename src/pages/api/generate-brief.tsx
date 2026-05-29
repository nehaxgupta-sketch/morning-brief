import type { NextApiRequest, NextApiResponse } from 'next';

const GEMINI_API_KEY = process.env.GOOGLE_AI_API_KEY;

async function fetchNewsFromGemini() {
  const prompt = `You are a news editor. Fetch and summarise today's top stories across these categories. Return ONLY a JSON object, no markdown, no backticks, no extra text.

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

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      }),
    }
  );

  const data = await response.json();
  console.log('Gemini raw response:', JSON.stringify(data));
const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
if (!text) throw new Error(`No response from Gemini. Raw: ${JSON.stringify(data)}`);

  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    console.log('Fetching news from Gemini...');
    const rawStories = await fetchNewsFromGemini();
    console.log('News fetched successfully');
    return res.status(200).json({ success: true, rawStories });
  } catch (error: any) {
    console.error('Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}