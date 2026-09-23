import { getSupabaseServerClient } from './lib/supabase.js';

export default async function handler(req, res) {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase server configuration is missing.' });
  }

  if (req.method === 'GET') {
    const { household_id, user_id } = req.query || {};
    let query = supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (household_id) query = query.eq('household_id', household_id);
    if (user_id) query = query.eq('user_id', user_id);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ projects: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Project name is required.' });

    const payload = {
      household_id: body.household_id || null,
      user_id: body.user_id || null,
      name,
      description: body.description || '',
      status: body.status || 'active',
      metadata: body.metadata || {},
    };

    const { data, error } = await supabase
      .from('projects')
      .insert([payload])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ project: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
