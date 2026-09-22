import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Push notification environment is not configured' });
  }

  webpush.setVapidDetails('mailto:you@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const now = Date.now();
  const fiveMinAgo = new Date(now - 5 * 60000).toISOString();
  const { data: due, error: dueError } = await supabase.from('items').select('*')
    .lte('due_date', new Date(now).toISOString()).gte('due_date', fiveMinAgo)
    .eq('done', false).eq('notified', false);
  if (dueError) return res.status(500).json({ error: dueError.message });

  let sent = 0;
  for (const item of due || []) {
    const { data: subs } = await supabase.from('push_subscriptions').select('*').eq('user_id', item.owner_id);
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(s.subscription, JSON.stringify({ title: 'Due now: ' + item.title, body: item.sub || '' }));
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', s.id);
        }
      }
    }
    await supabase.from('items').update({ notified: true }).eq('id', item.id);
  }
  res.status(200).json({ checked: due?.length || 0, sent });
}