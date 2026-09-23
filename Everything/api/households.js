import { getSupabaseServerClient } from './lib/supabase.js';

export default async function handler(req, res) {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase server configuration is missing.' });
  }

  if (req.method === 'GET') {
    const { user_id, id } = req.query || {};

    if (id) {
      const { data, error } = await supabase
        .from('households')
        .select('*')
        .eq('id', id)
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ household: data });
    }

    if (user_id) {
      const { data: memberships, error: membershipError } = await supabase
        .from('household_members')
        .select('household_id, role')
        .eq('user_id', user_id);

      if (membershipError) return res.status(500).json({ error: membershipError.message });

      const householdIds = (memberships || []).map((row) => row.household_id);
      const { data: households, error: householdError } = await supabase
        .from('households')
        .select('*')
        .in('id', householdIds.length ? householdIds : ['00000000-0000-0000-0000-000000000000']);

      if (householdError) return res.status(500).json({ error: householdError.message });
      return res.status(200).json({ households: households || [] });
    }

    const { data, error } = await supabase.from('households').select('*');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ households: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const userId = body.user_id || body.userId;
    if (!userId) return res.status(400).json({ error: 'user_id is required.' });

    const providedInviteCode = String(body.invite_code || body.inviteCode || '').trim();

    if (providedInviteCode) {
      const { data: household, error: householdError } = await supabase
        .from('households')
        .select('*')
        .eq('invite_code', providedInviteCode)
        .single();

      if (householdError || !household) {
        return res.status(404).json({ error: 'Invite code not found.' });
      }

      const { data: membership, error: memberError } = await supabase
        .from('household_members')
        .upsert(
          { household_id: household.id, user_id: userId, role: body.role || 'member' },
          { onConflict: 'household_id,user_id' },
        )
        .select()
        .single();

      if (memberError) return res.status(500).json({ error: memberError.message });
      return res.status(200).json({ household, membership, joined: true });
    }

    const payload = {
      name: String(body.name || 'My Household').trim() || 'My Household',
      invite_code: cryptoRandomCode(),
      created_by: userId,
      created: Date.now(),
    };

    const { data, error } = await supabase
      .from('households')
      .insert([payload])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const { error: memberError } = await supabase
      .from('household_members')
      .insert({ household_id: data.id, user_id: userId, role: 'owner' });

    if (memberError) return res.status(500).json({ error: memberError.message });
    return res.status(201).json({ household: data });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'household id is required.' });

    const payload = {
      name: body.name ? String(body.name).trim() : undefined,
      invite_code: body.invite_code !== undefined ? String(body.invite_code).trim() || null : undefined,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('households')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ household: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function cryptoRandomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
