// Pure money maths. All amounts are integer cents. No I/O here.

export type Person = 'Marcus' | 'Chesa';
export type PaidBy = Person | 'Joint';
export type Split = 'FiftyFifty' | 'MarcusOnly' | 'ChesaOnly' | 'CustomPercent';
export type Kind = 'normal' | 'order_fee' | 'deposit' | 'downpayment' | 'instalment' | 'coe_rebate';

export interface Expense {
  id: string;
  client_draft_uuid: string;
  date: string; // ISO yyyy-mm-dd, Asia/Singapore
  category: string;
  kind: Kind;
  label: string | null;
  amount_cents: number;
  currency: 'SGD' | 'MYR';
  fx_rate_to_sgd: number | null;
  amount_sgd_cents: number;
  paid_by: PaidBy;
  split_type: Split;
  split_marcus_percent: number | null;
  note: string | null;
  vendor: string | null;
  subcategory: string | null;
  odometer_km: number | null;
  is_refund: boolean;
  tags: string[];
  deleted_at: string | null;
  entered_via?: string;
  created_at?: string;
}

export interface Settlement {
  id: string;
  date: string;
  from_person: Person;
  to_person: Person;
  amount_cents: number;
  note: string | null;
  deleted_at: string | null;
}

export const PURCHASE = 'Purchase and Loan';

export const live = <T extends { deleted_at: string | null }>(xs: T[]) => xs.filter((x) => !x.deleted_at);

/** Signed SGD cents: refunds count negative. */
export const signed = (e: Expense) => (e.is_refund ? -e.amount_sgd_cents : e.amount_sgd_cents);

/** Split `total` so the two parts always sum exactly to `total`. Marcus gets the rounded part. */
function part(total: number, marcusPercent: number): [number, number] {
  const m = Math.round((total * marcusPercent) / 100);
  return [m, total - m];
}

export function marcusSharePercent(e: Pick<Expense, 'split_type' | 'split_marcus_percent'>): number {
  switch (e.split_type) {
    case 'FiftyFifty': return 50;
    case 'MarcusOnly': return 100;
    case 'ChesaOnly': return 0;
    case 'CustomPercent': return Number(e.split_marcus_percent ?? 50);
  }
}

/** Per expense: what each person paid and what each owes as their share (signed for refunds). */
export function contributions(e: Expense) {
  const amt = signed(e);
  const [marcusShare, chesaShare] = part(amt, marcusSharePercent(e));
  const [marcusPaid, chesaPaid] =
    e.paid_by === 'Marcus' ? [amt, 0] : e.paid_by === 'Chesa' ? [0, amt] : part(amt, 50);
  return { marcusShare, chesaShare, marcusPaid, chesaPaid };
}

export interface SettlementWorking {
  marcusPaid: number; chesaPaid: number;
  marcusShare: number; chesaShare: number;
  chesaToMarcus: number; marcusToChesa: number;
  /** Positive: Chesa owes Marcus. Negative: Marcus owes Chesa. */
  balance: number;
}

export function settlement(expenses: Expense[], settlements: Settlement[]): SettlementWorking {
  const w = { marcusPaid: 0, chesaPaid: 0, marcusShare: 0, chesaShare: 0, chesaToMarcus: 0, marcusToChesa: 0, balance: 0 };
  for (const e of live(expenses)) {
    const c = contributions(e);
    w.marcusPaid += c.marcusPaid; w.chesaPaid += c.chesaPaid;
    w.marcusShare += c.marcusShare; w.chesaShare += c.chesaShare;
  }
  for (const s of live(settlements)) {
    if (s.from_person === 'Chesa') w.chesaToMarcus += s.amount_cents; else w.marcusToChesa += s.amount_cents;
  }
  w.balance = w.marcusPaid - w.marcusShare - w.chesaToMarcus + w.marcusToChesa;
  return w;
}

export function balanceSentence(balance: number): string {
  if (balance === 0) return 'All square';
  return balance > 0 ? `Chesa owes Marcus ${sgd(balance)}` : `Marcus owes Chesa ${sgd(-balance)}`;
}

// ---------- Loan ----------

export interface LoanProfile {
  purchase_price_cents: number;
  loan_percent: number; // e.g. 60
  flat_rate_bp: number; // basis points per year, 1.38% = 138
  tenure_months: number;
  first_instalment_date: string | null;
  // Paperwork figures (dealer sheet, later the bank letter). Each one, when set, wins over the derived value.
  loan_principal_cents?: number | null;
  loan_interest_cents?: number | null;
  loan_total_cents?: number | null;
  loan_monthly_cents?: number | null;
}

export function loanTerms(p: LoanProfile) {
  const principal = p.loan_principal_cents ?? Math.round((p.purchase_price_cents * Number(p.loan_percent)) / 100);
  const downpayment = p.purchase_price_cents - principal;
  // flat interest = principal x rate x years = principal x bp/10000 x months/12
  const interest = p.loan_interest_cents ?? Math.round((principal * p.flat_rate_bp * p.tenure_months) / 120000);
  const total = p.loan_total_cents ?? principal + interest;
  const monthly = p.loan_monthly_cents ?? Math.floor(total / p.tenure_months);
  const last = total - monthly * (p.tenure_months - 1);
  return { principal, downpayment, interest, total, monthly, last };
}

export interface Instalment { seq: number; amount: number; interest: number; principal: number; due: string | null }

/** Generated schedule. The final instalment absorbs all rounding, so the schedule sums exactly. */
export function loanSchedule(p: LoanProfile): Instalment[] {
  const t = loanTerms(p);
  const n = p.tenure_months;
  const intEach = Math.floor(t.interest / n);
  const out: Instalment[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const isLast = seq === n;
    const amount = isLast ? t.last : t.monthly;
    const interest = isLast ? t.interest - intEach * (n - 1) : intEach;
    out.push({ seq, amount, interest, principal: amount - interest, due: p.first_instalment_date ? addMonths(p.first_instalment_date, seq - 1) : null });
  }
  return out;
}

// ---------- Totals ----------

export const tco = (xs: Expense[]) => live(xs).reduce((a, e) => a + signed(e), 0);
/** Running Costs: everything except the Purchase and Loan category. */
export const runningCosts = (xs: Expense[]) => live(xs).filter((e) => e.category !== PURCHASE).reduce((a, e) => a + signed(e), 0);

export function purchasePosition(p: LoanProfile & { coe_rebate_received_cents: number }, xs: Expense[], paidSeqs: Set<number>) {
  const t = loanTerms(p);
  const sched = loanSchedule(p);
  const sumKind = (k: Kind) => live(xs).filter((e) => e.kind === k).reduce((a, e) => a + signed(e), 0);
  const deposits = sumKind('deposit');
  const downpaymentPaid = deposits + sumKind('downpayment');
  const instalmentsPaid = sumKind('instalment');
  const unpaid = sched.filter((i) => !paidSeqs.has(i.seq));
  return {
    effectivePrice: p.purchase_price_cents - p.coe_rebate_received_cents,
    downpayment: t.downpayment,
    remainingDownpayment: t.downpayment - downpaymentPaid,
    paidTowardCar: downpaymentPaid + instalmentsPaid,
    loanRemaining: unpaid.reduce((a, i) => a + i.amount, 0),
    principalRemaining: unpaid.reduce((a, i) => a + i.principal, 0),
    paidCount: sched.length - unpaid.length,
    next: unpaid[0] ?? null,
    terms: t,
  };
}

export function monthTotals(xs: Expense[], ym: string) {
  const byCat = new Map<string, number>();
  let total = 0;
  for (const e of live(xs)) if (e.date.startsWith(ym)) { total += signed(e); byCat.set(e.category, (byCat.get(e.category) ?? 0) + signed(e)); }
  return { total, byCat: [...byCat.entries()].sort((a, b) => b[1] - a[1]) };
}

// ---------- Parsing and formatting ----------

/** "12.3" -> 1230. Returns null for anything that is not a plain amount. */
export function parseCents(s: string): number | null {
  const m = s.trim().replace(/,/g, '').match(/^(\d{0,9})(?:\.(\d{0,2}))?$/);
  if (!m || (m[1] === '' && !m[2])) return null;
  return Number(m[1] || 0) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const fmt = new Intl.NumberFormat('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const sgd = (c: number) => (c < 0 ? '-' : '') + 'S$' + fmt.format(Math.abs(c) / 100);
export const sgd0 = (c: number) => (c < 0 ? '-' : '') + 'S$' + Math.round(Math.abs(c) / 100).toLocaleString('en-SG');

export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export const todaySG = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
export const shiftDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (iso: string | null) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${Number(d)} ${MON[+m - 1]} ${y}`; };
export const fmtMonth = (ym: string) => { const [y, m] = ym.split('-'); return `${['January','February','March','April','May','June','July','August','September','October','November','December'][+m - 1]} ${y}`; };

// ---------- Charts ----------

/** Live spend by category, largest first. `running` leaves out Purchase and Loan. */
export function categoryTotals(xs: Expense[], running: boolean): [string, number][] {
  const m = new Map<string, number>();
  for (const e of live(xs)) if (!running || e.category !== PURCHASE) m.set(e.category, (m.get(e.category) ?? 0) + signed(e));
  return [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}

export interface MonthRow { ym: string; total: number; marcus: number; chesa: number }
/** Spend per month with each person's share under the split, newest first. */
export function monthlyTable(xs: Expense[]): MonthRow[] {
  const m = new Map<string, MonthRow>();
  for (const e of live(xs)) {
    const ym = e.date.slice(0, 7), c = contributions(e);
    const r = m.get(ym) ?? { ym, total: 0, marcus: 0, chesa: 0 };
    r.total += signed(e); r.marcus += c.marcusShare; r.chesa += c.chesaShare; m.set(ym, r);
  }
  return [...m.values()].sort((a, b) => b.ym.localeCompare(a.ym));
}
