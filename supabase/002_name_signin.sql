-- Name-only sign-in (Marcus's choice, 24 Oct 2026). The client sends a name; this returns that
-- person's allowlisted email so supabase-js can do a normal password sign-in. RLS and the
-- allowlist trigger are unchanged. No emails live in the repository.
create or replace function public.signin_email(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select a.email from public.allowlist a
  where lower(a.person) = lower(trim(p_name)) and a.email not like '%@example.com'
  order by a.email limit 1;
$$;
revoke all on function public.signin_email(text) from public;
grant execute on function public.signin_email(text) to anon, authenticated;
