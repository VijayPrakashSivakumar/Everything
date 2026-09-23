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

function normaliseVisibility(value) {
  const allowed = ['private', 'shared', 'shared_with_family', 'shared_with_selected'];
  return allowed.includes(value) ? value : 'shared';
}

function normaliseKind(value) {
  const allowed = [
    'text',
    'task',
    'event',
    'memory',
    'waiting',
    'openloop',
    'voice',
    'image',
    'file',
    'link',
    'reminder',
  ];
  return allowed.includes(value) ? value : 'text';
}

function normaliseSourceType(value) {
  const allowed = ['manual', 'voice', 'image', 'file', 'link', 'ai', 'import'];
  return allowed.includes(value) ? value : 'manual';
}

export default async function handler(req, res) {
  const supabase = getSupabaseServerClient();

  if (!supabase) {
    return res.status(503).json({
      error: 'Supabase server configuration is missing.',
    });
  }

  if (req.method === 'GET') {
    const { household_id, user_id, limit = 50 } = req.query || {};

    let query = supabase.from('entries').select('*').order('created_at', { ascending: false }).limit(Number(limit));

    if (household_id) query = query.eq('household_id', household_id);
    if (user_id) query = query.eq('user_id', user_id);

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ entries: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const title = String(body.title || '').trim();

    if (!title) {
      return res.status(400).json({ error: 'Entry title is required.' });
    }

    const payload = {
      household_id: body.household_id || null,
      user_id: body.user_id || null,
      kind: normaliseKind(body.kind),
      source_type: normaliseSourceType(body.source_type),
      title,
      description: body.description || '',
      raw_text: body.raw_text || body.rawText || '',
      status: normaliseStatus(body.status),
      visibility: normaliseVisibility(body.visibility),
      due_at: body.due_at || body.dueAt || null,
      completed_at: body.completed_at || body.completedAt || null,
      metadata: body.metadata || {},
    };

    const { data, error } = await supabase
      .from('entries')
      .insert([payload])
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ entry: data });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const id = body.id;

    if (!id) {
      return res.status(400).json({ error: 'Entry id is required.' });
    }

    const payload = {
      title: body.title ? String(body.title).trim() : undefined,
      description: body.description !== undefined ? body.description : undefined,
      raw_text: body.raw_text !== undefined ? body.raw_text : undefined,
      kind: body.kind ? normaliseKind(body.kind) : undefined,
      source_type: body.source_type ? normaliseSourceType(body.source_type) : undefined,
      status: body.status ? normaliseStatus(body.status) : undefined,
      visibility: body.visibility ? normaliseVisibility(body.visibility) : undefined,
      due_at: body.due_at !== undefined ? (body.due_at || null) : undefined,
      completed_at: body.completed_at !== undefined ? (body.completed_at || null) : undefined,
      metadata: body.metadata !== undefined ? body.metadata : undefined,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('entries')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ entry: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
