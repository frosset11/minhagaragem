// Public factory specifications for a year / make / model (/ trim): engine, power, torque, gearbox, drive,
// performance and an estimated factory power and torque curve. Cached for everyone by vehicle, so a model is
// only looked up once; a lookup that isn't cached counts as one spec lookup for the garage.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { cors, gate, json, askClaude } from '../_shared/ai.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const S = (d: string) => ({ type: 'string', description: d });
const I = (d: string) => ({ type: 'integer', description: d });
const N = (d: string) => ({ type: 'number', description: d });
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['found', 'name', 'engine', 'displacement_cc', 'layout', 'aspiration', 'fuel', 'power_hp', 'power_kw', 'power_rpm', 'torque_nm', 'torque_rpm', 'redline_rpm', 'transmission', 'gears', 'drivetrain', 'body', 'weight_kg', 'zero_to_100_s', 'top_speed_kmh', 'production', 'curve', 'curve_note', 'summary', 'confidence'],
  properties: {
    found: { type: 'boolean', description: 'false if this year/make/model is not a real vehicle you know well enough' },
    name: S('Full name of the exact version these figures are for, e.g. "BMW M3 (E30) 2.3, 1989"'),
    engine: S('Engine as an owner would describe it, e.g. "2.3 L inline-4 (S14)". "" if unknown'),
    displacement_cc: I('Cubic centimetres, -1 if unknown'),
    layout: S('e.g. "Inline-4", "V8", "Flat-6", "Single-cylinder". "" if unknown'),
    aspiration: S('"Naturally aspirated", "Turbocharged", "Twin-turbo", "Supercharged", "Electric" etc. "" if unknown'),
    fuel: S('"Petrol", "Diesel", "Flex", "Hybrid", "Electric". "" if unknown'),
    power_hp: I('Peak power in metric horsepower (PS/cv) as published by the maker, -1 if unknown'),
    power_kw: I('Peak power in kW, -1 if unknown'),
    power_rpm: S('rpm of peak power, e.g. "6,750". "" if unknown'),
    torque_nm: I('Peak torque in Nm, -1 if unknown'),
    torque_rpm: S('rpm of peak torque, e.g. "4,750" or "2,750–5,500". "" if unknown'),
    redline_rpm: I('Rev limit, -1 if unknown'),
    transmission: S('e.g. "5-speed manual", "8-speed automatic (ZF 8HP)", "7-speed dual-clutch". "" if unknown'),
    gears: I('Number of forward gears, -1 if unknown'),
    drivetrain: S('"Rear-wheel drive", "Front-wheel drive", "All-wheel drive", "Chain drive", "Shaft drive". "" if unknown'),
    body: S('e.g. "2-door coupé", "Sport bike", "Naked", "Scooter". "" if unknown'),
    weight_kg: I('Kerb weight in kg (dry weight for motorcycles if that is what is published), -1 if unknown'),
    zero_to_100_s: N('0–100 km/h in seconds as published or widely tested, -1 if unknown'),
    top_speed_kmh: I('Top speed in km/h, -1 if unknown'),
    production: S('Years this version was made, e.g. "1986–1991". "" if unknown'),
    curve: { type: 'array', description: 'Estimated factory power and torque curve: 8 to 14 points from idle-ish to the rev limit, consistent with the peak figures and the engine type. Empty if you cannot estimate it sensibly.',
      items: { type: 'object', additionalProperties: false, required: ['rpm', 'hp', 'nm'], properties: { rpm: I('rpm'), hp: N('power at this rpm, PS'), nm: N('torque at this rpm, Nm') } } },
    curve_note: S('Where the curve shape comes from, in one short sentence, e.g. "Shape from the published factory curve" or "Estimated from the peak figures"'),
    summary: S('One sentence on what this vehicle is known for, plain and factual'),
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  }
};
const clean = (x: string) => String(x || '').trim().replace(/\s+/g, ' ');
const keyOf = (b: Record<string, unknown>) => [b.year, b.make, b.model, b.trim, b.kind, b.gearbox].map(x => clean(String(x ?? '')).toLowerCase()).join('|');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as { garage_id?: string; year?: number | string; make?: string; model?: string; trim?: string; kind?: string; gearbox?: string; country?: string; refresh?: boolean };
    const make = clean(body.make || ''), model = clean(body.model || ''), year = String(body.year || '').trim();
    if (!make || !model || !/^\d{4}$/.test(year)) return json({ error: 'bad_request', message: 'Enter the year, make and model first.' }, 400);
    const gearbox = body.gearbox === 'manual' || body.gearbox === 'automatic' ? body.gearbox : '';
    const key = keyOf({ ...body, make, model, year, gearbox });
    // signed in at all? (cached specs are public knowledge, but only for people using the app)
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: 'signed_out', message: 'Your sign-in expired. Sign in again and retry.' }, 401);
    if (!body.refresh) {
      const { data: hit } = await admin.from('spec_cache').select('data').eq('key', key).maybeSingle();
      if (hit) return json({ ok: true, cached: true, sheet: hit.data });
    }
    const g = await gate(req, body.garage_id, 'specs');
    if ('fail' in g) return g.fail;
    const kind = body.kind === 'bike' ? 'motorcycle' : 'car';
    const prompt = `Give the published factory specifications for this ${kind}: ${year} ${make} ${model}${body.trim ? ' ' + clean(body.trim) : ''}${gearbox ? `, ${gearbox} gearbox` : ''}${body.country ? ` (sold in ${clean(body.country)}; use that market's version if it differs)` : ''}.
Use the figures the maker published for this exact year and version, or the most widely cited figures. If the trim is missing, use the most common version for that year and name it in "name". Do not guess figures you don't know: use -1 or "" instead. Power is metric horsepower (PS / cv). If this isn't a real ${kind} you know, set found to false.`;
    const r = await askClaude(g.key!, [{ type: 'text', text: prompt }], SCHEMA, 2500);
    if ('fail' in r) return r.fail;
    if (!r.data) return json({ error: 'no_answer', message: 'No specifications came back. Try again.' }, 502);
    await g.record(r.usage);
    const d = r.data as Record<string, unknown>;
    if (!d.found) return json({ ok: false, error: 'not_found', message: `No public specifications found for a ${year} ${make} ${model}. Check the spelling, or add a trim.` });
    const sheet = { ...d, source: 'AI, from published specifications', looked_up: new Date().toISOString().slice(0, 10), query: { year: +year, make, model, trim: clean(body.trim || ''), kind: body.kind === 'bike' ? 'bike' : 'car', gearbox } };
    await admin.from('spec_cache').upsert({ key, data: sheet });
    return json({ ok: true, cached: false, sheet });
  } catch (e) {
    console.error(e);
    return json({ error: 'exception', message: 'Something went wrong looking up the specifications. Try again.' }, 500);
  }
});
