-- Worldwide: each garage has a country (sets defaults and country-specific features),
-- and any ISO 4217 currency is allowed, not only BRL and USD.
alter table public.garages add column if not exists country text check (country ~ '^[A-Z]{2}$');
update public.garages set country = case currency when 'BRL' then 'BR' when 'USD' then 'US' end where country is null;
grant update (country) on public.garages to authenticated;

alter table public.garages drop constraint if exists garages_currency_check;
alter table public.garages add constraint garages_currency_check check (currency ~ '^[A-Z]{3}$');
alter table public.vehicles drop constraint if exists vehicles_currency_check;
alter table public.vehicles add constraint vehicles_currency_check check (currency ~ '^[A-Z]{3}$');
alter table public.service_records drop constraint if exists service_records_currency_check;
alter table public.service_records add constraint service_records_currency_check check (currency ~ '^[A-Z]{3}$');
alter table public.market_comps drop constraint if exists market_comps_currency_check;
alter table public.market_comps add constraint market_comps_currency_check check (currency ~ '^[A-Z]{3}$');

-- create_garage takes the country too
drop function if exists public.create_garage(text, text, text, text);
create or replace function public.create_garage(p_name text, p_currency text default 'USD', p_unit text default 'km', p_lang text default 'en', p_country text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); em text := lower(auth.jwt() ->> 'email'); g uuid; al jsonb;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  perform pg_advisory_xact_lock(hashtext('create_garage:' || uid::text)); -- two tabs can't both take the last slot
  al := private.garage_allowance(uid);
  if (al ->> 'owned')::int >= (al ->> 'total')::int then
    raise exception 'garage_limit:%', al ->> 'total';
  end if;
  insert into public.garages(name, currency, distance_unit, lang, created_by, country)
    values (trim(p_name), upper(p_currency), p_unit, p_lang, uid, nullif(upper(p_country), '')) returning id into g;
  insert into public.garage_members(garage_id, user_id, email, role) values (g, uid, em, 'owner');
  return g;
end $$;
revoke execute on function public.create_garage(text,text,text,text,text) from public, anon;
grant execute on function public.create_garage(text,text,text,text,text) to authenticated;
