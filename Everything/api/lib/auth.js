import { getSupabaseServerClient } from './supabase.js';

export function bearerToken(req) {
  const headers = req.headers || {};
  const value = headers.authorization || headers.Authorization || '';
  return String(value).replace(/^Bearer\s+/i, '').trim();
}

export function isMissingColumn(error) {
  const code = (error && error.code) || '';
  const message = (error && error.message) || '';
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    /column .* does not exist/i.test(message) ||
    /could not find the '.*' column/i.test(message)
  );
}

export async function requireUser(req, res) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    res.status(503).json({ error: 'Supabase server configuration is missing.' });
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) {
    res.status(401).json({ error: 'Invalid or expired session.' });
    return null;
  }

  return { supabase, user: data.user };
}

export async function requireHouseholdMembership(
  supabase,
  userId,
  householdId,
  allowedRoles,
) {
  if (!householdId) {
    return { status: 400, error: 'household_id is required.' };
  }

  const { data, error } = await supabase
    .from('household_members')
    .select('role')
    .eq('household_id', householdId)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error) return { status: 500, error: error.message };
  if (!data) return { status: 403, error: 'Household membership is required.' };
  if (allowedRoles && !allowedRoles.includes(data.role)) {
    return { status: 403, error: 'You do not have permission for this household.' };
  }
  return { membership: data };
}

export function bodyClientId(body = {}) {
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  return body.client_id || body.clientId || metadata.originalId || metadata.original_id || metadata.client_id || null;
}

const columnSupport = new Map();

export async function hasColumn(supabase, table, column) {
  const key = `${table}.${column}`;
  if (columnSupport.get(key) === true) return true;
  const { error } = await supabase.from(table).select(column).limit(1);
  const supported = !error && !isMissingColumn(error);
  // Keep a false result uncached so a deployment can pick up a newly applied
  // migration without requiring a long-lived server process to restart.
  if (supported) columnSupport.set(key, true);
  return supported;
}

export async function hasClientIdColumn(supabase, table) {
  return hasColumn(supabase, table, 'client_id');
}

/* The created-timestamp column differs between tables: the original prototype tables
   (items/projects/goals/people) use `created`, while the later foundation tables
   (entries/tasks/household_members) use `created_at`. Hardcoding either name made these
   routes fail with a 500 (and the browser's own fallback fail with 400) because ordering by a
   column the table does not have is an error, not an empty result. Resolve the real column once
   per table and cache the answer. */
const CREATED_COLUMN_CANDIDATES = ['created_at', 'created', 'createdAt'];
const createdColumnCache = new Map();

export async function createdColumn(supabase, table) {
  if (createdColumnCache.has(table)) return createdColumnCache.get(table);
  for (const column of CREATED_COLUMN_CANDIDATES) {
    if (await hasColumn(supabase, table, column)) {
      createdColumnCache.set(table, column);
      return column;
    }
  }
  // Nothing found: skip ordering entirely rather than 500 on a guaranteed-missing column.
  createdColumnCache.set(table, null);
  return null;
}

/* Applies newest-first ordering using whichever timestamp column the table actually has.
   Returns the builder unchanged when no known column exists, so the caller still gets rows. */
export async function orderNewestFirst(builder, supabase, table) {
  const column = await createdColumn(supabase, table);
  return column ? builder.order(column, { ascending: false }) : builder;
}

export async function findByClientId(supabase, table, householdId, clientId) {
  if (!clientId) return { data: null, error: null };

  const supportsClientId = await hasClientIdColumn(supabase, table);
  if (supportsClientId) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('household_id', householdId)
      .eq('client_id', clientId)
      .limit(1)
      .maybeSingle();
    if (error && !isMissingColumn(error)) return { data: null, error };
    if (data) return { data, error: null };
  }

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('household_id', householdId)
    .contains('metadata', { originalId: clientId })
    .limit(1)
    .maybeSingle();
  return { data, error };
}

export async function findRecordForMutation(supabase, table, householdId, { id, clientId } = {}) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (id && uuid.test(String(id))) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('id', id)
      .eq('household_id', householdId)
      .maybeSingle();
    return { data, error };
  }
  return findByClientId(supabase, table, householdId, clientId || id);
}

export function applyClientIdentity(payload, body, clientId, supportsClientId) {
  const metadata =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? { ...payload.metadata }
      : {};
  if (clientId) metadata.originalId = clientId;
  payload.metadata = metadata;
  if (supportsClientId && clientId) payload.client_id = clientId;
  return payload;
}

export async function upsertByClientId(supabase, table, householdId, clientId, payload) {
  if (!clientId) return supabase.from(table).insert([payload]).select().single();

  const found = await findByClientId(supabase, table, householdId, clientId);
  if (found.error) return found;
  if (found.data) {
    const update = { ...payload, user_id: found.data.user_id || payload.user_id };
    return supabase.from(table).update(update).eq('id', found.data.id).select().single();
  }

  const created = await supabase.from(table).insert([payload]).select().single();
  if (created.error && (created.error.code === '23505' || /duplicate key|unique constraint/i.test(created.error.message || ''))) {
    const retry = await findByClientId(supabase, table, householdId, clientId);
    if (retry.data) {
      const update = { ...payload, user_id: retry.data.user_id || payload.user_id };
      return supabase.from(table).update(update).eq('id', retry.data.id).select().single();
    }
  }
  return created;
}
