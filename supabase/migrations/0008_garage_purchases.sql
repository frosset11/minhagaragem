-- Extra garages. An account's garage allowance is:
--   accounts.garage_limit (1 included + any bought, US$20 each, one-time via Stripe Checkout)
--   + 3 while the account owns a garage on the Concierge plan (included at no extra cost)
-- If Concierge ends, garages already made stay; only new ones are blocked.

alter table public.accounts add column if not exists stripe_customer_id text unique;

-- One row per paid Checkout session, so a replayed webhook never adds slots twice
create table public.garage_purchases (
  session_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  amount_total integer,
  currency text,
  created_at timestamptz not null default now()
);
alter table public.garage_purchases enable row level security;
create policy "own purchases" on public.garage_purchases for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.garage_purchases from anon, authenticated;
grant select on public.garage_purchases to authenticated;

create or replace function private.concierge_garages() returns integer language sql immutable as $$ select 3 $$;

create or replace function private.garage_allowance(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with a as (select coalesce((select garage_limit from public.accounts where user_id = p_user), 1) as lim),
       c as (select exists (select 1 from public.garage_members m join public.garages g on g.id = m.garage_id
                            where m.user_id = p_user and m.role = 'owner' and g.plan = 'concierge') as on_c),
       o as (select count(*)::int as n from public.garage_members where user_id = p_user and role = 'owner')
  select jsonb_build_object(
    'included', least(a.lim, 1), 'bought', greatest(a.lim - 1, 0),
    'concierge', case when c.on_c then private.concierge_garages() else 0 end,
    'total', a.lim + case when c.on_c then private.concierge_garages() else 0 end,
    'owned', o.n)
  from a, c, o
$$;
revoke execute on function private.garage_allowance(uuid) from public, anon, authenticated;

-- What the app shows in Account
create or replace function public.garage_allowance() returns jsonb
language sql stable security definer set search_path = '' as $$ select private.garage_allowance(auth.uid()) $$;
revoke execute on function public.garage_allowance() from public, anon;
grant execute on function public.garage_allowance() to authenticated;

create or replace function public.create_garage(p_name text, p_currency text default 'BRL', p_unit text default 'km', p_lang text default 'pt')
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); em text := lower(auth.jwt() ->> 'email'); g uuid; al jsonb;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  perform pg_advisory_xact_lock(hashtext('create_garage:' || uid::text)); -- two tabs can't both take the last slot
  al := private.garage_allowance(uid);
  if (al ->> 'owned')::int >= (al ->> 'total')::int then
    raise exception 'garage_limit:%', al ->> 'total';
  end if;
  insert into public.garages(name, currency, distance_unit, lang, created_by)
    values (trim(p_name), p_currency, p_unit, p_lang, uid) returning id into g;
  insert into public.garage_members(garage_id, user_id, email, role) values (g, uid, em, 'owner');
  return g;
end $$;
revoke execute on function public.create_garage(text,text,text,text) from public, anon;
grant execute on function public.create_garage(text,text,text,text) to authenticated;

-- Called by the Stripe webhook (service role only) when an extra-garage Checkout is paid
create or replace function public.grant_garage_slots(p_user uuid, p_session text, p_qty integer, p_amount integer, p_currency text)
returns integer language plpgsql security definer set search_path = '' as $$
declare lim integer;
begin
  insert into public.garage_purchases(session_id, user_id, quantity, amount_total, currency)
    values (p_session, p_user, p_qty, p_amount, p_currency) on conflict (session_id) do nothing;
  if not found then return null; end if; -- already applied
  insert into public.accounts(user_id, garage_limit) values (p_user, 1 + p_qty)
    on conflict (user_id) do update set garage_limit = public.accounts.garage_limit + p_qty
    returning garage_limit into lim;
  return lim;
end $$;
revoke execute on function public.grant_garage_slots(uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.grant_garage_slots(uuid, text, integer, integer, text) to service_role;
