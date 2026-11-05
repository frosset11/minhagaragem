-- No vehicle cap for now: vehicle_limit NULL means unlimited. To bring a cap back for a garage:
--   update public.garages set vehicle_limit = 5 where id = '<garage id>';
alter table public.garages alter column vehicle_limit drop not null;
alter table public.garages alter column vehicle_limit set default null;
update public.garages set vehicle_limit = null;

create or replace function private.vehicle_cap() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lim integer; n integer;
begin
  if new.status = 'sold' then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'sold' then return new; end if;
  select vehicle_limit into lim from public.garages where id = new.garage_id for update;
  if lim is null then return new; end if; -- unlimited
  select count(*) into n from public.vehicles where garage_id = new.garage_id and status <> 'sold' and id <> new.id;
  if n >= lim then raise exception 'vehicle_limit:%', lim; end if;
  return new;
end $$;
revoke execute on function private.vehicle_cap() from public, anon, authenticated;
