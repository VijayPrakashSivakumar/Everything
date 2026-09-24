import { requireUser } from './lib/auth.js';

export default async function handler(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { query, items } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Missing query' });

  const context = (items || []).slice(0, 60)
    .map(i => `- [${i.kind}${i.priority ? '/' + i.priority : ''}] ${i.title}${i.sub ? ': ' + i.sub : ''}${i.person ? ' (person: ' + i.person + ')' : ''}${i.due ? ' (due: ' + i.due + ')' : ''}`)
    .join('\n');

  const prompt = `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Be concise (2-4 sentences), specific, and reference relevant items by name. If nothing in the context is relevant, say so briefly.\n\nCaptured items:\n${context}\n\nQuestion: ${query}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || 'No answer returned.';
    res.status(200).json({ answer: text });
  } catch (err) {
    res.status(500).json({ error: 'AI request failed' });
  }
}