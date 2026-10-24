import { createClient, Session } from '@supabase/supabase-js';
import type { Expense, Settlement, Person } from './money';

// Public values only. The publishable key is safe in the browser; RLS does the protecting.
export const SUPABASE_URL = 'https://qsjlxxpticfhyjolvbqo.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_X8t6UlOSfExqWzF5zBs6Kw_20zhhPod';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'yl-auth' },
  realtime: { params: {} },
});

export type Row = Record<string, any>;

export interface Data {
  me: Person | null;
  profile: Row | null;
  priceLines: Row[];
  expenses: Expense[];
  charges: Row[];
  settlements: Settlement[];
  paid: Row[];
  reminders: Row[];
  rules: Row[];
}

const CACHE = 'yl-cache';
export const cached = (): Data | null => { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch { return null; } };

export async function load(session: Session): Promise<Data> {
  const q = <T = Row>(p: PromiseLike<{ data: any; error: any }>) => p.then((r) => { if (r.error) throw r.error; return r.data as T; });
  const email = session.user.email?.toLowerCase();
  const [allow, profile, priceLines, expenses, charges, settlements, paid, reminders, rules] = await Promise.all([
    q<Row[]>(sb.from('allowlist').select('email,person')),
    q<Row[]>(sb.from('car_profile').select('*')),
    q<Row[]>(sb.from('price_lines').select('*').order('sort')),
    q<Expense[]>(sb.from('expenses').select('*').order('date', { ascending: false }).order('created_at', { ascending: false })),
    q<Row[]>(sb.from('charging_sessions').select('*')),
    q<Settlement[]>(sb.from('settlements').select('*').order('date', { ascending: false })),
    q<Row[]>(sb.from('loan_instalments_paid').select('*')),
    q<Row[]>(sb.from('reminders').select('*')),
    q<Row[]>(sb.from('recurring_rules').select('*')),
  ]);
  const d: Data = {
    me: (allow.find((a) => a.email === email)?.person as Person) ?? null,
    profile: profile[0] ?? null, priceLines, expenses, charges, settlements, paid, reminders, rules,
  };
  localStorage.setItem(CACHE, JSON.stringify(d));
  return d;
}

// ---------- Offline queue: new records are never blocked on the network ----------

export type Op =
  | { t: 'expense'; row: Row }
  | { t: 'charge'; p: Row }
  | { t: 'settle'; row: Row };

const QKEY = 'yl-queue';
export const queue = (): Op[] => JSON.parse(localStorage.getItem(QKEY) || '[]');
const setQueue = (q: Op[]) => localStorage.setItem(QKEY, JSON.stringify(q));
const opId = (o: Op) => (o.t === 'charge' ? o.p.client_draft_uuid : o.row.client_draft_uuid);

export function enqueue(op: Op) {
  const q = queue();
  if (!q.some((o) => opId(o) === opId(op))) setQueue([...q, op]); // idempotent locally too
}
export function dequeue(uuid: string) { setQueue(queue().filter((o) => opId(o) !== uuid)); }

let flushing: Promise<void> | null = null;
/** Sends queued records. Server dedupes on client_draft_uuid, so retries never duplicate. */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    for (const op of queue()) {
      let error: any;
      if (op.t === 'expense') ({ error } = await sb.from('expenses').upsert(op.row, { onConflict: 'client_draft_uuid', ignoreDuplicates: true }));
      else if (op.t === 'settle') ({ error } = await sb.from('settlements').upsert(op.row, { onConflict: 'client_draft_uuid', ignoreDuplicates: true }));
      else ({ error } = await sb.rpc('add_charge', { p: op.p }));
      if (error) { if (isNetwork(error)) break; console.error(error); }
      dequeue(opId(op)); // sent, or rejected by the server for good
    }
  })().finally(() => { flushing = null; });
  return flushing;
}
const isNetwork = (e: any) => !navigator.onLine || /fetch|network|Failed/i.test(String(e?.message ?? e));

export async function patchExpense(id: string, patch: Row) {
  const { error } = await sb.from('expenses').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}
export async function softDeleteByDraft(uuid: string, deleted: boolean) {
  dequeue(uuid);
  const { error } = await sb.from('expenses').update({ deleted_at: deleted ? new Date().toISOString() : null }).eq('client_draft_uuid', uuid);
  if (error) throw error;
}
