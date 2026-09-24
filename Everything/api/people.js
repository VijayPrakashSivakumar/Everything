import { applyClientIdentity, bodyClientId, findByClientId, findRecordForMutation, hasClientIdColumn, requireHouseholdMembership, requireUser, upsertByClientId } from './lib/auth.js';

const fail = (res, code, error) => res.status(code).json({ error: error || 'Request failed.' });
const isPrivate = (row) => row?.visibility === 'private' || row?.metadata?.scope === 'private';

async function savePerson(supabase, householdId, userId, body, existing) {
  const clientId = existing?.client_id || bodyClientId(body) || null;
  const supportsClientId = clientId ? await hasClientIdColumn(supabase, 'people') : false;
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : (existing?.metadata || {});
  const payload = {
    household_id: householdId,
    user_id: existing?.user_id || userId,
    name: body.name !== undefined ? String(body.name || '').trim() : (existing?.name || ''),
    notes: body.notes !== undefined ? body.notes : (existing?.notes || ''),
    metadata,
  };
  applyClientIdentity(payload, body, clientId, supportsClientId);
  if (!payload.name) return { error: 'Person name is required.' };
  if (existing) {
    const result = await supabase.from('people').update(payload).eq('id', existing.id).select().single();
    return { data: result.data, error: result.error };
  }
  const result = await upsertByClientId(supabase, 'people', householdId, clientId, payload);
  return { data: result.data, error: result.error };
}

export default async function handler(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { supabase, user } = auth;
  const q = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const householdId = q.household_id || q.householdId || body.household_id || body.householdId;
  const access = await requireHouseholdMembership(supabase, user.id, householdId);
  if (access.error) return fail(res, access.status, access.error);
  if (req.method === 'GET') {
    const result = await supabase.from('people').select('*').eq('household_id', householdId).order('created_at', { ascending: false });
    if (result.error) return fail(res, 500, result.error.message);
    return res.status(200).json({ people: (result.data || []).filter((row) => !isPrivate(row) || row.user_id === user.id) });
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    let existing = null;
    if (req.method === 'PUT') {
      if (!body.id) return fail(res, 400, 'Person id is required.');
      const found = await findRecordForMutation(supabase, 'people', householdId, {
        id: body.id,
        clientId: body.client_id || body.clientId,
      });
      if (found.error) return fail(res, 500, found.error.message);
      if (!found.data) return fail(res, 404, 'Person not found.');
      if (isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this person.');
      existing = found.data;
    } else {
      const found = await findByClientId(supabase, 'people', householdId, bodyClientId(body));
      if (found.error) return fail(res, 500, found.error.message);
      if (found.data && isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this person.');
      existing = found.data;
    }
    const result = await savePerson(supabase, householdId, user.id, body, existing);
    if (result.error) return fail(res, existing ? 500 : 400, result.error.message || result.error);
    return res.status(existing ? 200 : 201).json({ person: result.data });
  }
  if (req.method === 'DELETE') {
    const id = q.id || body.id;
    const clientId = q.client_id || q.clientId || body.client_id || body.clientId;
    if (!id && !clientId) return fail(res, 400, 'Person id or client_id is required.');
    const found = await findRecordForMutation(supabase, 'people', householdId, { id, clientId });
    if (found.error) return fail(res, 500, found.error.message);
    if (!found.data) return res.status(200).json({ ok: true, missing: true });
    if (isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this person.');
    const deleted = await supabase.from('people').delete().eq('id', found.data.id).eq('household_id', householdId);
    if (deleted.error) return fail(res, 500, deleted.error.message);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
