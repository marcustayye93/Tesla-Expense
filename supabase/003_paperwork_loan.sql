-- Paperwork loan figures (dealer sheet, later the bank letter). When set, each one wins over the derived value.
alter table public.car_profile
  add column if not exists loan_principal_cents bigint,
  add column if not exists loan_interest_cents bigint,
  add column if not exists loan_total_cents bigint,
  add column if not exists loan_monthly_cents bigint,
  add column if not exists loan_source text;
