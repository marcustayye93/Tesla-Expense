-- Y Ledger schema. Seed data is applied separately (not committed to the repo).
create schema if not exists app_private;

create table public.allowlist (
  email text primary key check (email = lower(email)),
  person text not null check (person in ('Marcus','Chesa')),
  created_at timestamptz not null default now()
);

create or replace function app_private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.allowlist a
                 where a.email = lower(coalesce(auth.jwt()->>'email','')));
$$;
revoke all on function app_private.is_member() from public;
grant usage on schema app_private to authenticated;
grant execute on function app_private.is_member() to authenticated;

-- Invite only: block any auth sign up whose email is not allowlisted.
create or replace function app_private.block_unlisted_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.allowlist a where a.email = lower(new.email)) then
    raise exception 'Sign up is invite only';
  end if;
  return new;
end $$;
create trigger block_unlisted_signup before insert on auth.users
  for each row execute function app_private.block_unlisted_signup();

create table public.car_profile (
  id int primary key default 1 check (id = 1),
  order_number text, order_date date, seller text,
  model_label text, battery text, coe_category text, colour text, wheels text,
  interior text, seats text, autopilot text, obu text,
  plate text, registration_date date, coe_expiry_date date, delivery_date date,
  build_year int, power_share_v2l boolean,
  purchase_price_cents bigint not null, final_price_note text,
  coe_rebate_level_cents bigint, coe_rebate_received_cents bigint not null default 0,
  deposit_cents bigint, deposit_paid_by text,
  loan_enabled boolean not null default true, lender text,
  loan_percent numeric(5,2) not null, flat_rate_bp int not null, tenure_months int not null,
  first_instalment_date date,
  insurance_provider text, insurance_premium_cents bigint, insurance_start_date date,
  insurance_renewal_date date,
  road_tax_annual_cents bigint not null default 0, road_tax_renewal_date date,
  supercharging_credit_km_total int not null default 0,
  odometer_at_delivery_km int,
  consumption_kwh_per_100km numeric(5,2) not null default 15,
  assumed_sc_rate_cents int not null default 65,
  notes text,
  updated_at timestamptz not null default now()
);

create table public.price_lines (
  id uuid primary key default gen_random_uuid(),
  sort int not null, label text not null, amount_cents bigint not null, note text
);

create table public.recurring_rules (
  id uuid primary key default gen_random_uuid(),
  label text not null, category text not null, amount_cents bigint,
  paid_by text, frequency text not null check (frequency in ('Monthly','Yearly','CustomMonths')),
  interval_months int, next_due_date date, end_date date,
  auto_create boolean not null default false, paused boolean not null default false,
  paused_label text, reminder_days_before int[] not null default '{7}'
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  client_draft_uuid uuid not null unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  entered_by uuid default auth.uid(), entered_via text not null default 'form',
  date date not null,
  category text not null check (category in ('Purchase and Loan','Charging','Insurance','Road Tax',
    'Servicing and Tyres','Accessories','PPF and Tint','Parking','ERP and Fines',
    'Washing and Detailing','Repairs','Subscriptions','Other')),
  kind text not null default 'normal' check (kind in ('normal','order_fee','deposit','downpayment','instalment','coe_rebate')),
  subcategory text, label text,
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'SGD' check (currency in ('SGD','MYR')),
  fx_rate_to_sgd numeric(12,6),
  amount_sgd_cents bigint not null check (amount_sgd_cents >= 0),
  paid_by text not null check (paid_by in ('Marcus','Chesa','Joint')),
  split_type text not null default 'FiftyFifty' check (split_type in ('FiftyFifty','MarcusOnly','ChesaOnly','CustomPercent')),
  split_marcus_percent numeric(5,2),
  note text, vendor text, odometer_km int,
  is_refund boolean not null default false,
  is_recurring_generated boolean not null default false,
  recurring_rule_id uuid references public.recurring_rules(id),
  receipt_photo_id uuid, tags text[] not null default '{}',
  deleted_at timestamptz,
  check (currency = 'SGD' or fx_rate_to_sgd is not null),
  check (split_type <> 'CustomPercent' or split_marcus_percent between 0 and 100),
  check (category <> 'Other' or coalesce(note,'') <> '')
);
create index on public.expenses (date desc);

create table public.charging_sessions (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null unique references public.expenses(id) on delete cascade,
  date date not null, entered_by uuid default auth.uid(), paid_by text not null,
  location_type text not null check (location_type in ('DadSolar','Home','Supercharger','PublicAC','PublicDC','Destination','Other')),
  location_label text, kwh_added numeric(7,2), amount_cents bigint not null default 0,
  rate_per_kwh_cents numeric(8,2), start_percent int, end_percent int, odometer_km int,
  paid_by_credit boolean not null default false, credit_km_used int, note text,
  entered_via text not null default 'form'
);

create table public.odometer_readings (
  id uuid primary key default gen_random_uuid(), date date not null, odometer_km int not null,
  source text not null default 'manual', note text
);

create table public.loan_instalments_paid (
  seq int primary key check (seq between 1 and 600),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  due_date date
);

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  client_draft_uuid uuid not null unique,
  date date not null, from_person text not null check (from_person in ('Marcus','Chesa')),
  to_person text not null check (to_person in ('Marcus','Chesa') and to_person <> from_person),
  amount_cents bigint not null check (amount_cents > 0), note text,
  created_at timestamptz not null default now(), deleted_at timestamptz
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(), label text not null, due_date date,
  pending_label text,
  type text not null check (type in ('RoadTax','Insurance','Loan','Service','Tyre','Inspection','Custom')),
  related_category text, window_days int not null default 30,
  dismissed_at timestamptz, completed_expense_id uuid references public.expenses(id)
);

create table public.receipts (
  id uuid primary key default gen_random_uuid(), expense_id uuid references public.expenses(id),
  file_ref text not null, mime_type text, uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- RLS: every table, members only.
do $$ declare t text; begin
  foreach t in array array['allowlist','car_profile','price_lines','recurring_rules','expenses',
    'charging_sessions','odometer_readings','loan_instalments_paid','settlements','reminders','receipts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    if t = 'allowlist' then
      execute format('create policy members_read on public.%I for select to authenticated using (app_private.is_member())', t);
    else
      execute format('create policy members_all on public.%I for all to authenticated using (app_private.is_member()) with check (app_private.is_member())', t);
    end if;
  end loop;
end $$;

-- Atomic, idempotent charge save (security invoker, so RLS applies).
create or replace function public.add_charge(p jsonb) returns uuid
language plpgsql set search_path = public as $$
declare eid uuid;
begin
  insert into expenses (client_draft_uuid, date, category, amount_cents, amount_sgd_cents, paid_by,
                        note, vendor, odometer_km, label)
  values ((p->>'client_draft_uuid')::uuid, (p->>'date')::date, 'Charging',
          (p->>'amount_cents')::bigint, (p->>'amount_cents')::bigint, p->>'paid_by',
          p->>'note', p->>'location_label', (p->>'odometer_km')::int, p->>'label')
  on conflict (client_draft_uuid) do nothing
  returning id into eid;
  if eid is null then
    select id into eid from expenses where client_draft_uuid = (p->>'client_draft_uuid')::uuid;
    return eid;
  end if;
  insert into charging_sessions (expense_id, date, paid_by, location_type, location_label, kwh_added,
    amount_cents, rate_per_kwh_cents, start_percent, end_percent, odometer_km, paid_by_credit, credit_km_used, note)
  values (eid, (p->>'date')::date, p->>'paid_by', p->>'location_type', p->>'location_label',
    (p->>'kwh_added')::numeric, (p->>'amount_cents')::bigint,
    case when (p->>'kwh_added')::numeric > 0 then round((p->>'amount_cents')::numeric / (p->>'kwh_added')::numeric, 2) end,
    (p->>'start_percent')::int, (p->>'end_percent')::int, (p->>'odometer_km')::int,
    coalesce((p->>'paid_by_credit')::boolean,false), (p->>'credit_km_used')::int, p->>'note');
  return eid;
end $$;
revoke execute on function public.add_charge(jsonb) from anon, public;
grant execute on function public.add_charge(jsonb) to authenticated;

-- Private backups bucket: no policies, so only the service role (backup function) can touch it.
insert into storage.buckets (id, name, public) values ('backups','backups', false) on conflict do nothing;
