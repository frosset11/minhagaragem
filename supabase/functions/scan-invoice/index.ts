// Reads a photo or PDF of a service invoice and returns a draft service record for one garage.
import { askClaude, cors, gate, json, num, oneOrNull, str } from '../_shared/ai.ts';

const CATEGORIES = ['maintenance', 'repair', 'restoration', 'modification', 'parts', 'tyres', 'detailing', 'inspection', 'registration', 'insurance', 'other'];
const SCHEMA = {
  type: 'object',
  properties: {
    vehicle_id: str('id of the matching vehicle from the list, or null if unsure'),
    vehicle_match_reason: { type: 'string', description: 'why this vehicle was chosen (plate, VIN, model on the invoice), or why none' },
    date: str('service/invoice date as YYYY-MM-DD'),
    shop: str('business name of the shop or seller'),
    title: { type: 'string', description: 'short summary of the work in the requested language, e.g. "Oil and filter change, brake fluid"' },
    category: { type: 'string', enum: CATEGORIES },
    items: { type: 'array', items: { type: 'string' }, description: 'each part or labour line, short, in the requested language' },
    mileage: num('odometer reading printed on the invoice, plain number; null if none'),
    mileage_unit: oneOrNull(['mi', 'km'], 'unit of the odometer reading'),
    hours: num('engine hours if printed'),
    amount: num('final total charged including taxes and labour'),
    currency: oneOrNull(['USD', 'BRL'], 'currency of the total'),
    invoice_number: str('invoice or nota fiscal number'),
    plate: str('license plate if printed'),
    vin: str('VIN / chassis number if printed'),
    warnings: { type: 'array', items: { type: 'string' }, description: 'anything unclear or unreadable the owner should double-check' }
  },
  required: ['vehicle_id', 'vehicle_match_reason', 'date', 'shop', 'title', 'category', 'items', 'mileage', 'mileage_unit', 'hours', 'amount', 'currency', 'invoice_number', 'plate', 'vin', 'warnings'],
  additionalProperties: false
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as { data?: string; media_type?: string; vehicle_id?: string; garage_id?: string };
    const g = await gate(req, body.garage_id, 'scan');
    if ('fail' in g) return g.fail;
    const media = String(body.media_type || '');
    if (!body.data || !/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(media)) return json({ error: 'bad_file', message: 'Send a JPG, PNG or PDF of the invoice.' }, 400);
    if (body.data.length > 7_000_000) return json({ error: 'too_big', message: 'That file is too large. Use a photo or a PDF under 5 MB.' }, 400);

    const [{ data: vehicles }, { data: garage }] = await Promise.all([
      g.sb.from('vehicles').select('id,kind,year,make,model,trim_level,colour,plate,vin,odometer,odometer_unit,currency').eq('garage_id', body.garage_id).neq('status', 'sold'),
      g.sb.from('garages').select('lang').eq('id', body.garage_id).single()
    ]);
    if (!vehicles || !vehicles.length) return json({ error: 'no_vehicles', message: 'Add a vehicle to this garage first, then scan its invoices.' }, 400);
    const lang = garage?.lang === 'pt' ? 'Brazilian Portuguese' : 'English';

    const list = vehicles.map(v => `${v.id} | ${[v.year, v.make, v.model, v.trim_level].filter(Boolean).join(' ')}${v.colour ? ' (' + v.colour + ')' : ''}${v.plate ? ' | plate ' + v.plate : ''}${v.vin ? ' | VIN ' + v.vin : ''} | odometer in ${v.odometer_unit}${v.odometer != null ? ' (last ' + v.odometer + ')' : ''} | ${v.currency}`).join('\n');
    const hint = body.vehicle_id ? `The owner opened this from vehicle ${body.vehicle_id}; choose it unless the invoice clearly names a different vehicle.` : 'Pick the vehicle the invoice is for, using plate, VIN, make/model and mileage. Use null if you cannot tell.';
    const prompt = `This is a service invoice, receipt or Brazilian nota fiscal for a car or motorcycle. Read it and return the JSON.\n\nRules:\n- Write title, items and warnings in ${lang}; keep proper names (shops, part brands) as printed.\n- amount is the final total actually charged (after discounts, including taxes and labour). Brazilian numbers use "1.234,56" = 1234.56.\n- currency: BRL for R$, USD for $/US$.\n- date as YYYY-MM-DD; Brazilian dates are DD/MM/YYYY.\n- mileage only if an odometer/KM/miles reading is printed; never guess.\n- items: one entry per part or labour line, short.\n- category: maintenance for routine service, repair for fixing faults, parts for parts-only purchases, tyres for tyres, registration for licensing/taxes, inspection for inspections.\n- Put anything uncertain in warnings. Use null for anything not on the invoice.\n\n${hint}\n\nVehicles (id | vehicle | plate | VIN | odometer unit | currency):\n${list}`;
    const fileBlock = media === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: media, data: body.data } }
      : { type: 'image', source: { type: 'base64', media_type: media, data: body.data } };

    const out = await askClaude(g.key, [fileBlock, { type: 'text', text: prompt }], SCHEMA, 6000);
    if ('fail' in out && out.fail) return out.fail;
    await g.record(out.usage);
    const d = out.data;
    if (!d) return json({ error: 'no_draft', message: out.stop === 'refusal' ? 'The reader declined this file. Try a clearer photo of just the invoice.' : 'Couldn\'t read that invoice. Try a sharper, well-lit photo.' }, 422);
    if (d.vehicle_id && !vehicles.some(v => v.id === d.vehicle_id)) d.vehicle_id = null;
    if (!CATEGORIES.includes(String(d.category))) d.category = 'maintenance';
    if (!Array.isArray(d.items)) d.items = [];
    if (!Array.isArray(d.warnings)) d.warnings = [];
    return json({ ok: true, draft: d });
  } catch (e) {
    console.error(e);
    return json({ error: 'exception', message: 'Something went wrong reading the invoice. Try again.' }, 500);
  }
});
