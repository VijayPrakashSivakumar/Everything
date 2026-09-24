import { applyClientIdentity, bodyClientId, findByClientId, findRecordForMutation, hasClientIdColumn, requireHouseholdMembership, requireUser, upsertByClientId } from './lib/auth.js';

const STATUS = ['inbox', 'planned', 'today', 'in_progress', 'waiting', 'completed', 'cancelled', 'someday'];
const VISIBILITY = ['private', 'shared', 'shared_with_family', 'shared_with_selected'];
const KIND = ['text', 'task', 'event', 'memory', 'waiting', 'openloop', 'voice', 'image', 'file', 'link', 'reminder'];
const SOURCE = ['manual', 'voice', 'image', 'file', 'link', 'ai', 'import'];
const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const status = (value, fallback = 'inbox') => pick(String(value || '').trim().toLowerCase().replace(/\s+/g, '_'), STATUS, fallback);
const isPrivate = (row) => row?.visibility === 'private' || row?.metadata?.scope === 'private';
const fail = (res, code, error) => res.status(code).json({ error: error || 'Request failed.' });

async function saveEntry(supabase, householdId, userId, body, existing) {
  const clientId = existing?.client_id || bodyClientId(body) || null;
  const supportsClientId = clientId ? await hasClientIdColumn(supabase, 'entries') : false;
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata
    : (existing?.metadata || {});
  const payload = {
    household_id: householdId,
    user_id: existing?.user_id || userId,
    kind: pick(body.kind, KIND, existing?.kind || 'text'),
    source_type: pick(body.source_type, SOURCE, existing?.source_type || 'manual'),
    title: body.title !== undefined ? String(body.title || '').trim() : (existing?.title || ''),
    description: body.description !== undefined ? body.description : (existing?.description || ''),
    raw_text: body.raw_text !== undefined ? body.raw_text : (existing?.raw_text || ''),
    status: status(body.status, existing?.status || 'inbox'),
    visibility: pick(body.visibility, VISIBILITY, existing?.visibility || 'shared'),
    due_at: body.due_at !== undefined ? (body.due_at || body.dueAt || null) : (existing?.due_at || null),
    completed_at: body.completed_at !== undefined ? (body.completed_at || body.completedAt || null) : (existing?.completed_at || null),
    metadata,
  };
  applyClientIdentity(payload, body, clientId, supportsClientId);
  if (!payload.title) return { error: 'Entry title is required.' };
  if (existing) {
    const result = await supabase.from('entries').update(payload).eq('id', existing.id).select().single();
    return { data: result.data, error: result.error };
  }
  const result = await upsertByClientId(supabase, 'entries', householdId, clientId, payload);
  return { data: result.data, error: result.error };
}

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
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 200);
    const result = await supabase.from('entries').select('*').eq('household_id', householdId).order('created_at', { ascending: false }).limit(limit);
    if (result.error) return fail(res, 500, result.error.message);
    return res.status(200).json({ entries: (result.data || []).filter((row) => !isPrivate(row) || row.user_id === user.id) });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    let existing = null;
    if (req.method === 'PUT') {
      if (!body.id) return fail(res, 400, 'Entry id is required.');
      const found = await findRecordForMutation(supabase, 'entries', householdId, {
        id: body.id,
        clientId: body.client_id || body.clientId,
      });
      if (found.error) return fail(res, 500, found.error.message);
      if (!found.data) return fail(res, 404, 'Entry not found.');
      if (isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this entry.');
      existing = found.data;
    } else {
      const found = await findByClientId(supabase, 'entries', householdId, bodyClientId(body));
      if (found.error) return fail(res, 500, found.error.message);
      if (found.data && isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this entry.');
      existing = found.data;
    }
    const result = await saveEntry(supabase, householdId, user.id, body, existing);
    if (result.error) return fail(res, existing ? 500 : 400, result.error.message || result.error);
    return res.status(existing ? 200 : 201).json({ entry: result.data });
  }

  if (req.method === 'DELETE') {
    const id = query.id || body.id;
    const clientId = query.client_id || query.clientId || body.client_id || body.clientId;
    if (!id && !clientId) return fail(res, 400, 'Entry id or client_id is required.');
    const found = await findRecordForMutation(supabase, 'entries', householdId, { id, clientId });
    if (found.error) return fail(res, 500, found.error.message);
    if (!found.data) return res.status(200).json({ ok: true, missing: true });
    if (isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this entry.');
    const deleted = await supabase.from('entries').delete().eq('id', found.data.id).eq('household_id', householdId);
    if (deleted.error) return fail(res, 500, deleted.error.message);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
