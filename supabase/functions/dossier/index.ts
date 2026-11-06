// Public, read-only vehicle dossier behind an unguessable share token (deployed with verify_jwt off).
// Returns only what the owner ticked when sharing; never where the car is kept, co-owners, members or anything else in the garage.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const pathOf = (u?: string | null) => { const m = /\/object\/(?:public|sign|authenticated)\/media\/([^?]+)/.exec(u || ''); return m ? decodeURIComponent(m[1]) : null; };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { token } = await req.json().catch(() => ({})) as { token?: string };
    if (typeof token !== 'string' || !/^[0-9a-f]{36}$/.test(token)) return json({ error: 'not_found', message: 'This link isn\'t valid.' }, 404);
    const { data: share } = await admin.from('vehicle_shares').select('*').eq('token', token).maybeSingle();
    if (!share) return json({ error: 'not_found', message: 'This link has been turned off by the owner, or it\'s wrong.' }, 404);
    const o = share.opts || {};
    const [{ data: v }, { data: recs }, { data: reads }, { data: hist }] = await Promise.all([
      admin.from('vehicles').select('*').eq('id', share.vehicle_id).single(),
      admin.from('service_records').select('id,date,title,items,shop,category,mileage,mileage_approx,hours,amount,currency,confidence,invoice_url').eq('vehicle_id', share.vehicle_id).order('date', { ascending: false, nullsFirst: false }),
      admin.from('odometer_readings').select('date,odometer,unit,hours').eq('vehicle_id', share.vehicle_id).order('date', { ascending: true, nullsFirst: false }),
      admin.from('vehicle_history').select('date,date_text,kind,title,notes').eq('vehicle_id', share.vehicle_id).order('date', { ascending: true, nullsFirst: false })
    ]);
    if (!v) return json({ error: 'not_found', message: 'This vehicle is no longer in AUTODEX.' }, 404);
    admin.from('vehicle_shares').update({ views: (share.views || 0) + 1, last_viewed: new Date().toISOString() }).eq('token', token).then(() => {});

    // signed links (7 days) for the photo and, if ticked, the receipts
    const want = [pathOf(v.photo_url), ...(o.receipts ? (recs || []).map(r => pathOf(r.invoice_url)) : [])].filter(Boolean) as string[];
    const signed: Record<string, string> = {};
    if (want.length) { const { data } = await admin.storage.from('media').createSignedUrls([...new Set(want)], 7 * 24 * 3600); (data || []).forEach(d => { if (d.path && d.signedUrl) signed[d.path] = d.signedUrl; }); }
    const sign = (u?: string | null) => { const p = pathOf(u); return p ? signed[p] || null : null; };

    const pick = (keys: string[]) => Object.fromEntries(keys.map(k => [k, v[k]]));
    const vehicle = {
      ...pick(['id', 'kind', 'year', 'build_year', 'make', 'model', 'trim_level', 'nickname', 'colour', 'series', 'body', 'engine', 'power', 'transmission', 'drivetrain', 'plant', 'specs_source', 'meter', 'odometer', 'odometer_unit', 'odometer_date', 'hours', 'currency', 'purchase_date', 'status', 'sold_date']),
      vin: o.vin !== false ? v.vin : null, plate: o.plate ? v.plate : null, notes: o.notes ? v.notes : null,
      purchase_price: o.price ? v.purchase_price : null, estimated_value: o.price ? v.estimated_value : null, value_date: o.price ? v.value_date : null, sold_price: o.price ? v.sold_price : null, purchased_from: o.price ? v.purchased_from : null,
      photo: sign(v.photo_url)
    };
    const records = (recs || []).map(r => ({ ...r, amount: o.amounts ? r.amount : null, invoice_url: undefined, invoice: o.receipts ? sign(r.invoice_url) : null, has_invoice: !!r.invoice_url }));
    return json({ ok: true, opts: o, vehicle, records, readings: reads || [], history: hist || [], shared_at: share.created_at });
  } catch (e) {
    console.error(e);
    return json({ error: 'exception', message: 'Something went wrong opening this dossier. Try again.' }, 500);
  }
});
