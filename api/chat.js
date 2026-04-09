/**
 * Vercel Serverless Function — /api/chat
 *
 * Proxies requests to OpenAI Chat Completions so the API key
 * stays safely server-side.
 *
 * Environment Variable (set in Vercel Project Settings → Environment Variables):
 *   Name:  OPENAI_API_KEY
 *   Value: sk-...  (your OpenAI API key)
 */

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'OpenAI API key not configured. Please set the OPENAI_API_KEY environment variable in your Vercel project settings.',
    });
  }

  try {
    const { messages, model = 'gpt-4o-mini', max_tokens = 600, temperature = 0.7 } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid request: messages array required' });
    }

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens, temperature }),
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      const errMsg = data?.error?.message || `OpenAI API error ${openaiRes.status}`;
      return res.status(openaiRes.status).json({ error: errMsg });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('Chat API error:', err);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
}
