// Moves a vehicle, with its records, readings, reminders, history, share link, photos and invoices, to another garage.
// Only the owner of the vehicle's garage can do it, and only into a garage where they are owner or editor.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const pathOf = (u?: string | null) => { const m = /\/object\/(?:public|sign|authenticated)\/media\/([^?]+)/.exec(u || ''); return m ? decodeURIComponent(m[1]) : null; };
const uuid = /^[0-9a-f-]{36}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: 'signed_out', message: 'Your sign-in expired. Sign in again and retry.' }, 401);
    const { vehicle_id, garage_id } = await req.json().catch(() => ({})) as { vehicle_id?: string; garage_id?: string };
    if (!uuid.test(vehicle_id || '') || !uuid.test(garage_id || '')) return json({ error: 'bad_request', message: 'Choose a vehicle and a garage.' }, 400);

    const { data: v } = await admin.from('vehicles').select('id, garage_id, photo_url, photos, illus_url').eq('id', vehicle_id).maybeSingle();
    if (!v) return json({ error: 'not_found', message: 'That vehicle wasn\'t found.' }, 404);
    if (v.garage_id === garage_id) return json({ ok: true, moved: false });
    const { data: roles } = await admin.from('garage_members').select('garage_id, role').eq('user_id', u.user.id).in('garage_id', [v.garage_id, garage_id]);
    const role = (g: string) => roles?.find(r => r.garage_id === g)?.role;
    if (role(v.garage_id) !== 'owner') return json({ error: 'forbidden', message: 'Only the owner of this garage can move its vehicles.' }, 403);
    if (!['owner', 'editor'].includes(role(garage_id!) || '')) return json({ error: 'forbidden', message: 'You can only move a vehicle into a garage you own or edit.' }, 403);

    // files: photos, illustration, invoices
    const { data: recs } = await admin.from('service_records').select('invoice_url').eq('vehicle_id', v.id).not('invoice_url', 'is', null);
    const urls = [...new Set([v.photo_url, v.illus_url, ...(v.photos || []), ...(recs || []).map(r => r.invoice_url)].filter(Boolean) as string[])];
    const map: Record<string, string> = {}, done: [string, string][] = [];
    const undo = async () => { for (const [a, b] of done) await admin.storage.from('media').move(b, a); };
    for (const url of urls) {
      const p = pathOf(url);
      if (!p || !p.startsWith(v.garage_id + '/')) continue; // not in this garage's folder: leave it
      const np = garage_id + p.slice(v.garage_id.length);
      const { error } = await admin.storage.from('media').move(p, np);
      if (error) {
        if (/not.?found/i.test(error.message)) continue; // file already gone: keep the link as it is
        await undo();
        console.error('move file', p, error.message);
        return json({ error: 'files', message: 'The photos couldn\'t be moved, so nothing was changed. Try again.' }, 500);
      }
      done.push([p, np]); map[url] = url.replace(p, np);
    }
    const { error } = await admin.rpc('move_vehicle_rows', { p_vehicle: v.id, p_garage: garage_id, p_urls: map });
    if (error) {
      await undo();
      console.error('move rows', error.message);
      return json({ error: 'db', message: 'The vehicle couldn\'t be moved, so nothing was changed. Try again.' }, 500);
    }
    return json({ ok: true, moved: true, files: done.length });
  } catch (e) {
    console.error(e);
    return json({ error: 'exception', message: 'Something went wrong moving the vehicle. Try again.' }, 500);
  }
});
