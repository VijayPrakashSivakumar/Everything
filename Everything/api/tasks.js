import { applyClientIdentity, bodyClientId, findByClientId, findRecordForMutation, hasClientIdColumn, hasColumn, orderNewestFirst, requireHouseholdMembership, requireUser, upsertByClientId } from './lib/auth.js';

const STATUS = ['inbox', 'planned', 'today', 'in_progress', 'waiting', 'completed', 'cancelled', 'someday'];
const PRIORITY = ['low', 'normal', 'high', 'urgent'];
const pick = (v, a, f) => a.includes(v) ? v : f;
const status = (v, f = 'inbox') => pick(String(v || '').trim().toLowerCase().replace(/\s+/g, '_'), STATUS, f);
const priority = (v, f = 'normal') => {
  const raw = String(v || '').trim().toLowerCase();
  if (raw === 'medium') return 'normal';
  return pick(raw, PRIORITY, f);
};
const normaliseChecklist = (value) => {
  let list = value;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  return list.map((step, index) => {
    if (typeof step === 'string') step = { text: step, done: false };
    if (!step || typeof step !== 'object') return null;
    const text = String(step.text || step.title || '').trim();
    if (!text) return null;
    const done = step.done === true || step.done === 1 || String(step.done).toLowerCase() === 'true';
    return { id: String(step.id || `step_${index + 1}`), text, done };
  }).filter(Boolean).slice(0, 100);
};
const isPrivate = (row) => row?.visibility === 'private' || row?.metadata?.scope === 'private';
const fail = (res, code, error) => res.status(code).json({ error: error || 'Request failed.' });

async function saveTask(supabase, householdId, userId, body, existing) {
  const clientId = existing?.client_id || bodyClientId(body) || null;
  const supportsClientId = clientId ? await hasClientIdColumn(supabase, 'tasks') : false;
  const supportsChecklist = await hasColumn(supabase, 'tasks', 'checklist');
  const supportsRecurrenceKey = await hasColumn(supabase, 'tasks', 'recurrence_key');
  const supportsArchivedAt = await hasColumn(supabase, 'tasks', 'archived_at');
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? { ...body.metadata }
    : (existing?.metadata || {});
  const payload = {
    entry_id: body.entry_id !== undefined ? (body.entry_id || body.entryId || null) : (existing?.entry_id || null),
    household_id: householdId,
    user_id: existing?.user_id || userId,
    title: body.title !== undefined ? String(body.title || '').trim() : (existing?.title || ''),
    description: body.description !== undefined ? body.description : (existing?.description || ''),
    status: status(body.status, existing?.status || 'inbox'),
    priority: priority(body.priority, existing?.priority || 'normal'),
    due_at: body.due_at !== undefined ? (body.due_at || body.dueAt || null) : (existing?.due_at || null),
    start_at: body.start_at !== undefined ? (body.start_at || body.startAt || null) : (existing?.start_at || null),
    duration_minutes: body.duration_minutes !== undefined ? (body.duration_minutes ?? body.durationMinutes ?? null) : (existing?.duration_minutes ?? null),
    recurrence_rule: body.recurrence_rule !== undefined ? (body.recurrence_rule || body.recurrenceRule || null) : (existing?.recurrence_rule || null),
    project_id: body.project_id !== undefined ? (body.project_id || body.projectId || null) : (existing?.project_id || null),
    person_id: body.person_id !== undefined ? (body.person_id || body.personId || null) : (existing?.person_id || null),
    goal_id: body.goal_id !== undefined ? (body.goal_id || body.goalId || null) : (existing?.goal_id || null),
    completed_at: body.completed_at !== undefined ? (body.completed_at || body.completedAt || null) : (existing?.completed_at || null),
    metadata,
  };
  if (supportsChecklist) {
    payload.checklist = normaliseChecklist(
      body.checklist !== undefined
        ? body.checklist
        : body.metadata?.checklist !== undefined
          ? body.metadata.checklist
          : (existing?.checklist || metadata.checklist || []),
    );
  }
  if (supportsRecurrenceKey && (body.recurrence_key !== undefined || body.recurrenceKey !== undefined || existing?.recurrence_key)) {
    payload.recurrence_key = body.recurrence_key ?? body.recurrenceKey ?? existing?.recurrence_key ?? null;
  }
  if (supportsArchivedAt && (body.archived_at !== undefined || body.archivedAt !== undefined || existing?.archived_at)) {
    payload.archived_at = body.archived_at ?? body.archivedAt ?? existing?.archived_at ?? null;
  }
  if (body.checklist !== undefined || body.metadata?.checklist !== undefined) {
    metadata.checklist = supportsChecklist
      ? payload.checklist
      : normaliseChecklist(body.checklist ?? body.metadata?.checklist);
  }
  if (body.recurrence_key !== undefined || body.recurrenceKey !== undefined) {
    metadata.recurrenceKey = payload.recurrence_key || body.recurrence_key || body.recurrenceKey || null;
  }
  if (body.archived_at !== undefined || body.archivedAt !== undefined) {
    metadata.archivedAt = payload.archived_at || body.archived_at || body.archivedAt || null;
  }
  payload.metadata = metadata;
  applyClientIdentity(payload, body, clientId, supportsClientId);
  if (!payload.title) return { error: 'Task title is required.' };
  if (existing) {
    const result = await supabase.from('tasks').update(payload).eq('id', existing.id).select().single();
    return { data: result.data, error: result.error };
  }
  const result = await upsertByClientId(supabase, 'tasks', householdId, clientId, payload);
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
    let request = supabase.from('tasks').select('*').eq('household_id', householdId);
    if (q.status) request = request.eq('status', status(q.status));
    request = await orderNewestFirst(request, supabase, 'tasks');
    const result = await request;
    if (result.error) return fail(res, 500, result.error.message);
    return res.status(200).json({ tasks: (result.data || []).filter((row) => !isPrivate(row) || row.user_id === user.id) });
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    let existing = null;
    if (req.method === 'PUT') {
      if (!body.id) return fail(res, 400, 'Task id is required.');
      const found = await findRecordForMutation(supabase, 'tasks', householdId, {
        id: body.id,
        clientId: body.client_id || body.clientId,
      });
      if (found.error) return fail(res, 500, found.error.message);
      if (!found.data) return fail(res, 404, 'Task not found.');
      if (isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this task.');
      existing = found.data;
    } else {
      const found = await findByClientId(supabase, 'tasks', householdId, bodyClientId(body));
      if (found.error) return fail(res, 500, found.error.message);
      if (found.data && isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this task.');
      existing = found.data;
    }
    const result = await saveTask(supabase, householdId, user.id, body, existing);
    if (result.error) return fail(res, existing ? 500 : 400, result.error.message || result.error);
    return res.status(existing ? 200 : 201).json({ task: result.data });
  }
  if (req.method === 'DELETE') {
    const id = q.id || body.id;
    const clientId = q.client_id || q.clientId || body.client_id || body.clientId;
    if (!id && !clientId) return fail(res, 400, 'Task id or client_id is required.');
    const found = await findRecordForMutation(supabase, 'tasks', householdId, { id, clientId });
    if (found.error) return fail(res, 500, found.error.message);
    if (!found.data) return res.status(200).json({ ok: true, missing: true });
    if (isPrivate(found.data) && found.data.user_id !== user.id) return fail(res, 403, 'You do not have access to this task.');
    const deleted = await supabase.from('tasks').delete().eq('id', found.data.id).eq('household_id', householdId);
    if (deleted.error) return fail(res, 500, deleted.error.message);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
