import { getSupabaseServerClient } from './lib/supabase.js';
import { aiStatus } from './ask.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const envStatus = {
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_ANON_KEY: Boolean(process.env.SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
    OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY),
    VAPID_PUBLIC_KEY: Boolean(process.env.VAPID_PUBLIC_KEY),
    VAPID_PRIVATE_KEY: Boolean(process.env.VAPID_PRIVATE_KEY),
    VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'default (mailto:notifications@everything.local)',
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    REMINDER_TIMEZONE: process.env.REMINDER_TIMEZONE || 'default (UTC)',
    NODE_ENV: process.env.NODE_ENV || 'development',
  };

  const pushReady = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

  let databaseReady = false;
  let reminderSchemaReady = false;
  let taskWorkflowSchemaReady = false;
  let smartCaptureSchemaReady = false;
  const supabase = getSupabaseServerClient();
  if (supabase) {
    try {
      const { error } = await supabase.from('households').select('id').limit(1);
      databaseReady = !error;
    } catch (error) {
      databaseReady = false;
    }

    // migrations 004 and 006 — reminder push and task workflow fields
    try {
      const { error } = await supabase.from('push_subscriptions').select('id').limit(1);
      reminderSchemaReady = !error;
    } catch (error) {
      reminderSchemaReady = false;
    }
    try {
      const taskColumns = 'checklist,recurrence_key,archived_at';
      const itemResult = await supabase.from('items').select(taskColumns).limit(1);
      if (itemResult.error) throw itemResult.error;
      const taskResult = await supabase.from('tasks').select(taskColumns).limit(1);
      if (taskResult.error) throw taskResult.error;
      taskWorkflowSchemaReady = true;
    } catch (error) {
      taskWorkflowSchemaReady = false;
    }
    try {
      const smartColumns = 'source_type,raw_text,capture_metadata,capture_fingerprint';
      const { error } = await supabase.from('items').select(smartColumns).limit(1);
      smartCaptureSchemaReady = !error;
    } catch (error) {
      smartCaptureSchemaReady = false;
    }
  }

  const backendReady =
    envStatus.SUPABASE_URL &&
    envStatus.SUPABASE_SERVICE_ROLE_KEY &&
    databaseReady;
  const ready = backendReady && taskWorkflowSchemaReady && smartCaptureSchemaReady;

  const ai = aiStatus();

  return res.status(200).json({
    ok: true,
    app: 'Everything',
    phase: 'phase-3',
    message: backendReady
      ? taskWorkflowSchemaReady && smartCaptureSchemaReady
        ? 'Phase 3 smart capture is ready. AI search is optional.'
        : taskWorkflowSchemaReady
          ? 'Task workflow is ready. Run migration 007 to enable smart-capture metadata.'
          : 'Foundation backend is ready. Run migration 006 to enable task workflows.'
      : 'Supabase backend configuration is incomplete.',
    envStatus,
    ready,
    backendReady,
    databaseReady,
    reminderSchemaReady,
    taskWorkflowSchemaReady,
    smartCaptureSchemaReady,
    pushReady,
    notifications: !pushReady
      ? 'Closed-app push is off: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, then redeploy.'
      : !reminderSchemaReady
        ? 'Run supabase/migrations/004_reminder_delivery.sql to enable closed-app push.'
        : 'Closed-app push is configured.',
    aiAvailable: ai.configured,
    aiProvider: ai.provider,
    aiModel: ai.model,
    aiMessage: ai.configured
      ? `Ask / Search uses ${ai.provider} (${ai.model}).`
      : ai.missingKeyVar
        ? `Ask / Search is off: set ${ai.missingKeyVar}, then redeploy.`
        : 'Ask / Search is off: set one of GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY. Search still works with offline keyword matching.',
    timestamp: new Date().toISOString(),
  });
}
