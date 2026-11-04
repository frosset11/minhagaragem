-- Minha Garagem: one shared database, every garage private to its members.

create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- ── Garages and who belongs to them ─────────────────────────────────────────
create table public.garages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  currency text not null default 'BRL' check (currency in ('BRL','USD')),
  distance_unit text not null default 'km' check (distance_unit in ('km','mi')),
  lang text not null default 'pt' check (lang in ('pt','en')),
  plan text not null default 'free' check (plan in ('free','pro','concierge')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table public.garage_members (
  garage_id uuid not null references public.garages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null check (email = lower(email)),
  name text,
  role text not null default 'editor' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key (garage_id, user_id)
);
create index on public.garage_members(user_id);

create table public.garage_invites (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  email text not null check (email = lower(email)),
  role text not null default 'editor' check (role in ('editor','viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (garage_id, email)
);
create index on public.garage_invites(email);

-- ── Access helpers (security definer, not exposed through the API) ──────────
create or replace function private.role_in(g uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.garage_members where garage_id = g and user_id = (select auth.uid())
$$;
create or replace function private.can_read(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.garage_members where garage_id = g and user_id = (select auth.uid()))
$$;
create or replace function private.can_write(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.garage_members where garage_id = g and user_id = (select auth.uid()) and role in ('owner','editor'))
$$;
create or replace function private.is_owner(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.garage_members where garage_id = g and user_id = (select auth.uid()) and role = 'owner')
$$;
grant execute on function private.role_in(uuid), private.can_read(uuid), private.can_write(uuid), private.is_owner(uuid) to authenticated;

create or replace function private.touch_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce((select auth.jwt()) ->> 'email', new.updated_by);
  return new;
end $$;

-- ── Vehicles and their history ──────────────────────────────────────────────
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  kind text not null check (kind in ('car','bike')),
  year integer check (year between 1885 and 2100),
  make text not null,
  model text, trim_level text, nickname text, colour text, vin text, plate text,
  engine text, transmission text, drivetrain text, power text,
  meter text not null default 'distance' check (meter in ('distance','hours','both')),
  odometer integer check (odometer >= 0),
  odometer_unit text not null default 'km' check (odometer_unit in ('mi','km')),
  odometer_date date,
  hours numeric check (hours >= 0),
  currency text not null default 'BRL' check (currency in ('USD','BRL')),
  purchase_date date, purchase_price numeric check (purchase_price >= 0), purchased_from text,
  status text not null default 'owned' check (status in ('owned','project','stored','sold')),
  sold_date date, sold_price numeric check (sold_price >= 0),
  estimated_value numeric check (estimated_value >= 0), value_date date,
  value_source text not null default 'auto' check (value_source in ('auto','manual')),
  fipe_type text check (fipe_type in ('carros','motos')), fipe_brand text, fipe_model text, fipe_year text,
  fipe_label text, fipe_code text, fipe_value numeric check (fipe_value >= 0), fipe_ref text, fipe_checked date,
  co_owners text, location text, photo_url text, notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index on public.vehicles(garage_id);

-- Child rows carry garage_id too (fast access checks); a trigger copies it from the vehicle
create or replace function private.set_garage() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select garage_id into new.garage_id from public.vehicles where id = new.vehicle_id;
  if new.garage_id is null then raise exception 'Vehicle not found'; end if;
  return new;
end $$;

create table public.service_records (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  date date, mileage integer check (mileage >= 0), mileage_approx boolean not null default false,
  hours numeric check (hours >= 0),
  shop text, title text not null, items text,
  category text not null default 'maintenance' check (category in ('maintenance','repair','restoration','modification','parts','tyres','detailing','inspection','registration','insurance','other')),
  amount numeric check (amount >= 0),
  currency text not null default 'BRL' check (currency in ('USD','BRL')),
  confidence text not null default 'printed' check (confidence in ('printed','hand','est','report','cf','log')),
  invoice_url text, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by text
);
create index on public.service_records(garage_id);
create index on public.service_records(vehicle_id);

create table public.odometer_readings (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  date date, odometer integer check (odometer >= 0),
  unit text not null default 'km' check (unit in ('mi','km')),
  hours numeric check (hours >= 0), notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by text
);
create index on public.odometer_readings(garage_id);
create index on public.odometer_readings(vehicle_id);

create table public.service_tasks (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  title text not null default 'Annual service', needs text, due_date date,
  done boolean not null default false, done_at date,
  record_id uuid references public.service_records(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by text
);
create index on public.service_tasks(garage_id);
create index on public.service_tasks(vehicle_id);
create index on public.service_tasks(record_id);

create table public.market_comps (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  source text not null default 'other' check (source in ('bat','webmotors','carsandbids','classic','other')),
  kind text not null default 'sold' check (kind in ('sold','asking')),
  url text, title text,
  price numeric not null check (price > 0),
  currency text not null default 'BRL' check (currency in ('USD','BRL')),
  date date not null, mileage integer check (mileage >= 0),
  mileage_unit text not null default 'km' check (mileage_unit in ('mi','km')),
  include boolean not null default true, auto boolean not null default false, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by text
);
create index on public.market_comps(garage_id);
create index on public.market_comps(vehicle_id);

-- Triggers
create trigger touch before insert or update on public.garages for each row execute function private.touch_row();
create trigger touch before insert or update on public.vehicles for each row execute function private.touch_row();
do $$ declare t text; begin
  foreach t in array array['service_records','odometer_readings','service_tasks','market_comps'] loop
    execute format('create trigger touch before insert or update on public.%I for each row execute function private.touch_row()', t);
    execute format('create trigger set_garage before insert or update on public.%I for each row execute function private.set_garage()', t);
  end loop;
end $$;

-- A vehicle can't be moved to another garage
create or replace function private.lock_garage() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.garage_id <> old.garage_id then raise exception 'A vehicle can''t move between garages'; end if;
  return new;
end $$;
create trigger lock_garage before update of garage_id on public.vehicles for each row execute function private.lock_garage();

-- ── Row-level security ──────────────────────────────────────────────────────
alter table public.garages enable row level security;
alter table public.garage_members enable row level security;
alter table public.garage_invites enable row level security;

create policy "members read" on public.garages for select to authenticated using ((select private.can_read(id)));
create policy "owners update" on public.garages for update to authenticated using ((select private.is_owner(id))) with check ((select private.is_owner(id)));
create policy "owners delete" on public.garages for delete to authenticated using ((select private.is_owner(id)));
-- garages are created through create_garage(), never by direct insert

create policy "members read" on public.garage_members for select to authenticated using ((select private.can_read(garage_id)));
create policy "owners change roles" on public.garage_members for update to authenticated
  using ((select private.is_owner(garage_id)) and user_id <> (select auth.uid()))
  with check ((select private.is_owner(garage_id)) and role in ('editor','viewer'));
create policy "owners remove, anyone leaves" on public.garage_members for delete to authenticated
  using (((select private.is_owner(garage_id)) and user_id <> (select auth.uid())) or (user_id = (select auth.uid()) and role <> 'owner'));

create policy "owners read" on public.garage_invites for select to authenticated using ((select private.is_owner(garage_id)));
create policy "owners invite" on public.garage_invites for insert to authenticated with check ((select private.is_owner(garage_id)));
create policy "owners cancel" on public.garage_invites for delete to authenticated using ((select private.is_owner(garage_id)));

do $$ declare t text; begin
  foreach t in array array['vehicles','service_records','odometer_readings','service_tasks','market_comps'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "members read" on public.%I for select to authenticated using ((select private.can_read(garage_id)))', t);
    execute format('create policy "editors add" on public.%I for insert to authenticated with check ((select private.can_write(garage_id)))', t);
    execute format('create policy "editors change" on public.%I for update to authenticated using ((select private.can_write(garage_id))) with check ((select private.can_write(garage_id)))', t);
    execute format('create policy "editors delete" on public.%I for delete to authenticated using ((select private.can_write(garage_id)))', t);
  end loop;
end $$;

revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert on public.garages, public.garage_members from authenticated;

-- ── Actions the app calls ───────────────────────────────────────────────────
-- Create a garage and make the caller its owner (max 5 garages per person)
create or replace function public.create_garage(p_name text, p_currency text default 'BRL', p_unit text default 'km', p_lang text default 'pt')
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); em text := lower(auth.jwt() ->> 'email'); g uuid;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  if (select count(*) from public.garage_members where user_id = uid and role = 'owner') >= 5 then
    raise exception 'You already own 5 garages';
  end if;
  insert into public.garages(name, currency, distance_unit, lang, created_by)
    values (trim(p_name), p_currency, p_unit, p_lang, uid) returning id into g;
  insert into public.garage_members(garage_id, user_id, email, role) values (g, uid, em, 'owner');
  return g;
end $$;

-- Join every garage this email was invited to
create or replace function public.accept_invites() returns integer
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); em text := lower(auth.jwt() ->> 'email'); n integer;
begin
  if uid is null or em is null then return 0; end if;
  insert into public.garage_members(garage_id, user_id, email, role)
    select garage_id, uid, em, role from public.garage_invites where email = em
    on conflict (garage_id, user_id) do nothing;
  get diagnostics n = row_count;
  delete from public.garage_invites where email = em;
  return n;
end $$;

revoke execute on function public.create_garage(text,text,text,text), public.accept_invites() from public, anon;
grant execute on function public.create_garage(text,text,text,text), public.accept_invites() to authenticated;

-- ── Photos and invoices: private bucket, one folder per garage ──────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 15728640, array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

create or replace function private.folder_garage(name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(name, '/', 1) ~ '^[0-9a-f-]{36}$' then split_part(name, '/', 1)::uuid end
$$;
grant execute on function private.folder_garage(text) to authenticated;

create policy "members read media" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (select private.can_read(private.folder_garage(name))));
create policy "editors upload media" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (select private.can_write(private.folder_garage(name))));
create policy "editors change media" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (select private.can_write(private.folder_garage(name))));
create policy "editors delete media" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (select private.can_write(private.folder_garage(name))));
