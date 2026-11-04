-- Allowances: each garage holds a number of active (not sold) vehicles; each account owns a number of garages.
-- Defaults: 5 vehicles per garage, 1 garage per account. Extra slots are sold (US$1 per vehicle and
-- US$20 per garage, one-time) and raised with the admin functions below until billing is automated.

alter table public.garages add column vehicle_limit integer not null default 5 check (vehicle_limit >= 0);

create table public.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  garage_limit integer not null default 1 check (garage_limit >= 0),
  created_at timestamptz not null default now()
);
alter table public.accounts enable row level security;
create policy "own account" on public.accounts for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.accounts from anon, authenticated;
grant select on public.accounts to authenticated;

-- Owners may only edit these garage columns; plan and allowances are set by billing or an admin.
revoke update on public.garages from authenticated;
grant update (name, currency, distance_unit, lang, logo_url, bg_color, show_bikes) on public.garages to authenticated;

-- Garage cap comes from the account (1 unless more were bought)
create or replace function public.create_garage(p_name text, p_currency text default 'BRL', p_unit text default 'km', p_lang text default 'pt')
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); em text := lower(auth.jwt() ->> 'email'); g uuid; lim integer;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  lim := coalesce((select garage_limit from public.accounts where user_id = uid), 1);
  if (select count(*) from public.garage_members where user_id = uid and role = 'owner') >= lim then
    raise exception 'garage_limit:%', lim;
  end if;
  insert into public.garages(name, currency, distance_unit, lang, created_by)
    values (trim(p_name), p_currency, p_unit, p_lang, uid) returning id into g;
  insert into public.garage_members(garage_id, user_id, email, role) values (g, uid, em, 'owner');
  return g;
end $$;
revoke execute on function public.create_garage(text,text,text,text) from public, anon;
grant execute on function public.create_garage(text,text,text,text) to authenticated;

-- Vehicle cap: counted on add, and when a sold vehicle is brought back
create or replace function private.vehicle_cap() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lim integer; n integer;
begin
  if new.status = 'sold' then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'sold' then return new; end if;
  select vehicle_limit into lim from public.garages where id = new.garage_id for update;
  select count(*) into n from public.vehicles where garage_id = new.garage_id and status <> 'sold' and id <> new.id;
  if n >= lim then raise exception 'vehicle_limit:%', lim; end if;
  return new;
end $$;
create trigger vehicle_cap before insert or update of status on public.vehicles for each row execute function private.vehicle_cap();

-- Admin: run in the Supabase SQL editor after a customer pays
--   select private.add_vehicle_slots('<garage id>', 5);
--   select private.add_garage_slots('customer@email.com', 1);
create or replace function private.add_vehicle_slots(p_garage uuid, p_n integer) returns integer
language sql security definer set search_path = '' as $$
  update public.garages set vehicle_limit = vehicle_limit + p_n where id = p_garage returning vehicle_limit
$$;
create or replace function private.add_garage_slots(p_email text, p_n integer) returns integer
language sql security definer set search_path = '' as $$
  insert into public.accounts(user_id, garage_limit)
    select id, 1 + p_n from auth.users where lower(email) = lower(trim(p_email))
  on conflict (user_id) do update set garage_limit = public.accounts.garage_limit + p_n
  returning garage_limit
$$;
revoke execute on function private.vehicle_cap(), private.add_vehicle_slots(uuid, integer), private.add_garage_slots(text, integer) from public, anon, authenticated;
