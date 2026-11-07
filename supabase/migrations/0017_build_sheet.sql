-- Build sheet: public factory specifications for a vehicle (power, torque, engine, gearbox, performance, curve).
alter table public.vehicles add column if not exists build_sheet jsonb;

-- Shared cache of looked-up specifications, keyed by year|make|model|trim|kind (public knowledge, not user data).
-- Only the vehicle-specs edge function (service role) reads and writes it.
create table if not exists public.spec_cache (
  key text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.spec_cache enable row level security;
revoke all on public.spec_cache from anon, authenticated;

-- a lookup that isn't cached counts against a separate monthly allowance
alter table public.usage_events drop constraint if exists usage_events_kind_check;
alter table public.usage_events add constraint usage_events_kind_check check (kind = any (array['scan', 'import', 'illustrate', 'specs']));
