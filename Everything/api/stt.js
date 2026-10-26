import { requireUser } from './lib/auth.js';

// Speech-to-Text endpoint. Accepts an audio file and returns the transcript.
// Uses Whisper (OpenAI or Groq) if API keys are configured, otherwise falls back to
// on-device Whisper response telling the client to transcribe locally.

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const form = await req.formData();
    const file = form.get('audio');
    if (!file || !(file instanceof Blob)) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const mime = file.type || 'audio/webm';

    // Try Groq Whisper first (free tier, good quality)
    if (process.env.GROQ_API_KEY) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            file: base64,
            model: process.env.GROQ_STT_MODEL || 'whisper-large-v3',
            response_format: 'json',
            language: null,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          return res.status(200).json({ ok: true, transcript: data.text });
        }
      } catch (err) {
        console.error('Groq STT failed:', err.message);
      }
    }

    // Try OpenAI Whisper (also free tier)
    if (process.env.OPENAI_API_KEY) {
      try {
        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            file: base64,
            model: process.env.OPENAI_STT_MODEL || 'whisper-1',
            response_format: 'json',
            language: null,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          return res.status(200).json({ ok: true, transcript: data.text });
        }
      } catch (err) {
        console.error('OpenAI STT failed:', err.message);
      }
    }

    // No API keys configured: return fallback response telling the client to use on-device STT
    return res.status(200).json({
      ok: true,
      fallback: true,
      message: 'STT API keys not configured. Use on-device Whisper instead.',
    });
  } catch (error) {
    console.error('STT endpoint error:', error);
    return res.status(500).json({ error: 'STT processing failed' });
  }
}
