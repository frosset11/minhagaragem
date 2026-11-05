-- AI illustrations of vehicle photos count against their own monthly allowance
alter table public.usage_events drop constraint if exists usage_events_kind_check;
alter table public.usage_events add constraint usage_events_kind_check check (kind in ('scan','import','illustrate'));
