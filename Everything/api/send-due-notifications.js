import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

/* Reminder delivery for closed apps.
   This is the "app is not open" leg of the reminder chain (see sw.js and script.js):
     * delivers items whose reminder_at (or due_date) has arrived,
     * looks back REMINDER_LOOKBACK_MINUTES so a short outage or a cold start does not
       silently drop a reminder,
     * skips anything already delivered, unless the reminder was snoozed,
     * pushes to the owner and, for shared items, to every household member's devices,
     * removes dead endpoints and writes an audit row to notification_log.
   Env (all optional except the Supabase pair):
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  required
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY      required for push
     VAPID_SUBJECT      default mailto:notifications@everything.local
     CRON_SECRET        when set, Vercel sends it automatically as a Bearer header and the
                        cron path requires it (the in-app test uses the user's token instead)
     REMINDER_LOOKBACK_MINUTES  default 60
     REMINDER_TIMEZONE  default UTC, only affects the "Due …" text in the notification */

const LOOKBACK_MINUTES = Number(process.env.REMINDER_LOOKBACK_MINUTES || 60);
const MAX_PER_RUN = Number(process.env.REMINDER_MAX_PER_RUN || 200);
const CRON_SECRET = process.env.CRON_SECRET || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:notifications@everything.local';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const TIMEZONE = process.env.REMINDER_TIMEZONE || 'UTC';
const MISSED_AFTER_MS = 60000;
const NOT_CONFIGURED = 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not configured';

const pushReady = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushReady) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const householdMemberCache = new Map();

export default async function handler(req, res) {
  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};

  // The in-app "Send test" button is authenticated with the user's Supabase token, so the
  // test keeps working even when CRON_SECRET locks the cron path down.
  if (req.method === 'POST' && body.test) {
    const check = await authorizeTest(req, body);
    if (!check.ok) {
      return res.status(check.status).json({ ok: false, error: check.error });
    }

    if (!pushReady) {
      return res.status(200).json({ ok: false, skipped: NOT_CONFIGURED });
    }

    return sendTestPush(res, body);
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!pushReady) {
    return res.status(200).json({ ok: false, skipped: NOT_CONFIGURED });
  }

  const now = Date.now();

  try {
    const nowIso = new Date(now).toISOString();
    const sinceIso = new Date(now - LOOKBACK_MINUTES * 60000).toISOString();
    const { items } = await fetchDueItems(sinceIso, nowIso);
    const pending = items.filter(item => shouldDeliver(item, now)).slice(0, MAX_PER_RUN);

    let delivered = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of pending) {
      const reminderTime = reminderTimeOf(item);
      const subscriptions = await subscriptionsFor(item);

      if (!subscriptions.length) {
        skipped += 1;
        continue;
      }

      const results = await sendToSubscriptions(
        subscriptions,
        buildPayload(item, reminderTime, now)
      );

      delivered += results.sent;
      failed += results.failed;

      if (results.sent) {
        await markDelivered(item, now);
      }

      await logDelivery({
        item,
        status: results.sent ? 'sent' : 'failed',
        detail: results.sent
          ? `${results.sent} device(s) reached${results.failed ? `, ${results.failed} failed` : ''}`
          : results.detail
      });
    }

    // The daily digest rides on this same run, because this is the only moment the server is awake
    // to reach a phone with the app closed. It is counted, never allowed to fail the run: a broken
    // digest must not cost anyone their reminders.
    let digest = { attempted: 0, delivered: 0, skipped: 0 };
    try {
      digest = await deliverDailyDigests(now);
    } catch (error) {
      console.error('morning digest failed:', error);
      digest = { attempted: 0, delivered: 0, skipped: 0, error: String(error.message || error) };
    }

    return res.status(200).json({
      ok: true,
      checked: items.length,
      pending: pending.length,
      delivered,
      failed,
      skipped,
      digest,
      window: { from: sinceIso, to: nowIso }
    });
  } catch (error) {
    console.error('send-due-notifications failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
/* ---------- notification helpers ---------- */

function isAuthorized(req) {
  if (!CRON_SECRET) return true; // self-hosted default: rely on deployment access control

  return bearerToken(req) === CRON_SECRET;
}

function bearerToken(req) {
  const headers = req.headers || {};
  const header = headers.authorization || headers.Authorization || '';

  return header.replace(/^Bearer\s+/i, '') || headers['x-cron-secret'] || '';
}

/* Test pushes are allowed either with the cron secret (curl) or with the signed-in user's
   Supabase token, and the token must belong to the user being tested. */
async function authorizeTest(req, body) {
  if (isAuthorized(req)) return { ok: true };

  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'unauthorized' };

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return { ok: false, status: 401, error: 'unauthorized' };
  if (body.user_id && body.user_id !== data.user.id) {
    return { ok: false, status: 403, error: 'user mismatch' };
  }

  return { ok: true, user: data.user };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return {};
  }
}

/* ---------- the daily digest ----------

   The client sends this while the app is open. The server sends it with the app genuinely closed,
   which is the only way a digest can reach a phone that has not been opened. Both legs must obey the
   same rules — see buildDigest and the quiet checks below — or the app would argue with itself
   about whether a day was worth mentioning.

   Deliberately per-user rather than per-household: the digest says "you have three overdue", and
   your partner's overdue items are not yours to be nagged about. */

const DIGEST_WAITING_STALE_DAYS = 14;
const DIGEST_MAX_NAMES = 3;
/* This is a *window*, not a target hour, and the distinction matters.

   The Vercel Hobby plan only allows one cron run a day, and this project's runs at 01:00 UTC. So
   asking the server for "8am exactly" is not a thing it can do: 01:00 UTC is 6:30 in India and 20:00
   the previous evening in California, and a digest sent then is the 3am notification that gets a
   feature muted for good.

   So the server sends inside a waking window and stays silent outside it. With the daily cron that
   is the best a Hobby deployment can honestly do; run the minute-level schedule in
   supabase/reminder-cron.sql and the target hour is honoured properly instead. */
const DIGEST_SEND_FROM_HOUR = 6;
const DIGEST_SEND_UNTIL_HOUR = 20;

function digestTimeZoneOffset(item) {
  const tz = String((item && item.timezone) || process.env.REMINDER_TIMEZONE || 'UTC');
  try {
    return tz;
  } catch (error) {
    return 'UTC';
  }
}

/* Local hour and calendar day for a subscriber, so "8am" means 8am where the person is. A digest
   that fires at 8am UTC reaches 3am in India, and a notification at 3am is how a feature gets muted
   for good. */
function localHourAndDay(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour12: false
    }).formatToParts(date);

    const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
    const hour = Number(get('hour'));
    return {
      hour: hour === 24 ? 0 : hour,
      minute: Number(get('minute')) || 0,
      day: `${get('year')}-${get('month')}-${get('day')}`
    };
  } catch (error) {
    return { hour: date.getUTCHours(), minute: 0, day: date.toISOString().slice(0, 10) };
  }
}

function isOverdueItem(item, now) {
  if (!item || item.done || item.archived_at) return false;
  if (!item.due_date) return false;
  const due = new Date(item.due_date).getTime();
  if (!Number.isFinite(due) || due >= now) return false;
  // Not overdue on its own day — the same rule as the client's isOverdue, so the two agree.
  return !sameLocalDay(new Date(due), new Date(now), digestTimeZoneOffset(item));
}

function sameLocalDay(a, b, timeZone) {
  return localHourAndDay(a, timeZone).day === localHourAndDay(b, timeZone).day;
}

function isDueTodayItem(item, now) {
  if (!item || item.done || item.archived_at) return false;
  if (!item.due_date) return false;
  if (isOverdueItem(item, now)) return false;
  return sameLocalDay(new Date(item.due_date), new Date(now), digestTimeZoneOffset(item));
}

function isStaleWaitingItem(item, now) {
  if (!item || item.done || item.archived_at) return false;
  if (item.kind !== 'waiting' || item.due_date) return false;
  const created = new Date(item.created || 0).getTime();
  if (!Number.isFinite(created) || created <= 0) return false;
  return created < now - DIGEST_WAITING_STALE_DAYS * 86400000;
}

function buildDigest(items, now) {
  const overdue = items.filter(item => isOverdueItem(item, now));
  const dueToday = items.filter(item => isDueTodayItem(item, now));
  const staleWaiting = items.filter(item => isStaleWaitingItem(item, now));

  // The quiet rule. Nothing needs you, so nothing is sent — same as the client.
  if (!overdue.length && !dueToday.length && !staleWaiting.length) return null;

  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  if (dueToday.length) parts.push(`${dueToday.length} due today`);
  if (staleWaiting.length) parts.push(`${staleWaiting.length} waiting too long`);

  const ranked = [
    ...overdue.map(item => ({ item, rank: 0 })),
    ...dueToday.map(item => ({ item, rank: 1 })),
    ...staleWaiting.map(item => ({ item, rank: 2 }))
  ].sort((a, b) => a.rank - b.rank);

  const named = ranked
    .slice(0, DIGEST_MAX_NAMES)
    .map(entry => (entry.item.title || '').trim())
    .filter(Boolean);
  const rest = ranked.length - named.length;

  return {
    title: `Good morning · ${parts.join(' · ')}`,
    body: named.length
      ? `${named.join(' · ')}${rest > 0 ? ` · and ${rest} more` : ''}`
      : parts.join(' · '),
    counts: {
      overdue: overdue.length,
      dueToday: dueToday.length,
      staleWaiting: staleWaiting.length
    }
  };
}

function digestPayload(digest) {
  return JSON.stringify({
    title: digest.title,
    body: digest.body,
    url: './?view=today',
    digest: true,
    // The same tag as the client, so a digest from the server replaces one already on screen
    // instead of stacking a second identical notification underneath it.
    tag: 'everything-morning-digest',
    data: { url: './?view=today', digest: true }
  });
}
/* Whether a user has opted in, and whether today's digest already went out. The row is the whole
   memory: no row means off, which is the safe default for a feature that must never appear
   uninvited. Kept separate from notification_log so the daily send is a single keyed row rather
   than a query over an ever-growing audit table. */
async function fetchDigestPreferences() {
  const primary = await supabase
    .from('digest_preferences')
    .select('*')
    .eq('enabled', true);

  if (!primary.error) return primary.data || [];

  // A database that has not run migration 008 yet simply has no digests, which is exactly the
  // behaviour we want: absent schema must degrade to silence, not to an error every hour.
  if (isMissingColumn(primary.error) || isMissingRelation(primary.error)) return [];

  throw new Error(primary.error.message);
}

function isMissingRelation(error) {
  const code = (error && error.code) || '';
  return code === '42P01' || /does not exist/i.test((error && error.message) || '');
}

async function deliverDailyDigests(now) {
  const preferences = await fetchDigestPreferences();
  if (!preferences.length) return { attempted: 0, delivered: 0, skipped: 0, quiet: 0, early: 0 };

  const result = { attempted: 0, delivered: 0, skipped: 0, quiet: 0, outsideWindow: 0 };

  for (const pref of preferences) {
    if (!pref.user_id) continue;
    result.attempted += 1;

    const timeZone = pref.timezone || 'UTC';
    const local = localHourAndDay(new Date(now), timeZone);

    // Outside the waking window, it stays silent — and deliberately does NOT mark the day, so a
    // later run (or the minute-level schedule) can still deliver it.
    if (local.hour < DIGEST_SEND_FROM_HOUR || local.hour >= DIGEST_SEND_UNTIL_HOUR) {
      result.outsideWindow += 1;
      continue;
    }

    // One a day, by the day key in their own timezone. UTC would send it twice, or at 3am.
    if (local.day === pref.last_sent_on) {
      result.skipped += 1;
      continue;
    }

    const { data: items } = await supabase
      .from('items')
      .select('*')
      .eq('owner_id', pref.user_id)
      .eq('done', false);

    const open = (items || []).filter(item => !item.archived_at);
    const digest = buildDigest(open, now);

    if (!digest) {
      // Nothing needed them. The day is deliberately NOT recorded as sent, so something that
      // becomes due later today is still mentioned — the same rule the client follows.
      result.quiet += 1;
      continue;
    }

    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', pref.user_id)
      .eq('enabled', true);

    const rows = (subscriptions || []).filter(row => row.subscription && row.subscription.endpoint);
    if (!rows.length) {
      result.skipped += 1;
      continue;
    }

    const sent = await sendToSubscriptions(rows, digestPayload(digest));
    result.delivered += sent.sent;

    if (sent.sent) {
      // Only a real send marks the day, so a failed push is retried on the next run rather than
      // silently skipped for the rest of the day.
      await supabase
        .from('digest_preferences')
        .update({ last_sent_on: local.day, last_sent_at: new Date(now).toISOString() })
        .eq('user_id', pref.user_id);
    }
  }

  return result;
}

/* Prefer items.reminder_at (snooze-aware) and fall back to due_date so the endpoint
   keeps working on a database that has not run migration 004 yet. */
async function fetchDueItems(sinceIso, nowIso) {
  const primary = await supabase
    .from('items')
    .select('*')
    .eq('done', false)
    .gte('reminder_at', sinceIso)
    .lte('reminder_at', nowIso)
    .limit(MAX_PER_RUN);

  if (!primary.error) return { items: primary.data || [] };
  if (!isMissingColumn(primary.error)) throw new Error(primary.error.message);

  const fallback = await supabase
    .from('items')
    .select('*')
    .eq('done', false)
    .gte('due_date', sinceIso)
    .lte('due_date', nowIso)
    .limit(MAX_PER_RUN);

  if (fallback.error) throw new Error(fallback.error.message);

  return { items: fallback.data || [] };
}

function isMissingColumn(error) {
  const code = (error && error.code) || '';
  const message = (error && error.message) || '';

  return (
    code === '42703' ||
    code === 'PGRST204' ||
    /column .* does not exist/i.test(message) ||
    /could not find the '.*' column/i.test(message)
  );
}

function reminderTimeOf(item) {
  const value = item.reminder_at || item.due_date;
  const time = value ? new Date(value).getTime() : Date.now();

  return Number.isFinite(time) ? time : Date.now();
}

/* One reminder per item, unless the user snoozed it — that is the only way a delivered
   reminder may surface again. This is what keeps push and local delivery from duplicating. */
function shouldDeliver(item, now) {
  if (item.done || item.archived_at) return false;
  if (item.notified !== true) return true;

  const snoozeUntil = item.snoozed_until ? new Date(item.snoozed_until).getTime() : 0;

  return snoozeUntil > 0 && snoozeUntil <= now;
}

async function householdMembers(householdId) {
  if (!householdId) return [];
  if (householdMemberCache.has(householdId)) return householdMemberCache.get(householdId);

  const { data, error } = await supabase
    .from('household_members')
    .select('user_id')
    .eq('household_id', householdId);

  const ids = error ? [] : (data || []).map(row => row.user_id).filter(Boolean);
  householdMemberCache.set(householdId, ids);

  return ids;
}

async function subscriptionsFor(item) {
  const userIds = new Set();

  if (item.owner_id) userIds.add(item.owner_id);
  if (item.scope !== 'private') {
    (await householdMembers(item.household_id)).forEach(id => userIds.add(id));
  }

  if (!userIds.size) return [];

  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .in('user_id', [...userIds])
    .eq('enabled', true);

  if (error) {
    console.warn('push_subscriptions lookup failed:', error.message);
    return [];
  }

  return (data || []).filter(row => row.subscription && row.subscription.endpoint);
}
/* ---------- notification send helpers ---------- */

/* The payload mirrors the `reminder` shape sw.js understands, so a push cancels any
   pending local timer for the same item instead of stacking a second notification. */
function buildPayload(item, reminderTime, now) {
  const body = item.sub || formatDue(item.due_date) || 'Tap to open Everything';
  const url = `./?item=${item.id}`;

  return JSON.stringify({
    title: `${item.priority === 'urgent' ? '❗ ' : ''}${item.title || 'Reminder'}`,
    body,
    url,
    itemId: item.id,
    priority: item.priority || '',
    timestamp: reminderTime,
    missed: now - reminderTime > MISSED_AFTER_MS,
    reminder: {
      id: item.id,
      title: item.title || 'Reminder',
      body,
      url,
      priority: item.priority || '',
      time: reminderTime,
      kind: item.kind || ''
    }
  });
}

function formatDue(value) {
  if (!value) return '';

  try {
    const label = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TIMEZONE
    }).format(new Date(value));

    return `Due ${label}`;
  } catch (error) {
    return '';
  }
}

/* TTL keeps the push in the push service for 12h, so a phone that was offline still gets
   the reminder when it reconnects instead of losing it. */
async function sendToSubscriptions(subscriptions, payload) {
  let sent = 0;
  let failed = 0;
  let detail = '';

  for (const row of subscriptions) {
    try {
      await webpush.sendNotification(row.subscription, payload, {
        TTL: 12 * 60 * 60,
        urgency: 'high'
      });

      sent += 1;

      await supabase
        .from('push_subscriptions')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', row.id);
    } catch (error) {
      failed += 1;
      detail = String((error && (error.body || error.message)) || error);

      // 404/410 means the browser dropped the subscription — stop trying it.
      const status = error && error.statusCode;
      if (status === 404 || status === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', row.id);
      }
    }
  }

  return { sent, failed, detail };
}

async function markDelivered(item, now) {
  const patch = {
    notified: true,
    notified_at: new Date(now).toISOString(),
    snoozed_until: null
  };

  const { error } = await supabase.from('items').update(patch).eq('id', item.id);
  if (!error) return;

  if (isMissingColumn(error)) {
    const retry = await supabase.from('items').update({ notified: true }).eq('id', item.id);
    if (retry.error) console.warn('items update failed:', retry.error.message);
    return;
  }

  console.warn('items update failed:', error.message);
}

async function logDelivery({ item, status, detail }) {
  const { error } = await supabase.from('notification_log').insert({
    item_id: item.id,
    user_id: item.owner_id || null,
    household_id: item.household_id || null,
    channel: 'push',
    status,
    title: item.title || '',
    body: item.sub || '',
    detail: detail || ''
  });

  if (error) console.warn('notification_log insert skipped:', error.message);
}

async function sendTestPush(res, body) {
  if (!body.user_id) {
    return res.status(400).json({ ok: false, error: 'user_id is required for a test push' });
  }

  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', body.user_id)
    .eq('enabled', true);

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const subscriptions = (data || []).filter(row => row.subscription && row.subscription.endpoint);

  if (!subscriptions.length) {
    return res.status(200).json({ ok: false, skipped: 'no push subscription registered yet' });
  }

  const results = await sendToSubscriptions(
    subscriptions,
    JSON.stringify({
      title: 'Test notification',
      body: 'Server push works — closed-app reminders will reach this device.',
      url: './',
      tag: 'everything-test'
    })
  );

  return res.status(200).json({ ok: results.sent > 0, ...results });
}

