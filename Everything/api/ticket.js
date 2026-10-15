import { requireUser } from './lib/auth.js';

// Support-ticket endpoint. Batteries included, so the Support view can create a
// ticket and the dev team can track it without a second app. Tickets go through
// the server so `user_id` and `created_at` always come from the session, not
// from anything a person typed.

const ALLOWED_CATEGORIES = ['bug', 'feature', 'question', 'other'];
const ALLOWED_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const ALLOWED_STATUSES = ['open', 'in_progress', 'resolved'];
const STATUS_ORDER = new Map([
  ['open', 1],
  ['in_progress', 2],
  ['resolved', 3],
]);
const fail = (res, code, error) => res.status(code).json({ error: error || 'Request failed.' });

async function listTickets(supabase, userId) {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return { data: [], error: error.message };
  return { data: data || [], error: null };
}

async function createTicket(supabase, userId, body) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'Enter a short title for your ticket.' };

  const description = String(body.description || '').trim();
  if (!description) return { error: 'Describe what happened so the team can help.' };

  const category = String(body.category || 'question').trim().toLowerCase();
  const priority = String(body.priority || 'normal').trim().toLowerCase();

  if (!ALLOWED_CATEGORIES.includes(category)) {
    return { error: 'Choose a category that best describes the issue.' };
  }
  if (!ALLOWED_PRIORITIES.includes(priority)) {
    return { error: 'Choose a priority level.' };
  }

  const { data, error } = await supabase.from('tickets').insert({
    user_id: userId,
    title,
    description,
    category,
    priority,
    status: 'open',
  }).select().single();
  if (error) return { data: null, error: error.message || 'Could not save your ticket.' };
  return { data, error: null };
}

async function updateTicket(supabase, userId, id, body) {
  const row = await supabase
    .from('tickets')
    .select('id, status, priority, title, description, category, resolution_note, created_at')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (row.error) return { data: null, error: row.error?.message || 'Ticket not found.' };
  if (!row.data) return { data: null, error: 'Ticket not found.' };

  const patch = { updated_at: new Date().toISOString() };
  const title = String(body.title || row.data.title || '').trim();
  const description = String(body.description !== undefined ? body.description : row.data.description || '');
  const category = String(body.category || row.data.category || 'question').trim().toLowerCase();
  const priority = String(body.priority || row.data.priority || 'normal').trim().toLowerCase();
  const status = String(body.status || row.data.status || 'open').trim().toLowerCase();

  if (title) patch.title = title;
  if (body.description !== undefined) patch.description = description.trim();
  if (ALLOWED_CATEGORIES.includes(category)) patch.category = category;
  if (ALLOWED_PRIORITIES.includes(priority)) patch.priority = priority;

  if (body.status !== undefined) {
    if (!ALLOWED_STATUSES.includes(status)) {
      return { data: null, error: 'Choose a valid status.' };
    }
    const next = STATUS_ORDER.get(status);
    const current = STATUS_ORDER.get(row.data.status);
    if (!current || next <= current) {
      return { data: null, error: 'You cannot move a ticket backwards.' };
    }
    patch.status = status;
  }

  if (body.resolution_note !== undefined) {
    patch.resolution_note = body.resolution_note;
  }

  const { data, error } = await supabase
    .from('tickets')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) return { data: null, error: error.message || 'Could not update the ticket.' };
  return { data, error: null };
}

export default async function handler(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { supabase, user } = auth;
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    if (req.method === 'GET') {
      const { data, error } = await listTickets(supabase, user.id);
      if (error) return fail(res, 500, error);
      return res.status(200).json({ tickets: data });
    }

    if (req.method === 'POST') {
      const { data, error } = await createTicket(supabase, user.id, body);
      if (error) return fail(res, 400, error);
      return res.status(201).json({ ticket: data });
    }

    if (req.method === 'PATCH') {
      const id = body.id || req.query?.id;
      if (!id) return fail(res, 400, 'Ticket id is required.');
      const { data, error } = await updateTicket(supabase, user.id, String(id), body);
      if (error) return fail(res, 400, error);
      return res.status(200).json({ ticket: data });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('ticket handler error:', err);
    return fail(res, 500, 'An unexpected error occurred.');
  }
}
