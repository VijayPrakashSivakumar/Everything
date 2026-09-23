import { getSupabaseServerClient } from './lib/supabase.js';

function normaliseStatus(value) {
  const allowed = [
    'inbox',
    'planned',
    'today',
    'in_progress',
    'waiting',
    'completed',
    'cancelled',
    'someday',
  ];
  return allowed.includes(value) ? value : 'inbox';
}

function normalisePriority(value) {
  const allowed = ['low', 'normal', 'high', 'urgent'];
  return allowed.includes(value) ? value : 'normal';
}

export default async function handler(req, res) {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return res.status(503).json({
      error: 'Supabase server configuration is missing.',
    });
  }

  if (req.method === 'GET') {
    const { household_id, user_id, status } = req.query || {};

    let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });

    if (household_id) query = query.eq('household_id', household_id);
    if (user_id) query = query.eq('user_id', user_id);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ tasks: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const title = String(body.title || '').trim();

    if (!title) {
      return res.status(400).json({ error: 'Task title is required.' });
    }

    const payload = {
      entry_id: body.entry_id || null,
      household_id: body.household_id || null,
      user_id: body.user_id || null,
      title,
      description: body.description || '',
      status: normaliseStatus(body.status),
      priority: normalisePriority(body.priority),
      due_at: body.due_at || body.dueAt || null,
      start_at: body.start_at || body.startAt || null,
      duration_minutes: body.duration_minutes ?? body.durationMinutes ?? null,
      recurrence_rule: body.recurrence_rule || body.recurrenceRule || null,
      project_id: body.project_id || body.projectId || null,
      person_id: body.person_id || body.personId || null,
      goal_id: body.goal_id || body.goalId || null,
      metadata: body.metadata || {},
    };

    const { data, error } = await supabase
      .from('tasks')
      .insert([payload])
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ task: data });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const id = body.id;

    if (!id) {
      return res.status(400).json({ error: 'Task id is required.' });
    }

    const payload = {
      title: body.title ? String(body.title).trim() : undefined,
      description: body.description !== undefined ? body.description : undefined,
      status: body.status ? normaliseStatus(body.status) : undefined,
      priority: body.priority ? normalisePriority(body.priority) : undefined,
      due_at: body.due_at !== undefined ? (body.due_at || null) : undefined,
      start_at: body.start_at !== undefined ? (body.start_at || null) : undefined,
      duration_minutes: body.duration_minutes !== undefined ? (body.duration_minutes ?? null) : undefined,
      recurrence_rule: body.recurrence_rule !== undefined ? (body.recurrence_rule || null) : undefined,
      project_id: body.project_id !== undefined ? (body.project_id || null) : undefined,
      person_id: body.person_id !== undefined ? (body.person_id || null) : undefined,
      goal_id: body.goal_id !== undefined ? (body.goal_id || null) : undefined,
      completed_at: body.completed_at !== undefined ? (body.completed_at || null) : undefined,
      metadata: body.metadata !== undefined ? body.metadata : undefined,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('tasks')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ task: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
