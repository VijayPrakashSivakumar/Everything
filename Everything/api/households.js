import { requireHouseholdMembership, requireUser } from './lib/auth.js';

const fail = (res, code, error) => res.status(code).json({ error: error || 'Request failed.' });

export default async function handler(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { supabase, user } = auth;
  const query = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (req.method === 'GET') {
    if (query.id) {
      const access = await requireHouseholdMembership(supabase, user.id, query.id);
      if (access.error) return fail(res, access.status, access.error);
      const result = await supabase.from('households').select('*').eq('id', query.id).maybeSingle();
      if (result.error) return fail(res, 500, result.error.message);
      if (!result.data) return fail(res, 404, 'Household not found.');
      return res.status(200).json({ household: result.data });
    }
    const memberships = await supabase.from('household_members').select('household_id').eq('user_id', user.id);
    if (memberships.error) return fail(res, 500, memberships.error.message);
    const ids = (memberships.data || []).map((row) => row.household_id);
    if (!ids.length) return res.status(200).json({ households: [] });
    const result = await supabase.from('households').select('*').in('id', ids);
    if (result.error) return fail(res, 500, result.error.message);
    return res.status(200).json({ households: result.data || [] });
  }

  if (req.method === 'POST') {
    const inviteCode = String(body.invite_code || body.inviteCode || '').trim();
    if (inviteCode) {
      const found = await supabase.from('households').select('*').eq('invite_code', inviteCode).maybeSingle();
      if (found.error) return fail(res, 500, found.error.message);
      if (!found.data) return fail(res, 404, 'Invite code not found.');
      const membership = await supabase.from('household_members').upsert(
        { household_id: found.data.id, user_id: user.id, role: 'member' },
        { onConflict: 'household_id,user_id' },
      ).select().single();
      if (membership.error) return fail(res, 500, membership.error.message);
      return res.status(200).json({ household: found.data, membership: membership.data, joined: true });
    }
    const payload = {
      name: String(body.name || 'My Household').trim() || 'My Household',
      invite_code: Math.random().toString(36).slice(2, 8).toUpperCase(),
      created_by: user.id,
      created: Date.now(),
    };
    const created = await supabase.from('households').insert([payload]).select().single();
    if (created.error) return fail(res, 500, created.error.message);
    const membership = await supabase.from('household_members').insert({ household_id: created.data.id, user_id: user.id, role: 'owner' });
    if (membership.error) {
      await supabase.from('households').delete().eq('id', created.data.id);
      return fail(res, 500, membership.error.message);
    }
    return res.status(201).json({ household: created.data });
  }

  if (req.method === 'PUT') {
    const id = body.id;
    if (!id) return fail(res, 400, 'household id is required.');
    const access = await requireHouseholdMembership(supabase, user.id, id);
    if (access.error) return fail(res, access.status, access.error);
    if (!['owner', 'admin'].includes(access.membership.role)) {
      return fail(res, 403, 'Only an owner or admin can update household settings.');
    }
    const payload = {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      invite_code: body.invite_code !== undefined ? (String(body.invite_code).trim() || null) : undefined,
      updated_at: new Date().toISOString(),
    };
    const updated = await supabase.from('households').update(payload).eq('id', id).select().single();
    if (updated.error) return fail(res, 500, updated.error.message);
    return res.status(200).json({ household: updated.data });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
