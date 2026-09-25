import { orderNewestFirst, requireHouseholdMembership, requireUser } from './lib/auth.js';

const fail = (res, code, error) => res.status(code).json({ error: error || 'Request failed.' });

export default async function handler(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { supabase, user } = auth;
  const query = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const householdId = query.household_id || query.householdId || body.household_id || body.householdId;
  const access = await requireHouseholdMembership(supabase, user.id, householdId);
  if (access.error) return fail(res, access.status, access.error);

  if (req.method === 'GET') {
    const query = supabase.from('household_members').select('*').eq('household_id', householdId);
    const result = await orderNewestFirst(query, supabase, 'household_members');
    if (result.error) return fail(res, 500, result.error.message);
    return res.status(200).json({ members: result.data || [] });
  }

  if (req.method === 'POST') {
    const targetUser = body.user_id || body.userId || user.id;
    const requestedRole = body.role || 'member';
    if (!['member', 'admin', 'owner'].includes(requestedRole)) return fail(res, 400, 'Invalid member role.');
    if (targetUser === user.id) {
      if (requestedRole !== access.membership.role) return fail(res, 403, 'You cannot change your own role.');
    } else if (!['owner', 'admin'].includes(access.membership.role)) {
      return fail(res, 403, 'Only an owner or admin can add another member.');
    }
    if (requestedRole === 'owner' && access.membership.role !== 'owner') {
      return fail(res, 403, 'Only an owner can assign the owner role.');
    }
    const membership = await supabase.from('household_members').upsert(
      { household_id: householdId, user_id: targetUser, role: requestedRole },
      { onConflict: 'household_id,user_id' },
    ).select().single();
    if (membership.error) return fail(res, 500, membership.error.message);
    return res.status(201).json({ membership: membership.data });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
