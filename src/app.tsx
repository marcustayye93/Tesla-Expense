import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Session } from '@supabase/supabase-js';
import { sb, load, cached, enqueue, flush, queue, patchExpense, softDeleteByDraft, Data, Row } from './db';
import {
  Expense, PaidBy, Person, Split, PURCHASE, live, signed, settlement, balanceSentence, loanSchedule, loanTerms,
  purchasePosition, shortLabel, toInput, fromInput, monthTotals, categoryTotals, monthlyTable, runningCosts, tco, parseCents, sgd, sgd0, todaySG, shiftDays, fmtDate, fmtMonth, daysBetween,
} from './money';
import './style.css';

const CATS = ['Parking', 'ERP and Fines', 'Charging', 'Washing and Detailing', 'Accessories', 'Servicing and Tyres', 'Insurance',
  'Road Tax', 'PPF and Tint', 'Repairs', 'Subscriptions', 'Purchase and Loan', 'Other'];
const CORE_CATS = ['Parking', 'ERP and Fines', 'Charging', 'Washing and Detailing', 'Servicing and Tyres', 'Other'];
const LOCS: [string, string][] = [['DadSolar', "Dad's Solar"], ['Supercharger', 'Supercharger'], ['Home', 'Home'],
  ['PublicAC', 'Mall / carpark'], ['PublicDC', 'Fast charger'], ['Destination', 'Hotel / other']];
const title = (e: Expense) => (e.label ? shortLabel(e.label) : '') || e.vendor || e.note || e.category;
const loanLabel = (p: Row) => p.loan_source || 'Dealer estimate, awaiting DBS letter';
/** Date control in the app's date format; the native picker sits invisibly on top. */
function DateBtn({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  return <label class="in datebtn"><span class="num">{fmtDate(value)}</span>
    <input type="date" value={value} onInput={(e) => onPick(e.currentTarget.value || todaySG())} /></label>;
}
const uuid = () => crypto.randomUUID();
const ls = { get: <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d; } catch { return d; } },
  set: (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v)), del: (k: string) => localStorage.removeItem(k) };

// ---------------- app state ----------------
let setGlobal: (d: Data) => void = () => {};
let session: Session | null = null;
async function refresh() { if (!session) return; await flush(); try { setGlobal(await load(session)); } catch (e) { console.warn(e); } }
/** Optimistic: show the queued record now, sync in the background. */
function addLocal(d: Data, e: Expense, charge?: Row) {
  const next = { ...d, expenses: [e, ...d.expenses], charges: charge ? [...d.charges, charge] : d.charges };
  setGlobal(next); return next;
}

function useHash() {
  const [h, setH] = useState(location.hash || '#/home');
  useEffect(() => { const f = () => setH(location.hash || '#/home'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}

function App() {
  const [ready, setReady] = useState(false);
  const [sess, setSess] = useState<Session | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [pending, setPending] = useState(queue().length);
  setGlobal = (d) => { setData(d); setPending(queue().length); };
  useEffect(() => {
    sb.auth.getSession().then(({ data: { session: s } }) => { session = s; setSess(s); if (s) setData(cached()); setReady(true); if (s) refresh(); });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => { session = s; setSess(s); if (!s) { localStorage.removeItem('yl-cache'); setData(null); } });
    const on = () => refresh();
    addEventListener('online', on);
    const t = setInterval(() => { setPending(queue().length); if (queue().length && navigator.onLine) refresh(); }, 5000);
    return () => { sub.subscription.unsubscribe(); removeEventListener('online', on); clearInterval(t); };
  }, []);
  const hash = useHash();
  if (!ready) return null;
  if (!sess) return <SignIn onIn={() => refresh()} />;
  if (!data) return <main class="mute">Loading</main>;
  if (!data.me) return <main><p>This account is not on the invite list.</p><button class="btn" onClick={() => sb.auth.signOut()}>Sign out</button></main>;
  const [route, qs] = hash.slice(2).split('?');
  const params = new URLSearchParams(qs);
  const page = route === 'add' ? <QuickAdd d={data} params={params} />
    : route === 'charge' ? <ChargeForm d={data} params={params} />
    : route === 'activity' ? <Activity d={data} params={params} />
    : route === 'charging' ? <Charging d={data} />
    : route === 'car' ? <Car d={data} />
    : route === 'settings' ? <Settings d={data} />
    : route === 'settle' ? <SettlementScreen d={data} />
    : <Home d={data} />;
  const nav = (r: string, label: string, cls = '') => <a href={'#/' + r} class={`${cls} ${route === r || (r === 'home' && !route) || (r === 'add' && route === 'charge') || (r === 'car' && route === 'settings') ? 'on' : ''}`}>{cls ? <span>{label}</span> : label}</a>;
  return <div class="shell">
    <nav class="nav">
      <div class="wm"><div class="wordmark">Tesla Expense<b>.</b></div>{pending > 0 && <div class="sync" style="margin-top:8px">{pending} waiting to sync</div>}</div>
      {nav('home', 'Home')}{nav('activity', 'Activity')}{nav('add', 'Add', 'add')}{nav('charging', 'Charging')}{nav('car', 'Car')}
    </nav>
    <main>{pending > 0 && <div class="sync mobile-sync" style="margin-bottom:12px">{pending} waiting to sync</div>}{page}</main>
  </div>;
}

// ---------------- sign in ----------------
/** Name-only sign-in, Marcus's choice. The name maps to that person's allowlisted account
 *  (email looked up server-side) and a fixed derived password; RLS still guards every row. */
const NAMES = ['marcus', 'chesa'];
export const derivedPassword = (name: string) => `Tesla-Expense:${name}:2026`;
function SignIn({ onIn }: { onIn: () => void }) {
  const [word, setWord] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState(ls.get('yl-lock', 0));
  async function go(e: Event) {
    e.preventDefault(); if (busy) return;
    if (Date.now() < until) return setErr('Too many tries. Wait a minute.');
    const name = word.trim().toLowerCase(); setBusy(true); setErr('');
    let ok = false;
    if (NAMES.includes(name)) {
      const { data: email } = await sb.rpc('signin_email', { p_name: name });
      if (email) ok = !(await sb.auth.signInWithPassword({ email, password: derivedPassword(name) })).error;
    } else await new Promise((r) => setTimeout(r, 800)); // same feel as a real attempt
    setBusy(false);
    if (ok) { ls.del('yl-fails'); onIn(); return; }
    const fails = ls.get('yl-fails', 0) + 1; ls.set('yl-fails', fails);
    if (fails >= 5) { const t = Date.now() + 60000; ls.set('yl-lock', t); ls.set('yl-fails', 0); setUntil(t); setErr('Too many tries. Wait a minute.'); }
    else setErr('Not recognised.');
    setWord('');
  }
  return <form class="signin stack" onSubmit={go}>
    <div class="wordmark">Tesla Expense<b>.</b></div>
    <p class="sub">Private.</p>
    <input class="in" data-testid="word" type="password" aria-label="Password" placeholder="Password" autocomplete="off" autocapitalize="off" spellcheck={false} value={word} onInput={(e) => setWord(e.currentTarget.value)} required />
    {err && <p>{err}</p>}
    <button class="btn primary" disabled={busy}>Sign in</button>
  </form>;
}

// ---------------- home ----------------
function Home({ d }: { d: Data }) {
  const p = d.profile!;
  const all = tco(d.expenses);
  const ym = todaySG().slice(0, 7), lastYm = shiftDays(ym + '-01', -1).slice(0, 7);
  const mt = monthTotals(d.expenses, ym), lt = monthTotals(d.expenses, lastYm);
  const diff = mt.total - lt.total;
  const w = settlement(d.expenses, d.settlements);
  const pos = purchasePosition(p as any, d.expenses, new Set(d.paid.map((r) => r.seq)));
  const odo = latestOdo(d);
  const recent = live(d.expenses).slice(0, 3);
  return <div>
    <div class="sub carline">{p.plate || 'Plate pending'} · {p.delivery_date ? `${daysBetween(p.delivery_date, todaySG())} days owned` : 'Delivery date to confirm'}{odo ? ` · ${odo.toLocaleString('en-SG')} km` : ''}</div>
    <div class="hero" data-testid="hero">
      <div class="lbl">This month · {fmtMonth(ym)}</div>
      <div class="big num">{sgd(mt.total)}</div>
      <div class="second num">{sgd(all)} <span class="lbl" style="margin-left:8px">Spent on the car so far</span></div>
    </div>
    <div class="cols">
      <div class="card" data-testid="settle-card"><span class="lbl">Between you</span>
        <div class="fig num" style="font-size:26px">{balanceSentence(w.balance)}</div>
        {w.balance !== 0 && <a class="btn" href="#/settle" style="margin-top:14px">Settle up</a>}
      </div>
      <div class="card" data-testid="next-card"><span class="lbl">Next due</span>
        {pos.next ? <div class="row"><span><span class="sub">Loan instalment</span><br /><span class="mute" style="font-size:14px">{pos.next.due ? fmtDate(pos.next.due) : loanLabel(p)}</span></span><span class="num">{sgd(pos.next.amount)}</span></div>
          : <p class="mute">Nothing due.</p>}
        {pos.remainingDownpayment > 0 && <div class="row"><span class="sub">Still to pay before collection</span><span class="num">{sgd(pos.remainingDownpayment)}</span></div>}
      </div>
    </div>
    <QuickLog d={d} />
    <div class="cols" style="margin-top:12px">
      <div class="card"><span class="lbl">Recent</span>
        {recent.length === 0 && <p class="mute">Nothing logged yet. Tap a Quick log button above.</p>}
        {recent.map((e) => <div class="row"><span><span class="sub">{title(e)}</span><br /><span class="mute" style="font-size:14px">{fmtDate(e.date)} · {e.paid_by}</span></span><span class="num">{sgd(signed(e))}</span></div>)}
        <a class="btn ghost sm" href="#/activity" style="margin-top:12px">All activity</a>
        <p class="mute" style="margin-top:12px;font-size:14px">{diff === 0 ? `This month is the same as ${fmtMonth(lastYm).split(' ')[0]}.` : `This month is ${sgd(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${fmtMonth(lastYm).split(' ')[0]}.`}</p>
      </div>
      <div><Donut d={d} /><MonthTable d={d} /></div>
    </div>
  </div>;
}
const QUICK: [string, string, string][] = [['solar', "Dad's Solar, free", ''], ['Supercharger', 'Supercharger', '#/charge?loc=Supercharger'],
  ['Parking', 'Parking', '#/add?cat=Parking'], ['ERP', 'ERP', '#/add?cat=ERP and Fines'], ['Wash', 'Wash', '#/add?cat=Washing and Detailing'],
  ['Other', 'Other', '#/add?cat=Other']];
/** One tap: Dad's Solar saves at once (free, idempotent on a fresh uuid); the rest open a prefilled form. */
function QuickLog({ d }: { d: Data }) {
  const undo = useUndo(); const [busy, setBusy] = useState(false);
  function solar() {
    if (busy) return; setBusy(true); setTimeout(() => setBusy(false), 1500); // swallow a double tap
    const u = uuid();
    const d2 = queueCharge(d, { uuid: u, date: todaySG(), cents: 0, paid_by: d.me!, loc: 'DadSolar', label: '', kwh: 0, from: null, to: null, credit: false, creditKm: null });
    undo.show(u, `Saved Dad's Solar charge, free. This month ${sgd(monthTotals(d2.expenses, todaySG().slice(0, 7)).total)}.`);
    refresh();
  }
  return <div style="margin-top:20px">
    <span class="lbl">Quick log</span>
    <div class="quick" style="margin-top:8px">{QUICK.map(([k, l, href]) => href
      ? <a class="chip" data-testid={'quick-' + k} href={href}>{l}</a>
      : <button class="chip" data-testid={'quick-' + k} disabled={busy} onClick={solar}>{l}</button>)}</div>
    {undo.last && <div class="confirm" data-testid="confirm" style="margin-top:8px"><span>{undo.last.text}</span><button class="btn sm" onClick={async () => { const u = undo.last!.uuid; undo.clear(); await softDeleteByDraft(u, true).catch(() => {}); refresh(); }}>Undo</button></div>}
  </div>;
}

const GREYS = ['#FFFFFF', '#C9CBCF', '#9A9DA2', '#6E7176', '#4A4D52', '#33363B'];
/** Hand-rolled SVG donut, greys by rank; anything past five slices is grouped. */
function Donut({ d }: { d: Data }) {
  const [all, setAll] = useState(true);
  if (categoryTotals(d.expenses, false).length < 2) return null; // a one-slice donut says nothing
  const raw = categoryTotals(d.expenses, !all);
  const items = raw.length > 6 ? [...raw.slice(0, 5), ['Everything else', raw.slice(5).reduce((a, [, v]) => a + v, 0)] as [string, number]] : raw;
  const total = items.reduce((a, [, v]) => a + v, 0);
  const R = 70, C = 2 * Math.PI * R; let at = 0;
  return <div class="card"><span class="lbl">Spending by category</span>
    <div class="seg" style="margin:8px 0 16px"><button class={`chip ${all ? 'on' : ''}`} onClick={() => setAll(true)}>Everything</button><button class={`chip ${!all ? 'on' : ''}`} onClick={() => setAll(false)}>Day-to-day costs</button></div>
    {total === 0 ? <p class="mute">Nothing logged yet.</p> : <div class="donut">
      <svg viewBox="0 0 180 180" width="180" height="180" role="img" aria-label="Spending by category">
        <circle cx="90" cy="90" r={R} fill="none" stroke="#22262B" stroke-width="28" />
        {items.map(([, v], i) => { const len = (v / total) * C; const el = <circle cx="90" cy="90" r={R} fill="none" stroke={GREYS[i]} stroke-width="28"
          stroke-dasharray={`${Math.max(len - (items.length > 1 ? 1.5 : 0), 0.5)} ${C}`} stroke-dashoffset={-at} transform="rotate(-90 90 90)" />; at += len; return el; })}
        <text x="90" y="86" text-anchor="middle" fill="#8E9196" font-size="11" letter-spacing="1.5">TOTAL</text>
        <text x="90" y="106" text-anchor="middle" fill="#fff" font-size="16" class="num">{sgd0(total)}</text>
      </svg>
      <div class="legend">{items.map(([c, v], i) => <div class="row"><span class="sub" style="display:flex;gap:10px;align-items:center;min-width:0">
        <i style={`width:12px;height:12px;border-radius:2px;flex:none;background:${GREYS[i]}`} /><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{c}</span></span>
        <span class="num" style="white-space:nowrap">{sgd(v)} <span class="mute">{Math.round((v / total) * 100)}%</span></span></div>)}</div>
    </div>}
  </div>;
}

function MonthTable({ d }: { d: Data }) {
  const ym = todaySG().slice(0, 7);
  const rows = monthlyTable(d.expenses).filter((r) => r.ym < ym).slice(0, 12);
  if (rows.length === 0) return null;
  return <div class="card"><span class="lbl">Past months, each person's share</span>
    {<table class="num" style="margin-top:4px"><thead><tr><th>Month</th><th class="r">Total</th><th class="r">Marcus</th><th class="r">Chesa</th></tr></thead>
      <tbody>{rows.map((r) => { const [mo, y] = fmtMonth(r.ym).split(' '); return <tr><td>{mo.slice(0, 3)} {y}</td><td class="r">{sgd0(r.total)}</td><td class="r">{sgd0(r.marcus)}</td><td class="r">{sgd0(r.chesa)}</td></tr>; })}</tbody></table>}
    <p class="mute" style="margin-top:10px;font-size:14px">Shares are 50/50 unless a record says otherwise.</p>
  </div>;
}

const latestOdo = (d: Data) => {
  const xs = [...d.expenses.filter((e) => !e.deleted_at && e.odometer_km).map((e) => [e.date, e.odometer_km!] as const)];
  xs.sort((a, b) => b[0].localeCompare(a[0])); return xs[0]?.[1] ?? null;
};

// ---------------- quick add ----------------
interface Draft { uuid: string; amount: string; category: string; paid_by: PaidBy; date: string; more: boolean; note: string; vendor: string;
  subcategory: string; odometer: string; split_type: Split; split_pct: string; currency: 'SGD' | 'MYR'; fx: string; tags: string; is_refund: boolean }
const blank = (me: Person, cat = ''): Draft => ({ uuid: uuid(), amount: '', category: cat, paid_by: me, date: todaySG(), more: false, note: '', vendor: '',
  subcategory: '', odometer: '', split_type: 'FiftyFifty', split_pct: '', currency: 'SGD', fx: '', tags: '', is_refund: false });
const fromExpense = (e: Expense, me: Person, keepId: boolean): Draft => ({ ...blank(me), uuid: keepId ? e.client_draft_uuid : uuid(),
  amount: (e.amount_cents / 100).toFixed(2), category: e.category, paid_by: e.paid_by, date: keepId ? e.date : todaySG(), note: e.note ?? '',
  vendor: e.vendor ?? '', subcategory: e.subcategory ?? '', odometer: e.odometer_km ? String(e.odometer_km) : '', split_type: e.split_type,
  split_pct: e.split_marcus_percent != null ? String(e.split_marcus_percent) : '', currency: e.currency, fx: e.fx_rate_to_sgd ? String(e.fx_rate_to_sgd) : '',
  tags: e.tags.join(', '), is_refund: e.is_refund, more: true });

function useUndo() {
  const [last, setLast] = useState<{ uuid: string; text: string } | null>(null);
  const t = useRef<number>(0);
  const show = (uuid: string, text: string) => { setLast({ uuid, text }); clearTimeout(t.current); t.current = setTimeout(() => setLast(null), 10000) as any; };
  return { last, show, clear: () => setLast(null) };
}

function QuickAdd({ d, params }: { d: Data; params: URLSearchParams }) {
  const editId = params.get('edit'), dupId = params.get('dup');
  const src = d.expenses.find((e) => e.id === (editId || dupId));
  const KEY = editId ? 'yl-draft-edit-' + editId : 'yl-draft-add';
  const [f, setF] = useState<Draft>(() => {
    const qcat = CATS.includes(params.get('cat') ?? '') ? params.get('cat')! : '';
    const dr = ls.get<Draft | null>(KEY, null);
    if (dr) return qcat && !editId ? { ...dr, category: qcat } : dr;
    return src ? fromExpense(src, d.me!, !!editId) : blank(d.me!, qcat);
  });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const undo = useUndo();
  const set = (p: Partial<Draft>) => { const n = { ...f, ...p }; setF(n); ls.set(KEY, n); };
  const recent = ls.get<string[]>('yl-recent-cats', []);
  const [moreCats, setMoreCats] = useState(false);
  const top = [...new Set([...recent.filter((c) => CATS.includes(c)), ...CORE_CATS])].slice(0, 6);
  if (f.category && !top.includes(f.category)) top.push(f.category);
  const cats = moreCats ? [...top, ...CATS.filter((c) => !top.includes(c))] : top;
  const cents = parseCents(f.amount);
  const fx = Number(f.fx);
  const sgdCents = cents == null ? null : f.currency === 'SGD' ? cents : fx > 0 ? Math.round(cents * fx) : null;

  async function save() {
    if (busy) return; // double tap guard; the server also dedupes on client_draft_uuid
    if (cents == null) return setErr('Enter an amount.');
    if (!f.category) return setErr('Pick a category.');
    if (f.currency === 'MYR' && !(fx > 0)) return setErr('Enter the MYR to SGD rate.');
    if (f.category === 'Other' && !f.note.trim()) return setErr('Other needs a note.');
    if (f.split_type === 'CustomPercent' && !(Number(f.split_pct) >= 0 && Number(f.split_pct) <= 100 && f.split_pct !== '')) return setErr('Enter Marcus percent, 0 to 100.');
    setBusy(true); setErr('');
    const row = { client_draft_uuid: f.uuid, date: f.date, category: f.category, amount_cents: cents, currency: f.currency,
      fx_rate_to_sgd: f.currency === 'MYR' ? fx : null, amount_sgd_cents: sgdCents!, paid_by: f.paid_by, split_type: f.split_type,
      split_marcus_percent: f.split_type === 'CustomPercent' ? Number(f.split_pct) : null, note: f.note.trim() || null,
      vendor: f.vendor.trim() || null, subcategory: f.subcategory.trim() || null, odometer_km: f.odometer ? Number(f.odometer) : null,
      tags: f.tags.split(',').map((s) => s.trim()).filter(Boolean), is_refund: f.is_refund };
    if (editId) {
      try { await patchExpense(editId, row); ls.del(KEY); await refresh(); location.hash = '#/activity'; } catch (e: any) { setErr(e.message); setBusy(false); }
      return;
    }
    enqueue({ t: 'expense', row });
    ls.set('yl-recent-cats', [f.category, ...recent.filter((c) => c !== f.category)].slice(0, 4));
    const d2 = addLocal(d, { ...row, id: 'local-' + f.uuid, kind: 'normal', label: null, deleted_at: null, created_at: new Date().toISOString() } as Expense);
    const mt = monthTotals(d2.expenses, todaySG().slice(0, 7)).total;
    undo.show(f.uuid, `Saved ${f.category}, ${sgd(f.is_refund ? -sgdCents! : sgdCents!)}. This month ${sgd(mt)}. ${balanceSentence(settlement(d2.expenses, d2.settlements).balance)}.`);
    const next = { ...blank(d.me!), paid_by: f.paid_by };
    setF(next); ls.del(KEY); setBusy(false);
    refresh();
  }
  async function doUndo() {
    const u = undo.last!.uuid; undo.clear();
    setGlobal({ ...d, expenses: d.expenses.filter((e) => e.client_draft_uuid !== u) });
    await softDeleteByDraft(u, true).catch(() => {}); refresh();
  }
  return <div class="addwrap stack">
    <h1>{editId ? 'Edit expense' : 'Add Expense'}</h1>
    {undo.last && <div class="confirm" data-testid="confirm"><span>{undo.last.text}</span><button class="btn sm" onClick={doUndo}>Undo</button></div>}
    <div><span class="lbl">Amount{f.currency === 'MYR' ? ' · MYR' : ''}</span>
      <div class="amount"><span>{f.currency === 'MYR' ? 'RM' : 'S$'}</span>
        <input data-testid="amount" inputMode="decimal" placeholder="0.00" value={f.amount} autofocus onInput={(e) => set({ amount: e.currentTarget.value })} class="num" /></div></div>
    <div><span class="lbl">Category</span><div class="chips" style="margin-top:8px">
      {cats.map((c) => <button class={`chip ${f.category === c ? 'on' : ''}`} onClick={() => c === 'Charging' ? (location.hash = '#/charge') : set({ category: c })}>{c}</button>)}
      <button class="chip ghostchip" data-testid="more-cats" onClick={() => setMoreCats(!moreCats)}>{moreCats ? 'Fewer' : 'More…'}</button></div></div>
    <div><span class="lbl">Paid by</span><div class="seg" style="margin-top:8px">
      {(['Marcus', 'Chesa', 'Joint'] as PaidBy[]).map((p) => <button class={`chip ${f.paid_by === p ? 'on' : ''}`} onClick={() => set({ paid_by: p })}>{p}</button>)}</div></div>
    <div><span class="lbl">Date</span><div class="seg" style="margin-top:8px">
      <button class={`chip ${f.date === todaySG() ? 'on' : ''}`} onClick={() => set({ date: todaySG() })}>Today</button>
      <button class={`chip ${f.date === shiftDays(todaySG(), -1) ? 'on' : ''}`} onClick={() => set({ date: shiftDays(todaySG(), -1) })}>Yesterday</button>
      <DateBtn value={f.date} onPick={(v) => set({ date: v })} /></div></div>
    {err && <p>{err}</p>}
    <button data-testid="save" class="btn primary save" onClick={save} disabled={busy}>{editId ? 'Save changes' : 'Save Expense'}</button>
    <button class="linkbtn" data-testid="more-details" onClick={() => set({ more: !f.more })}>{f.more ? 'Hide details' : 'Add note, vendor, split…'}</button>
    {f.more && <div class="grid2">
      <label class="field"><span class="lbl">Note</span><input class="in" value={f.note} onInput={(e) => set({ note: e.currentTarget.value })} /></label>
      <label class="field"><span class="lbl">Vendor</span><input class="in" value={f.vendor} onInput={(e) => set({ vendor: e.currentTarget.value })} /></label>
      <label class="field"><span class="lbl">Subcategory</span><input class="in" value={f.subcategory} onInput={(e) => set({ subcategory: e.currentTarget.value })} /></label>
      <label class="field"><span class="lbl">Odometer km</span><input class="in num" inputMode="numeric" value={f.odometer} onInput={(e) => set({ odometer: e.currentTarget.value.replace(/\D/g, '') })} /></label>
      <label class="field"><span class="lbl">Tags</span><input class="in" placeholder="Paddington, JB" value={f.tags} onInput={(e) => set({ tags: e.currentTarget.value })} /></label>
      <label class="field"><span class="lbl">Split</span><select class="in" value={f.split_type} onChange={(e) => set({ split_type: e.currentTarget.value as Split })}>
        <option value="FiftyFifty">50/50</option><option value="MarcusOnly">Marcus only</option><option value="ChesaOnly">Chesa only</option><option value="CustomPercent">Custom percent</option></select></label>
      {f.split_type === 'CustomPercent' && <label class="field"><span class="lbl">Marcus percent</span><input class="in num" inputMode="decimal" value={f.split_pct} onInput={(e) => set({ split_pct: e.currentTarget.value })} /></label>}
      <label class="field"><span class="lbl">Currency</span><select class="in" value={f.currency} onChange={(e) => set({ currency: e.currentTarget.value as 'SGD' | 'MYR' })}><option>SGD</option><option>MYR</option></select></label>
      {f.currency === 'MYR' && <label class="field"><span class="lbl">Rate, 1 MYR in SGD</span><input class="in num" inputMode="decimal" value={f.fx} onInput={(e) => set({ fx: e.currentTarget.value })} />
        {sgdCents != null && <span class="sub num">= {sgd(sgdCents)}</span>}</label>}
      <label class="field"><span class="lbl">Type</span><select class="in" value={f.is_refund ? 'r' : 'c'} onChange={(e) => set({ is_refund: e.currentTarget.value === 'r' })}><option value="c">Cost</option><option value="r">Refund</option></select></label>
    </div>}
  </div>;
}

// ---------------- charging form ----------------
interface ChargeIn { uuid: string; date: string; cents: number; paid_by: PaidBy; loc: string; label: string; kwh: number;
  from: number | null; to: number | null; credit: boolean; creditKm: number | null }
/** Queue a charge (idempotent on uuid) and show it now. Used by the form and the Home one-tap. */
function queueCharge(d: Data, f: ChargeIn) {
  const locLabel = f.label.trim() || (f.loc === 'DadSolar' ? "Dad's place" : null);
  const p = { client_draft_uuid: f.uuid, date: f.date, amount_cents: f.cents, paid_by: f.paid_by, location_type: f.loc, location_label: locLabel,
    kwh_added: f.kwh > 0 ? f.kwh : null, start_percent: f.from, end_percent: f.to, paid_by_credit: f.credit,
    credit_km_used: f.credit ? f.creditKm : null, label: f.loc === 'DadSolar' ? 'Free, solar' : null, note: null, odometer_km: null };
  enqueue({ t: 'charge', p });
  return addLocal(d, { id: 'local-' + f.uuid, client_draft_uuid: f.uuid, date: f.date, category: 'Charging', kind: 'normal', label: p.label, amount_cents: f.cents,
    currency: 'SGD', fx_rate_to_sgd: null, amount_sgd_cents: f.cents, paid_by: f.paid_by, split_type: 'FiftyFifty', split_marcus_percent: null, note: null,
    vendor: locLabel, subcategory: null, odometer_km: null, is_refund: false, tags: [], deleted_at: null }, { ...p, expense_id: 'local-' + f.uuid });
}

function ChargeForm({ d, params }: { d: Data; params: URLSearchParams }) {
  const KEY = 'yl-draft-charge';
  const qloc = LOCS.some(([k]) => k === params.get('loc')) ? params.get('loc')! : null;
  const init = () => ({ uuid: uuid(), loc: qloc ?? 'DadSolar', label: '', amount: '', kwh: '', from: null as number | null, to: null as number | null, credit: false, creditKm: '', paid_by: d.me as PaidBy, date: todaySG() });
  const [f, setF] = useState(() => { const dr = ls.get<ReturnType<typeof init> | null>(KEY, null); return dr ? (qloc ? { ...dr, loc: qloc } : dr) : init(); });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [more, setMore] = useState(false);
  const undo = useUndo();
  const set = (p: Partial<typeof f>) => { const n = { ...f, ...p }; setF(n); ls.set(KEY, n); };
  const solar = f.loc === 'DadSolar';
  const free = f.loc === 'DadSolar' || f.credit;
  const cents = free ? 0 : parseCents(f.amount);
  const kwh = Number(f.kwh);
  const rate = cents && kwh > 0 ? cents / kwh : null;
  const usedKm = d.charges.reduce((a, c) => a + (c.paid_by_credit ? c.credit_km_used ?? 0 : 0), 0);
  const left = (d.profile!.supercharging_credit_km_total ?? 0) - usedKm;
  const suggestKm = kwh > 0 ? Math.round((kwh / Number(d.profile!.consumption_kwh_per_100km)) * 100) : 0;
  async function save() {
    if (busy) return;
    if (cents == null) return setErr('Enter an amount.');
    setBusy(true); setErr('');
    const d2 = queueCharge(d, { uuid: f.uuid, date: f.date, cents, paid_by: f.paid_by, loc: f.loc, label: f.label, kwh, from: f.from, to: f.to,
      credit: f.credit, creditKm: f.credit ? Number(f.creditKm || suggestKm) : null });
    undo.show(f.uuid, `Saved charge${kwh ? `, ${kwh} kWh` : ''}, ${cents === 0 ? 'free' : sgd(cents)}. This month ${sgd(monthTotals(d2.expenses, todaySG().slice(0, 7)).total)}.`);
    setF({ ...init(), loc: f.loc, paid_by: f.paid_by }); ls.del(KEY); setBusy(false); refresh();
  }
  const step = (v: number | null, dlt: number) => Math.max(0, Math.min(100, (v ?? (dlt > 0 ? 15 : 85)) + dlt));
  return <div class="addwrap stack">
    <h1>Add Charge</h1>
    {undo.last && <div class="confirm" data-testid="confirm"><span>{undo.last.text}</span><button class="btn sm" onClick={async () => { const u = undo.last!.uuid; undo.clear(); await softDeleteByDraft(u, true).catch(() => {}); refresh(); }}>Undo</button></div>}
    <div><span class="lbl">Where</span><div class="tiles" style="margin-top:8px">
      {LOCS.map(([k, l]) => <button data-testid={'loc-' + k} class={`chip ${f.loc === k ? 'on' : ''}`} onClick={() => set({ loc: k, credit: k === 'Supercharger' ? f.credit : false })}>{l}</button>)}</div></div>
    {solar ? <p class="sub" data-testid="solar-note">Free, solar. Just save.</p> : <div class="grid2">
      <div><span class="lbl">Amount</span><div class="amount"><span>S$</span>
        <input data-testid="amount" inputMode="decimal" placeholder="0.00" disabled={free} value={free ? '0.00' : f.amount} onInput={(e) => set({ amount: e.currentTarget.value })} class="num" style="font-size:48px" /></div>
        {free && <span class="sub">Paid by credit</span>}</div>
      <div><span class="lbl">kWh added</span><div class="amount"><input data-testid="kwh" inputMode="decimal" placeholder="0" value={f.kwh} onInput={(e) => set({ kwh: e.currentTarget.value })} class="num" style="font-size:48px" /><span style="font-size:20px">kWh</span></div>
        <span class="sub num">{rate ? `${sgd(Math.round(rate))} per kWh` : ' '}</span></div>
    </div>}
    {f.loc === 'Supercharger' && left > 0 && <div class="seg"><button class={`chip ${f.credit ? 'on' : ''}`} onClick={() => set({ credit: !f.credit })}>Paid by credit · {left.toLocaleString('en-SG')} km left</button>
      {f.credit && <input class="in num" inputMode="numeric" placeholder={`${suggestKm} km`} value={f.creditKm} onInput={(e) => set({ creditKm: e.currentTarget.value.replace(/\D/g, '') })} style="min-height:64px" />}</div>}
    <div><span class="lbl">Paid by</span><div class="seg" style="margin-top:8px">
      {(['Marcus', 'Chesa', 'Joint'] as PaidBy[]).map((p) => <button class={`chip ${f.paid_by === p ? 'on' : ''}`} onClick={() => set({ paid_by: p })}>{p}</button>)}</div></div>
    {err && <p>{err}</p>}
    <button data-testid="save" class="btn primary save" onClick={save} disabled={busy}>Save Charge</button>
    <button class="linkbtn" data-testid="charge-more" onClick={() => setMore(!more)}>{more || f.from != null || f.to != null || f.label ? 'Battery % and place name' : 'Add battery %, place name…'}</button>
    {(more || f.from != null || f.to != null || f.label) && <div class="stack">
      <div class="grid2">
        {(['from', 'to'] as const).map((k) => <div><span class="lbl">Battery {k}</span><div class="seg" style="margin-top:8px">
          <button class="chip" onClick={() => set({ [k]: step(f[k], -5) })}>−</button>
          <span class="chip num" style="display:flex;align-items:center;justify-content:center">{f[k] == null ? '–' : f[k] + '%'}</span>
          <button class="chip" onClick={() => set({ [k]: step(f[k], 5) })}>+</button></div></div>)}
      </div>
      <label class="field"><span class="lbl">Place name, optional</span><input class="in" value={f.label} onInput={(e) => set({ label: e.currentTarget.value })} /></label>
    </div>}
  </div>;
}

// ---------------- activity ----------------
const CSV_FIELDS = ['id', 'client_draft_uuid', 'created_at', 'updated_at', 'entered_by', 'entered_via', 'date', 'category', 'kind', 'subcategory', 'label', 'amount_cents',
  'currency', 'fx_rate_to_sgd', 'amount_sgd_cents', 'paid_by', 'split_type', 'split_marcus_percent', 'note', 'vendor', 'odometer_km', 'is_refund',
  'is_recurring_generated', 'recurring_rule_id', 'receipt_photo_id', 'tags', 'deleted_at'];
function download(name: string, text: string, type: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}
export function toCsv(rows: Row[]) {
  const esc = (v: any) => { const s = v == null ? '' : Array.isArray(v) ? v.join('|') : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '\ufeff' + [CSV_FIELDS.join(','), ...rows.map((r) => CSV_FIELDS.map((k) => esc(r[k])).join(','))].join('\r\n');
}
function exportAll(d: Data, rows: Expense[], tag: string) {
  const ids = new Set(rows.map((r) => r.id));
  download(`tesla-expense-${tag}-${todaySG()}.csv`, toCsv(rows), 'text/csv');
  download(`tesla-expense-${tag}-${todaySG()}.json`, JSON.stringify({ exported_at: new Date().toISOString(), car_profile: d.profile, price_lines: d.priceLines,
    expenses: rows, charging_sessions: d.charges.filter((c) => ids.has(c.expense_id)), settlements: d.settlements, loan_instalments_paid: d.paid,
    reminders: d.reminders, recurring_rules: d.rules, receipts: [] }, null, 2), 'application/json');
}

function Activity({ d, params }: { d: Data; params: URLSearchParams }) {
  const [cat, setCat] = useState(''); const [pb, setPb] = useState(''); const [q, setQ] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const showDeleted = params.get('deleted') === '1'; const [filters, setFilters] = useState(false);
  const [toast, setToast] = useState<Expense | null>(null);
  const cutoff = Date.now() - 30 * 864e5;
  const rows = useMemo(() => d.expenses.filter((e) => (showDeleted ? e.deleted_at && Date.parse(e.deleted_at) > cutoff : !e.deleted_at)
    && (!cat || e.category === cat) && (!pb || e.paid_by === pb)
    && (!q || [e.note, e.vendor, e.subcategory, e.label].some((s) => s?.toLowerCase().includes(q.toLowerCase())))), [d, cat, pb, q, showDeleted]);
  const months = new Map<string, Expense[]>();
  for (const e of rows) { const k = e.date.slice(0, 7); months.set(k, [...(months.get(k) ?? []), e]); }
  async function del(e: Expense, deleted: boolean) {
    await softDeleteByDraft(e.client_draft_uuid, deleted); setOpen(null); setToast(deleted ? e : null); await refresh();
    if (deleted) setTimeout(() => setToast((t) => (t === e ? null : t)), 10000);
  }
  return <div>
    <div class="titlebar"><h1>{showDeleted ? 'Deleted, last 30 days' : 'Activity'}</h1>
      {showDeleted ? <a class="btn sm" href="#/activity">Back</a> : <button class="btn sm" data-testid="filter" onClick={() => setFilters(!filters)}>Filter{cat || pb || q ? ' · on' : ''}</button>}</div>
    {filters && <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:12px">
      <select class="in" value={cat} onChange={(e) => setCat(e.currentTarget.value)}><option value="">All categories</option>{CATS.map((c) => <option>{c}</option>)}</select>
      <select class="in" value={pb} onChange={(e) => setPb(e.currentTarget.value)}><option value="">Anyone paid</option><option>Marcus</option><option>Chesa</option><option>Joint</option></select>
      <input class="in" placeholder="Search note, vendor" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
    </div>}
    {rows.length === 0 && <p class="mute" style="padding:24px 0">{showDeleted ? 'Nothing deleted in the last 30 days.' : 'Expenses you add appear here.'}</p>}
    {[...months.entries()].map(([m, xs]) => <section>
      <div class="month-h"><span class="lbl" style="color:var(--t2)">{fmtMonth(m)}</span><span class="num sub">{sgd(xs.reduce((a, e) => a + (showDeleted ? 0 : signed(e)), 0))}</span></div>
      {xs.map((e) => <div>
        <div class="erow" data-testid="erow" onClick={() => setOpen(open === e.id ? null : e.id)}>
          <span class="mute num" style="font-size:15px">{fmtDate(e.date)}</span>
          <span><span>{title(e)}</span><br /><span class="mute" style="font-size:14px">{e.category} · {e.paid_by}{e.split_type !== 'FiftyFifty' ? ` · ${e.split_type === 'CustomPercent' ? `M ${e.split_marcus_percent}%` : e.split_type === 'MarcusOnly' ? 'Marcus only' : 'Chesa only'}` : ''}{e.id.startsWith('local-') ? ' · waiting to sync' : ''}</span></span>
          <span class="amt num">{sgd(signed(e))}{e.currency === 'MYR' && <><br /><span class="mute" style="font-size:14px">RM {(e.amount_cents / 100).toFixed(2)} @ {e.fx_rate_to_sgd}</span></>}</span>
        </div>
        {open === e.id && <div class="detail">
          {e.label && e.label !== title(e) && <p data-testid="full-label">{e.label}</p>}
          {e.note && <p class="sub">{e.note}</p>}
          <p class="mute" style="font-size:14px;margin:8px 0">{[e.vendor, e.subcategory, e.odometer_km && `${e.odometer_km} km`, e.tags.join(', ')].filter(Boolean).join(' · ')}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">{showDeleted ? <button class="btn sm" onClick={() => del(e, false)}>Restore</button> : <>
            {!e.id.startsWith('local-') && <a class="btn sm" href={`#/add?edit=${e.id}`}>Edit</a>}
            {e.category !== 'Charging' && <a class="btn sm" href={`#/add?dup=${e.id}`}>Duplicate</a>}
            <button class="btn sm" onClick={() => del(e, true)}>Delete</button></>}</div>
        </div>}
      </div>)}
    </section>)}
    {toast && <div class="toast"><span>Deleted.</span><button class="btn sm" onClick={() => del(toast, false)}>Undo</button></div>}
  </div>;
}

// ---------------- charging (Phase 1: log list; stats are Phase 2) ----------------
function Charging({ d }: { d: Data }) {
  const byExp = new Map(d.expenses.map((e) => [e.id, e]));
  const rows = d.charges.filter((c) => !byExp.get(c.expense_id)?.deleted_at).sort((a, b) => b.date.localeCompare(a.date));
  const usedKm = d.charges.reduce((a, c) => a + (c.paid_by_credit ? c.credit_km_used ?? 0 : 0), 0);
  const total = d.profile!.supercharging_credit_km_total, left = total - usedKm;
  return <div>
    <h1>Charging</h1>
    <a class="btn primary" href="#/charge" style="margin-bottom:20px">Add Charge</a>
    <div class="card"><span class="lbl">Supercharging credit</span><div class="fig num">{left.toLocaleString('en-SG')} km left <span class="mute" style="font-size:18px">of {total.toLocaleString('en-SG')}</span></div>
      <div class="bar" style="margin-top:12px"><i style={`width:${Math.max(0, (left / total) * 100)}%;${left <= 200 ? 'background:var(--red)' : ''}`} /></div></div>
    {rows.length === 0 && <p class="mute">Charges you log appear here. Dad's Solar is one tap.</p>}
    {rows.map((c) => <div class="row"><span><span>{LOCS.find((l) => l[0] === c.location_type)?.[1] ?? c.location_type}{c.location_label ? ` · ${c.location_label}` : ''}</span><br />
      <span class="mute" style="font-size:14px">{fmtDate(c.date)}{c.kwh_added ? ` · ${c.kwh_added} kWh` : ''}{c.paid_by_credit ? ` · credit ${c.credit_km_used} km` : ''}</span></span>
      <span class="num">{Number(c.amount_cents) === 0 ? (c.location_type === 'DadSolar' ? 'Free, solar' : 'S$0.00') : sgd(Number(c.amount_cents))}</span></div>)}
  </div>;
}

// ---------------- settlement ----------------
function SettlementScreen({ d }: { d: Data }) {
  const w = settlement(d.expenses, d.settlements);
  const owes: [Person, Person] = w.balance >= 0 ? ['Chesa', 'Marcus'] : ['Marcus', 'Chesa'];
  const [amt, setAmt] = useState(''); const [note, setNote] = useState(''); const [date, setDate] = useState(todaySG()); const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState<Person>(owes[0]);
  const cents = parseCents(amt) ?? Math.abs(w.balance);
  async function settle() {
    if (busy || cents <= 0) return; setBusy(true);
    enqueue({ t: 'settle', row: { client_draft_uuid: uuid(), date, from_person: from, to_person: from === 'Chesa' ? 'Marcus' : 'Chesa', amount_cents: cents, note: note || null } });
    setAmt(''); setNote(''); await refresh(); setBusy(false);
  }
  const lines = ([['Marcus paid', w.marcusPaid], ["Marcus's half", w.marcusShare], ['Chesa paid', w.chesaPaid], ["Chesa's half", w.chesaShare],
    ['Already settled, Chesa to Marcus', w.chesaToMarcus], ['Already settled, Marcus to Chesa', w.marcusToChesa]] as [string, number][]).filter(([, v]) => v !== 0);
  return <div class="cols">
    <div>
      <h1>Settle up</h1>
      <div class="hero" style="cursor:default;padding:0 4px 24px"><div class="big num" style="font-size:44px" data-testid="balance">{balanceSentence(w.balance)}</div></div>
      {w.balance !== 0 && <div class="card stack">
        <div class="seg">{(['Chesa', 'Marcus'] as Person[]).map((p) => <button class={`chip ${from === p ? 'on' : ''}`} onClick={() => setFrom(p)}>{p} pays</button>)}</div>
        <div class="amount"><span>S$</span><input class="num" inputMode="decimal" placeholder={(Math.abs(w.balance) / 100).toFixed(2)} value={amt} onInput={(e) => setAmt(e.currentTarget.value)} style="font-size:44px" /></div>
        <div class="grid2"><DateBtn value={date} onPick={setDate} /><input class="in" placeholder="Note, optional" value={note} onInput={(e) => setNote(e.currentTarget.value)} /></div>
        <button class="btn primary" data-testid="settle-btn" onClick={settle} disabled={busy || cents <= 0}>Mark {sgd(cents)} as paid</button>
      </div>}
    </div>
    <div>
      <details class="card" data-testid="working"><summary class="lbl" style="cursor:pointer;min-height:44px;display:flex;align-items:center">How this is worked out</summary>
        {lines.map(([l, v]) => <div class="row"><span class="sub">{l}</span><span class="num">{sgd(v)}</span></div>)}
        <p class="mute" style="margin-top:12px;font-size:15px">Each cost is split 50/50 unless the record says otherwise. Whoever paid more than their half is owed the difference.</p>
      </details>
      {live(d.settlements).length > 0 && <><h2>Past payments</h2>
        {live(d.settlements).map((s) => <div class="row"><span>{s.from_person} to {s.to_person}<br /><span class="mute" style="font-size:14px">{fmtDate(s.date)}{s.note ? ` · ${s.note}` : ''}</span></span><span class="num">{sgd(s.amount_cents)}</span></div>)}</>}
    </div>
  </div>;
}

// ---------------- car ----------------
const TO_CONFIRM: [string, string, string][] = [['plate', 'Plate', 'text'], ['registration_date', 'Registration date', 'date'], ['coe_expiry_date', 'COE expiry (registration + 10 years)', 'date'],
  ['delivery_date', 'Delivery date', 'date'], ['build_year', 'Build year', 'number'], ['first_instalment_date', 'First instalment date (bank letter)', 'date'],
  ['insurance_premium_cents', 'Insurance premium, S$', 'money'], ['insurance_start_date', 'Insurance start', 'date'], ['insurance_renewal_date', 'Insurance renewal', 'date'],
  ['road_tax_renewal_date', 'Road tax renewal', 'date'], ['odometer_at_delivery_km', 'Odometer at delivery, km', 'number']];
const PROFILE: [string, string, string][] = [['order_number', 'Order number', 'text'], ['model_label', 'Model', 'text'], ['colour', 'Colour', 'text'], ['interior', 'Interior', 'text'],
  ['wheels', 'Wheels', 'text'], ['coe_category', 'COE category', 'text'], ['purchase_price_cents', 'Final price, S$', 'money'], ['final_price_note', 'Price note', 'text'],
  ['coe_rebate_level_cents', 'COE rebate level, S$', 'money'], ['coe_rebate_received_cents', 'COE rebate received, S$', 'money'], ['lender', 'Lender', 'text'],
  ['loan_percent', 'Loan, % of price', 'number'], ['flat_rate_bp', 'Flat interest rate, % a year', 'pct'], ['tenure_months', 'Loan length, months', 'number'],
  ['loan_principal_cents', 'Loan amount from paperwork, S$', 'money'], ['loan_interest_cents', 'Total interest from paperwork, S$', 'money'],
  ['loan_total_cents', 'Total loan payment from paperwork, S$', 'money'], ['loan_monthly_cents', 'Monthly instalment from paperwork, S$', 'money'], ['loan_source', 'Where the loan figures come from', 'text'],
  ['insurance_provider', 'Insurer', 'text'], ['road_tax_annual_cents', 'Road tax a year, S$', 'money'], ['supercharging_credit_km_total', 'Supercharging credit, km', 'number'],
  ['consumption_kwh_per_100km', 'Energy use, kWh per 100 km', 'number'], ['assumed_sc_rate_cents', 'Assumed Supercharger rate, cents per kWh', 'number']];
const LOAN_KEYS = ['purchase_price_cents', 'loan_percent', 'flat_rate_bp', 'tenure_months', 'first_instalment_date', 'loan_principal_cents', 'loan_interest_cents', 'loan_total_cents', 'loan_monthly_cents'];

function Car({ d }: { d: Data }) {
  const p = d.profile!;
  const [showSched, setShowSched] = useState(false); const [msg, setMsg] = useState('');
  const paidSeqs = new Set(d.paid.map((r) => r.seq));
  const t = loanTerms(p as any), sched = loanSchedule(p as any), pos = purchasePosition(p as any, d.expenses, paidSeqs);
  async function markPaid(seq: number, amount: number, due: string | null, paid_by: PaidBy) {
    const row = { client_draft_uuid: uuid(), date: due && due <= todaySG() ? due : todaySG(), category: PURCHASE, kind: 'instalment', label: `Loan instalment ${seq} of ${p.tenure_months}`,
      amount_cents: amount, amount_sgd_cents: amount, paid_by, split_type: 'FiftyFifty' };
    const { data, error } = await sb.from('expenses').insert(row).select('id').single();
    if (error) return setMsg(error.message);
    await sb.from('loan_instalments_paid').insert({ seq, expense_id: data.id, due_date: due }); refresh();
  }
  async function unmark(seq: number) {
    const r = d.paid.find((x) => x.seq === seq); if (!r) return;
    await sb.from('loan_instalments_paid').delete().eq('seq', seq);
    await sb.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', r.expense_id); refresh();
  }
  const [instPayer, setInstPayer] = useState<PaidBy>('Joint');
  const remind = (r: Row) => { if (!r.due_date) return r.pending_label; const n = daysBetween(todaySG(), r.due_date); return n < 0 ? `Overdue by ${-n} days` : n <= r.window_days ? `Due in ${n} days · ${fmtDate(r.due_date)}` : fmtDate(r.due_date); };
  const fact = (l: string, v: unknown) => <div class="row"><span class="sub">{l}</span><span class="num" style="text-align:right">{v == null || v === '' ? <span class="mute">Not yet</span> : String(v)}</span></div>;
  const money = (l: string, v: number) => <div class="row"><span class="sub">{l}</span><span class="num">{sgd(v)}</span></div>;
  const reminders = d.reminders.filter((r) => !r.dismissed_at);
  return <div>
    <div class="titlebar"><h1>Car</h1><a class="btn sm" href="#/settings" data-testid="to-settings">Settings</a></div>
    <div class="cols">
      <div>
        <div class="card" data-testid="car-facts"><span class="lbl">{p.model_label}</span>
          {fact('Colour and wheels', [p.colour, p.wheels].filter(Boolean).join(' · '))}
          {fact('Plate', p.plate)}{fact('Delivery', p.delivery_date && fmtDate(p.delivery_date))}{fact('Insurer', p.insurance_provider)}{fact('Order', p.order_number)}
        </div>
        <div class="card" data-testid="car-price"><span class="lbl">What the car costs</span>
          {money('Price', p.purchase_price_cents)}{money('Downpayment', t.downpayment)}{money('Loan amount', t.principal)}{money('Interest over the loan', t.interest)}
          {p.final_price_note && <p class="mute" style="margin-top:8px;font-size:14px">{p.final_price_note}</p>}
        </div>
      </div>
      <div>
        <div class="card" data-testid="car-loan"><span class="lbl">Loan · {loanLabel(p)}</span>
          {money('Monthly', t.monthly)}
          <div class="row"><span class="sub">Paid</span><span class="num">{pos.paidCount} of {p.tenure_months}</span></div>
          {money('Loan left to repay', pos.loanRemaining)}
          {pos.remainingDownpayment > 0 && money('Still to pay before collection', pos.remainingDownpayment)}
          <button class="btn ghost sm" data-testid="show-schedule" style="margin-top:12px" onClick={() => setShowSched(!showSched)}>{showSched ? 'Hide schedule' : 'Show schedule'}</button>
          {showSched && <div style="margin-top:12px">
            <p class="sub">{t.monthly === t.last ? `${p.tenure_months} × ${sgd(t.monthly)}` : `${p.tenure_months - 1} × ${sgd(t.monthly)}, final ${sgd(t.last)}`}. Total {sgd(t.total)}.</p>
            <span class="lbl" style="margin-top:12px">Paid from</span>
            <div class="seg" style="margin:8px 0 12px">{(['Marcus', 'Chesa', 'Joint'] as PaidBy[]).map((x) => <button class={`chip ${instPayer === x ? 'on' : ''}`} onClick={() => setInstPayer(x)}>{x}</button>)}</div>
            {sched.map((i) => <div class="row"><span class="num">{i.seq}. {i.due ? fmtDate(i.due) : 'Date pending'}</span><span class="num">{sgd(i.amount)}</span>
              {paidSeqs.has(i.seq) ? <button class="btn sm on" style="width:auto;min-height:48px" onClick={() => unmark(i.seq)}>Paid</button>
                : <button class="btn sm" onClick={() => markPaid(i.seq, i.amount, i.due, instPayer)}>Mark paid</button>}</div>)}
            {msg && <p class="sub">{msg}</p>}
          </div>}
        </div>
        {reminders.length > 0 && <div class="card"><span class="lbl">Coming up</span>{reminders.map((r) => <div class="row"><span>{r.label}<br /><span class="mute" style="font-size:14px">{remind(r)}</span></span>
          <button class="btn sm ghost" onClick={async () => { await sb.from('reminders').update({ dismissed_at: new Date().toISOString() }).eq('id', r.id); refresh(); }}>Dismiss</button></div>)}</div>}
      </div>
    </div>
  </div>;
}

function Settings({ d }: { d: Data }) {
  const p = d.profile!;
  const [form, setForm] = useState<Row>(p); const [msg, setMsg] = useState('');
  const loanChanged = LOAN_KEYS.some((k) => String(form[k] ?? '') !== String(p[k] ?? ''));
  async function saveProfile() {
    const patch: Row = {}; for (const [k] of [...TO_CONFIRM, ...PROFILE]) patch[k] = form[k] === '' ? null : form[k];
    if (patch.registration_date && !patch.coe_expiry_date) patch.coe_expiry_date = String(Number(patch.registration_date.slice(0, 4)) + 10) + patch.registration_date.slice(4);
    const { error } = await sb.from('car_profile').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);
    setMsg(error ? error.message : 'Saved.'); refresh();
  }
  const field = ([k, l, ty]: [string, string, string]) => <label class="field"><span class="lbl">{l}</span>
    <input class="in num" type={(ty === 'date' ? 'date' : 'text') as any} inputMode={(ty === 'money' || ty === 'pct' ? 'decimal' : ty === 'number' ? 'numeric' : undefined) as any}
      value={toInput(form[k], ty)} placeholder={ty === 'date' ? '' : 'Not yet'} data-testid={'f-' + k}
      onChange={(e) => setForm({ ...form, [k]: fromInput(e.currentTarget.value, ty) })} /></label>;
  const lineSum = d.priceLines.reduce((a, l) => a + Number(l.amount_cents), 0);
  return <div>
    <div class="titlebar"><h1>Settings</h1><a class="btn sm" href="#/car">Back to car</a></div>
    <div class="cols">
      <div>
        <h2>Fill in at delivery</h2>
        <div class="card"><div class="grid2">{TO_CONFIRM.map(field)}</div></div>
        <h2>Car and loan details</h2>
        <div class="card"><div class="grid2">{PROFILE.map(field)}</div>
          <p class="mute" style="font-size:15px">{p.seller} · {p.battery} · {p.obu} · Autopilot {p.autopilot}</p>
          <p class="mute" style="font-size:15px;margin-top:8px">{p.notes}</p></div>
        {loanChanged && <p class="sub">Changing loan terms changes unpaid instalments. Paid instalments never change.</p>}
        <button class="btn primary save" data-testid="save-profile" onClick={saveProfile}>Save details</button>{msg && <p class="sub" style="margin-top:8px">{msg}</p>}
      </div>
      <div>
        <h2>Price breakdown, before COE</h2>
        <div class="card">{d.priceLines.map((l) => <div class="row"><span class="sub">{l.label}{l.note ? <span class="mute"> · {l.note}</span> : ''}</span>
          <input class="in num" inputMode="decimal" style="width:150px;text-align:right;min-height:48px" value={(Number(l.amount_cents) / 100).toFixed(2)}
            onChange={async (e) => { const c = fromInput(e.currentTarget.value, 'money'); if (c == null) return; await sb.from('price_lines').update({ amount_cents: c }).eq('id', l.id); refresh(); }} /></div>)}
          <div class="row"><span>Total before COE</span><span class="num">{sgd(lineSum)}</span></div></div>
        <h2>Repeating costs</h2>
        <div class="card">{d.rules.map((r) => <div class="row"><span>{r.label}<br /><span class="mute" style="font-size:14px">{r.frequency}{r.auto_create ? ', logs itself' : ', reminder only'}{r.paused ? ` · ${r.paused_label}` : ''}</span></span>
          <span class="num">{r.amount_cents ? sgd(r.amount_cents) : 'Varies'}</span></div>)}</div>
        <h2>Data and account</h2>
        <div class="card" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-testid="export" onClick={() => exportAll(d, d.expenses, 'all')}>Export</button>
          <a class="btn" href="#/activity?deleted=1" data-testid="deleted">Deleted items</a>
          <button class="btn ghost" data-testid="signout" onClick={() => sb.auth.signOut()}>Sign out</button></div>
      </div>
    </div>
  </div>;
}

render(<App />, document.getElementById('app')!);
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js');
