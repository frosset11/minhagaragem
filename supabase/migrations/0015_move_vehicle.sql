-- Moving a vehicle (with everything that belongs to it) to another garage.
-- The garage lock on vehicles stays, except inside public.move_vehicle_rows, which sets a transaction flag.
create or replace function private.lock_garage()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.garage_id <> old.garage_id and coalesce(current_setting('autodex.moving_vehicle', true), '') <> new.id::text then
    raise exception 'A vehicle can''t move between garages';
  end if;
  return new;
end $$;

-- Called only by the move-vehicle edge function (service role), after it has checked who is asking
-- and moved the files. p_urls maps each old file link to its new one.
create or replace function public.move_vehicle_rows(p_vehicle uuid, p_garage uuid, p_urls jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare m jsonb := coalesce(p_urls, '{}');
begin
  perform set_config('autodex.moving_vehicle', p_vehicle::text, true);
  update public.vehicles v set
    garage_id = p_garage,
    photo_url = coalesce(m ->> v.photo_url, v.photo_url),
    illus_url = coalesce(m ->> v.illus_url, v.illus_url),
    photos = array(select coalesce(m ->> p, p) from unnest(v.photos) p),
    sort_order = coalesce((select max(sort_order) + 1 from public.vehicles where garage_id = p_garage), 0)
  where v.id = p_vehicle;
  if not found then raise exception 'Vehicle not found'; end if;
  -- the set_garage triggers re-read the vehicle's garage on update
  update public.service_records set garage_id = p_garage, invoice_url = coalesce(m ->> invoice_url, invoice_url) where vehicle_id = p_vehicle;
  update public.odometer_readings set garage_id = p_garage where vehicle_id = p_vehicle;
  update public.service_tasks set garage_id = p_garage where vehicle_id = p_vehicle;
  update public.market_comps set garage_id = p_garage where vehicle_id = p_vehicle;
  update public.vehicle_history set garage_id = p_garage where vehicle_id = p_vehicle;
  update public.reminders set garage_id = p_garage where vehicle_id = p_vehicle;
  update public.vehicle_shares set garage_id = p_garage where vehicle_id = p_vehicle;
  perform set_config('autodex.moving_vehicle', '', true);
end $$;
revoke execute on function public.move_vehicle_rows(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.move_vehicle_rows(uuid, uuid, jsonb) to service_role;
