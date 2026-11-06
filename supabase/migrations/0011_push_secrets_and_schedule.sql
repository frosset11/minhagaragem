-- Phone notifications: secrets in Supabase Vault and a daily schedule.
-- The secret VALUES are not in this file. They were created once with:
--   select vault.create_secret('<VAPID private key as JWK JSON>', 'vapid_private_jwk', 'Web Push signing key for reminder notifications');
--   select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'cron_secret', 'Shared secret: pg_cron to send-reminders');
-- The matching VAPID public key is VAPID_PUBLIC in index.html and send-reminders/index.ts.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;   -- moved to extensions in 0012

create or replace function public.app_secret(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name and p_name in ('vapid_private_jwk', 'cron_secret')
$$;
revoke execute on function public.app_secret(text) from public, anon, authenticated;
grant execute on function public.app_secret(text) to service_role;

-- every day at 12:00 UTC (9:00 in Brasília, 7:00/8:00 in Miami)
select cron.schedule('autodex-reminders', '0 12 * * *', $cron$
  select net.http_post(
    url := 'https://ovthmjsyjxjlimcxgqmo.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 30000)
$cron$);
