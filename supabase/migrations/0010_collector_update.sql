-- Collector update: VIN specs, provenance timeline, reminders, phone notifications, dossier share links.

-- More specification fields (filled by the VIN decoder or the photo reads)
alter table public.vehicles add column if not exists body text;
alter table public.vehicles add column if not exists plant text;
alter table public.vehicles add column if not exists series text;
alter table public.vehicles add column if not exists build_year integer check (build_year between 1885 and 2100);
alter table public.vehicles add column if not exists specs_source text;

-- Provenance: owners, restorations, events, awards, anything with a date
create table public.vehicle_history (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  date date, date_text text,
  kind text not null default 'other' check (kind in ('owner','restoration','event','award','document','other')),
  title text not null, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by text
);
create index on public.vehicle_history(garage_id);
create index on public.vehicle_history(vehicle_id);

-- Reminders: a date, a distance, or both; optionally repeating
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid not null references public.garages(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  kind text not null default 'other' check (kind in ('service','ipva','licensing','insurance','inspection','other')),
  title text not null,
  due_date date,
  due_odometer integer check (due_odometer >= 0),
  every_months integer check (every_months between 1 and 120),
  every_distance integer check (every_distance > 0),
  notes text,
  done boolean not null default false, done_at date,
  last_notified date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by text,
  check (due_date is not null or due_odometer is not null)
);
create index on public.reminders(garage_id);
create index on public.reminders(vehicle_id);
create index on public.reminders(due_date) where not done;

do $$ declare t text; begin
  foreach t in array array['vehicle_history','reminders'] loop
    execute format('create trigger touch before insert or update on public.%I for each row execute function private.touch_row()', t);
    execute format('create trigger set_garage before insert or update on public.%I for each row execute function private.set_garage()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "members read" on public.%I for select to authenticated using ((select private.can_read(garage_id)))', t);
    execute format('create policy "editors add" on public.%I for insert to authenticated with check ((select private.can_write(garage_id)))', t);
    execute format('create policy "editors change" on public.%I for update to authenticated using ((select private.can_write(garage_id))) with check ((select private.can_write(garage_id)))', t);
    execute format('create policy "editors delete" on public.%I for delete to authenticated using ((select private.can_write(garage_id)))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- Phone notifications: one row per device that said yes
create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null, auth text not null,
  user_agent text,
  created_at timestamptz not null default now(), last_used timestamptz
);
create index on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
create policy "own devices read" on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy "own devices add" on public.push_subscriptions for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own devices change" on public.push_subscriptions for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own devices remove" on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Dossier share links: an unguessable token opens one vehicle's dossier, read-only, with the owner's chosen sections
create table public.vehicle_shares (
  token text primary key default encode(extensions.gen_random_bytes(18), 'hex'),
  garage_id uuid not null references public.garages(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  opts jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  views integer not null default 0, last_viewed timestamptz
);
create index on public.vehicle_shares(vehicle_id);
create trigger set_garage before insert or update on public.vehicle_shares for each row execute function private.set_garage();
alter table public.vehicle_shares enable row level security;
create policy "members read" on public.vehicle_shares for select to authenticated using ((select private.can_read(garage_id)));
create policy "editors add" on public.vehicle_shares for insert to authenticated with check ((select private.can_write(garage_id)));
create policy "editors change" on public.vehicle_shares for update to authenticated using ((select private.can_write(garage_id))) with check ((select private.can_write(garage_id)));
create policy "editors delete" on public.vehicle_shares for delete to authenticated using ((select private.can_write(garage_id)));
revoke all on public.vehicle_shares from anon;
grant select, insert, update, delete on public.vehicle_shares to authenticated;
