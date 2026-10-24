// Daily JSON backup of every Y Ledger table into the private `backups` bucket, keeping 30 days.
// Triggered by pg_cron through pg_net. Uses the service role key that Supabase injects into Edge Functions.
import { createClient } from 'npm:@supabase/supabase-js@2';

const TABLES = ['allowlist', 'car_profile', 'price_lines', 'recurring_rules', 'expenses', 'charging_sessions', 'odometer_readings',
  'loan_instalments_paid', 'settlements', 'reminders', 'receipts'];
const KEEP_DAYS = 30;

Deno.serve(async () => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const dump: Record<string, unknown> = { created_at: new Date().toISOString() };
  for (const t of TABLES) {
    const { data, error } = await sb.from(t).select('*');
    if (error) return new Response(`${t}: ${error.message}`, { status: 500 });
    dump[t] = data;
  }
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const { error } = await sb.storage.from('backups').upload(`daily/${day}.json`, JSON.stringify(dump), { contentType: 'application/json', upsert: true });
  if (error) return new Response(error.message, { status: 500 });
  const { data: files } = await sb.storage.from('backups').list('daily', { limit: 1000 });
  const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const old = (files ?? []).filter((f) => f.name.replace('.json', '') < cutoff).map((f) => `daily/${f.name}`);
  if (old.length) await sb.storage.from('backups').remove(old);
  return Response.json({ saved: `daily/${day}.json`, removed: old.length });
});
