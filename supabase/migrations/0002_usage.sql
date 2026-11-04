-- AI usage per garage (invoice scans, spreadsheet imports): what the monthly caps and billing count.
create table public.usage_events (
  id bigint generated always as identity primary key,
  garage_id uuid not null references public.garages(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('scan','import')),
  tokens_in integer, tokens_out integer,
  created_at timestamptz not null default now()
);
create index on public.usage_events(garage_id, kind, created_at);
create index on public.usage_events(user_id);
alter table public.usage_events enable row level security;
create policy "members read" on public.usage_events for select to authenticated using ((select private.can_read(garage_id)));
-- written only by the edge functions (service role); no insert/update/delete for users
revoke all on public.usage_events from anon, authenticated;
grant select on public.usage_events to authenticated;
