import { getSupabaseServerClient } from './lib/supabase.js';

export default async function handler(req, res) {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase server configuration is missing.' });
  }

  if (req.method === 'GET') {
    const { household_id, user_id } = req.query || {};
    let query = supabase.from('household_members').select('*').order('created_at', { ascending: false });

    if (household_id) query = query.eq('household_id', household_id);
    if (user_id) query = query.eq('user_id', user_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ members: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const householdId = body.household_id || body.householdId;
    const userId = body.user_id || body.userId;
    const role = body.role || 'member';

    if (!householdId || !userId) {
      return res.status(400).json({ error: 'household_id and user_id are required.' });
    }

    const { data, error } = await supabase
      .from('household_members')
      .upsert(
        { household_id: householdId, user_id: userId, role },
        { onConflict: 'household_id,user_id' },
      )
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ membership: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
