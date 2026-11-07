-- An invite to someone who already has an account gives them access straight away
-- (before, it waited until their next sign-in). Invites to new emails wait for sign-up as before.
create or replace function private.apply_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(new.email) and email_confirmed_at is not null limit 1;
  if uid is null then return null; end if;
  insert into public.garage_members(garage_id, user_id, email, role)
    values (new.garage_id, uid, lower(new.email), new.role)
    on conflict (garage_id, user_id) do nothing;
  delete from public.garage_invites where id = new.id;
  return null;
end $$;
drop trigger if exists apply_invite on public.garage_invites;
create trigger apply_invite after insert on public.garage_invites for each row execute function private.apply_invite();

-- invites already waiting for people who have since signed up
insert into public.garage_members(garage_id, user_id, email, role)
  select i.garage_id, u.id, lower(i.email), i.role from public.garage_invites i
  join auth.users u on lower(u.email) = lower(i.email) and u.email_confirmed_at is not null
  on conflict (garage_id, user_id) do nothing;
delete from public.garage_invites i using auth.users u where lower(u.email) = lower(i.email) and u.email_confirmed_at is not null;
