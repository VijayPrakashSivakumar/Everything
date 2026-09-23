import { getSupabaseServerClient } from './lib/supabase.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const envStatus = {
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_ANON_KEY: Boolean(process.env.SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    NODE_ENV: process.env.NODE_ENV || 'development',
  };

  let databaseReady = false;
  const supabase = getSupabaseServerClient();
  if (supabase) {
    try {
      const { error } = await supabase.from('households').select('id').limit(1);
      databaseReady = !error;
    } catch (error) {
      databaseReady = false;
    }
  }

  const ready =
    envStatus.SUPABASE_URL &&
    envStatus.SUPABASE_SERVICE_ROLE_KEY &&
    databaseReady;

  return res.status(200).json({
    ok: true,
    app: 'Everything',
    phase: 'foundation',
    message: ready
      ? 'Foundation backend is ready. AI search is optional.'
      : 'Supabase backend configuration is incomplete.',
    envStatus,
    ready,
    databaseReady,
    aiAvailable: envStatus.ANTHROPIC_API_KEY,
    timestamp: new Date().toISOString(),
  });
}
