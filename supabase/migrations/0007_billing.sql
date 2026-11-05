-- Stripe subscriptions, one per garage (the owner pays). Written only by the edge functions
-- (service role); members can read their garage's row. garages.plan is kept in step by the webhook.
create table public.billing (
  garage_id uuid primary key references public.garages(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text not null default 'free' check (plan in ('free','pro','concierge')),
  status text,                      -- Stripe subscription status: active, trialing, past_due, canceled…
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.billing enable row level security;
create policy "members read billing" on public.billing for select to authenticated using ((select private.can_read(garage_id)));
revoke all on public.billing from anon, authenticated;
grant select on public.billing to authenticated;

-- Each Stripe webhook event is applied once
create table public.stripe_events (
  id text primary key,
  type text not null,
  created_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;
