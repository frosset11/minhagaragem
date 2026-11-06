// Daily: sends a phone notification to each owner/editor about reminders that are due or overdue.
// Called daily by pg_cron (job autodex-reminders) with the x-cron-secret header from Vault (deployed with verify_jwt off).
// A reminder notifies when it becomes due (14 days before its date, or close to its odometer), on its due day,
// and then once a week while it stays overdue.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { sendPush, type Vapid } from '../_shared/webpush.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const SITE = Deno.env.get('SITE_URL') || 'https://autodex-garage.vercel.app';
const day = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
const n = (x: number) => Math.round(x).toLocaleString('en-US');

type Rem = { id: string; garage_id: string; vehicle_id: string; title: string; due_date: string | null; due_odometer: number | null; every_distance: number | null; last_notified: string | null };
type Veh = { id: string; year: number | null; make: string | null; model: string | null; odometer: number | null; odometer_unit: string | null; status: string };

function status(r: Rem, v: Veh, today: string) {
  let key = 'ok'; const bits: string[] = [];
  const rank: Record<string, number> = { overdue: 0, due: 1, ok: 2 };
  const worse = (k: string) => { if (rank[k] < rank[key]) key = k; };
  if (r.due_date) {
    const d = daysBetween(r.due_date, today);
    worse(d < 0 ? 'overdue' : d <= 14 ? 'due' : 'ok');
    bits.push(d < 0 ? `${-d} day${d === -1 ? '' : 's'} overdue` : d === 0 ? 'due today' : `due in ${d} day${d === 1 ? '' : 's'}`);
  }
  if (r.due_odometer != null && v.odometer != null) {
    const unit = v.odometer_unit || 'km', left = r.due_odometer - v.odometer, step = r.every_distance || (unit === 'mi' ? 6000 : 10000);
    worse(left <= 0 ? 'overdue' : left <= Math.max(300, step * 0.05) ? 'due' : 'ok');
    bits.push(left <= 0 ? `${n(-left)} ${unit} over` : `due in ${n(left)} ${unit}`);
  }
  return { key, when: bits.join(' or '), dueToday: r.due_date === today };
}

// The public half is in index.html too (VAPID_PUBLIC); the private half and the cron password live in Supabase Vault
const VAPID_PUBLIC = 'BCLA0BOtp-zB_vbEtEXF5e3YzP3DSpZP4_I0OMPkyZspFa4rNTXcSAE6aEnTB5Pxce5NePaZHlUMEz4RE5Zy-4Y';
const secret = async (name: string) => (await admin.rpc('app_secret', { p_name: name })).data as string | null;

Deno.serve(async (req) => {
  const cron = await secret('cron_secret');
  if (!cron || req.headers.get('x-cron-secret') !== cron) return new Response('forbidden', { status: 403 });
  const url = new URL(req.url), dry = url.searchParams.get('dry') === '1';
  let jwk: JsonWebKey;
  try { jwk = JSON.parse((await secret('vapid_private_jwk')) || ''); } catch (_) { return new Response('signing key missing', { status: 500 }); }
  const vapid: Vapid = { jwk, pub: VAPID_PUBLIC, subject: SITE };
  const today = day(new Date());

  const { data: rems, error } = await admin.from('reminders').select('id,garage_id,vehicle_id,title,due_date,due_odometer,every_distance,last_notified').eq('done', false);
  if (error) { console.error(error); return new Response('db error', { status: 500 }); }
  const vids = [...new Set((rems || []).map(r => r.vehicle_id))];
  const { data: vehs } = vids.length ? await admin.from('vehicles').select('id,year,make,model,odometer,odometer_unit,status').in('id', vids) : { data: [] };
  const vById = new Map((vehs || []).map((v: Veh) => [v.id, v]));

  // which reminders to send today
  const send: { r: Rem; v: Veh; when: string; overdue: boolean }[] = [];
  for (const r of (rems || []) as Rem[]) {
    const v = vById.get(r.vehicle_id); if (!v || v.status === 'sold') continue;
    const s = status(r, v, today);
    if (s.key === 'ok') continue;
    const since = r.last_notified ? daysBetween(today, r.last_notified) : Infinity;
    if (since >= 7 || (s.dueToday && since >= 1)) send.push({ r, v, when: s.when, overdue: s.key === 'overdue' });
  }
  if (!send.length) return Response.json({ ok: true, reminders: 0, sent: 0 });

  // who hears about them: owners and editors of each garage, on every device they turned alerts on
  const gids = [...new Set(send.map(x => x.r.garage_id))];
  const { data: members } = await admin.from('garage_members').select('garage_id,user_id,role').in('garage_id', gids).in('role', ['owner', 'editor']);
  const users = [...new Set((members || []).map(m => m.user_id))];
  const { data: subs } = users.length ? await admin.from('push_subscriptions').select('endpoint,user_id,p256dh,auth').in('user_id', users) : { data: [] };
  const { data: garages } = await admin.from('garages').select('id,name').in('id', gids);
  const gName = new Map((garages || []).map(g => [g.id, g.name]));

  let sent = 0, gone = 0;
  const notified = new Set<string>();
  for (const u of users) {
    const mine = send.filter(x => (members || []).some(m => m.user_id === u && m.garage_id === x.r.garage_id));
    const devices = (subs || []).filter(s => s.user_id === u);
    if (!mine.length || !devices.length) continue;
    const vn = (v: Veh) => [v.year, v.make, v.model].filter(Boolean).join(' ');
    const multiGarage = new Set(mine.map(x => x.r.garage_id)).size > 1;
    const payload = mine.length === 1
      ? { title: `${mine[0].r.title}: ${mine[0].when}`, body: vn(mine[0].v) + (multiGarage ? '' : ` · ${gName.get(mine[0].r.garage_id) || ''}`), url: `${SITE}/#/vehicle/${mine[0].v.id}`, tag: 'rem-' + mine[0].r.id }
      : { title: `${mine.length} reminders ${mine.some(x => x.overdue) ? 'need attention' : 'coming up'}`, body: mine.slice(0, 4).map(x => `${x.r.title} · ${vn(x.v)} (${x.when})`).join('\n') + (mine.length > 4 ? `\n+${mine.length - 4} more` : ''), url: `${SITE}/#/ledger`, tag: 'rem-digest' };
    if (dry) { console.log('dry', u, JSON.stringify(payload)); mine.forEach(x => notified.add(x.r.id)); continue; }
    for (const d of devices) {
      const res = await sendPush(d, payload, vapid).catch(e => ({ status: 0, text: String(e) }));
      if (res.status === 404 || res.status === 410) { gone++; await admin.from('push_subscriptions').delete().eq('endpoint', d.endpoint); }
      else if (res.status >= 200 && res.status < 300) { sent++; mine.forEach(x => notified.add(x.r.id)); await admin.from('push_subscriptions').update({ last_used: new Date().toISOString() }).eq('endpoint', d.endpoint); }
      else console.error('push', res.status, res.text);
    }
  }
  if (notified.size && !dry) await admin.from('reminders').update({ last_notified: today }).in('id', [...notified]);
  return Response.json({ ok: true, reminders: send.length, sent, removed: gone, dry });
});
