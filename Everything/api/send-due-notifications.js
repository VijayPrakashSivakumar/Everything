import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

webpush.setVapidDetails('mailto:you@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  const now = Date.now();
  const fiveMinAgo = new Date(now - 5*60000).toISOString();
  const { data: due } = await supabase.from('items').select('*')
    .lte('due_date', new Date(now).toISOString()).gte('due_date', fiveMinAgo)
    .eq('done', false).eq('notified', false);

  for(const item of due || []){
    const { data: subs } = await supabase.from('push_subscriptions').select('*').eq('user_id', item.owner_id);
    for(const s of subs || []){
      try{
        await webpush.sendNotification(s.subscription, JSON.stringify({ title: 'Due now: ' + item.title, body: item.sub || '' }));
      }catch(e){ /* subscription may be expired — ignore */ }
    }
    await supabase.from('items').update({ notified: true }).eq('id', item.id);
  }
  res.status(200).json({ checked: due?.length || 0 });
}