// Fills in a vehicle's details.
//   mode "vin":     17-character VIN → NHTSA vPIC (free, never counts against the allowance)
//   mode "chassis": a classic or make-specific chassis number → the AI's best reading, marked as likely (1 scan)
//   mode "photo":   a photo of the VIN plate, the number plate, the registration document (CRLV / title) or the car (1 scan)
import { askClaude, cors, gate, json } from '../_shared/ai.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// The API allows at most 16 nullable fields per schema, so "none" is "" or -1 here and nulled() turns them back
const s = (d: string) => ({ type: 'string', description: `${d} ("" if not shown / unknown)` });
const i = (d: string) => ({ type: 'integer', description: `${d} (-1 if not shown / unknown)` });
const nulled = (x: unknown): unknown => Array.isArray(x) ? x.map(nulled)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, nulled(v)]))
  : x === '' || (typeof x === 'number' && x < 0) ? null : x;

const FIELDS = {
  vin: s('VIN or chassis number, exactly as printed, no spaces'),
  plate: s('licence plate, exactly as printed (Brazilian plates like ABC1D23 or ABC-1234)'),
  year: i('model year'), build_year: i('year of manufacture, when different from the model year (Brazil: "ano de fabricação")'),
  make: s('manufacturer, e.g. Volkswagen, Porsche, BMW'), model: s('model, e.g. Fusca, 911, 1M'),
  trim_level: s('version or trim, e.g. Carrera 4S, 1600'), series: s('generation or series, e.g. 997.2, E82, Type 1'),
  colour: s('colour, in the language printed'), body: s('body style, e.g. Coupe, Convertible, Sedan'),
  engine: s('engine, e.g. 3.8 L flat-6'), power: s('power, e.g. 385 hp'), transmission: s('transmission'), drivetrain: s('RWD, AWD, FWD or 4WD'),
  plant: s('where it was built, city and country'), fuel: s('fuel')
};
const KEYS = Object.keys(FIELDS);
const photoSchema = (extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: { ...FIELDS, ...extra, readable: { type: 'boolean', description: 'false if the photo is not what was asked for or too unclear to read' }, warnings: { type: 'array', items: { type: 'string' }, description: 'anything the owner should double-check, short, in the requested language' } },
  required: [...KEYS, ...Object.keys(extra), 'readable', 'warnings'], additionalProperties: false
});
const CHASSIS = {
  type: 'object',
  properties: { ...FIELDS, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, explanation: { type: 'string', description: 'one or two sentences, in the requested language, on how the number was read (which digits mean what) and what is uncertain' } },
  required: [...KEYS, 'confidence', 'explanation'], additionalProperties: false
};

const PHOTO_TASK: Record<string, string> = {
  vin: 'This is a photo of a vehicle identification plate, windscreen VIN sticker, door-jamb label or chassis stamping. Read the VIN / chassis number exactly (no spaces; never confuse O/0 or I/1: VINs from 1981 on never use I, O or Q). Fill anything else the plate states (make, model, year, colour or paint code, engine, plant).',
  plate: 'This is a photo of a vehicle (or its number plate). Read the licence plate exactly as printed. If the car itself is visible, also fill make, model, colour and body.',
  document: 'This is a vehicle registration document: a Brazilian CRLV / CRLV-e / CRV, a US certificate of title or registration card, or similar. Read the vehicle\'s details: plate (placa), VIN (chassi), make and model (marca/modelo), model year and year of manufacture (ano modelo / ano fabricação), colour (cor), fuel (combustível), body (espécie/tipo or carroceria). Do NOT return any personal data about the owner (names, CPF/CNPJ, addresses).',
  car: 'This is a photo of a car or motorcycle. Identify it as precisely as the photo allows: make, model, generation or series, likely model-year range (give the most likely single year only if the photo makes it clear), body style and colour. Put the uncertainty in warnings, e.g. "Could also be a 2011 facelift". If you can read the number plate, fill it.'
};

function vpic(r: Record<string, string>) {
  const t = (k: string) => (r[k] || '').trim();
  const cyl = t('EngineCylinders'), disp = t('DisplacementL'), conf = t('EngineConfiguration');
  // "3.8 L flat-6 (M97)", "4.0 L V8", "3.0 L inline-6"
  const layout = /opposed|boxer/i.test(conf) ? 'flat-' : /^v/i.test(conf) ? 'V' : /^w/i.test(conf) ? 'W' : /line/i.test(conf) ? 'inline-' : '';
  const cylTxt = cyl ? (layout ? layout + cyl : `${cyl}-cylinder`) : '';
  const engine = [disp && +disp ? `${(+disp).toFixed(1)} L` : '', cylTxt, t('EngineModel') ? `(${t('EngineModel')})` : ''].filter(Boolean).join(' ');
  const trans = [t('TransmissionSpeeds') ? `${t('TransmissionSpeeds')}-speed` : '', t('TransmissionStyle').toLowerCase()].filter(Boolean).join(' ');
  const drive = t('DriveType'); const dt = /4x2|rear/i.test(drive) && /rear/i.test(drive) ? 'RWD' : /front/i.test(drive) ? 'FWD' : /all|awd/i.test(drive) ? 'AWD' : /4x4|4wd/i.test(drive) ? '4WD' : drive;
  const plant = [t('PlantCity') && t('PlantCity').replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase()), t('PlantCountry') && t('PlantCountry').replace(/\(.*?\)/g, '').trim().replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase())].filter(Boolean).join(', ');
  const make = t('Make') ? t('Make').replace(/\b\w+/g, w => w.length <= 3 && /^[A-Z]+$/.test(w) ? w : w[0] + w.slice(1).toLowerCase()) : '';
  return {
    year: +t('ModelYear') || null, make: make || null, model: t('Model') || null, trim_level: t('Trim') || null, series: t('Series') || null,
    body: t('BodyClass') ? t('BodyClass').replace(/\/.*$/, '').replace(/ \(.*\)/, '') : null, engine: engine || null,
    power: t('EngineHP') ? `${Math.round(+t('EngineHP'))} hp` : null, transmission: trans || null, drivetrain: dt || null, plant: plant || null,
    fuel: t('FuelTypePrimary') || null, manufacturer: t('Manufacturer') || null
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as { mode?: string; vin?: string; kind?: string; data?: string; media_type?: string; garage_id?: string; hint?: Record<string, unknown> };

    if (body.mode === 'vin') {
      // free: signed-in users only, no allowance
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
      const { data: u } = await sb.auth.getUser();
      if (!u?.user) return json({ error: 'signed_out', message: 'Your sign-in expired. Sign in again and retry.' }, 401);
      const vin = String(body.vin || '').toUpperCase().replace(/[\s-]/g, '');
      if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return json({ ok: false, error: 'not_vin', message: 'That isn\'t a 17-character VIN.' });
      const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`);
      if (!res.ok) return json({ ok: false, error: 'nhtsa', message: 'The VIN database didn\'t answer. Try again in a minute.' }, 502);
      const r = (await res.json())?.Results?.[0] || {};
      const fields = vpic(r);
      const errs = String(r.ErrorCode || '').split(',').map(x => x.trim());
      const found = !!(fields.make && (fields.model || fields.year));
      // 1 = check digit wrong (often fine for cars built outside North America), 0 = clean
      return json({ ok: found, source: 'NHTSA', fields, check_digit_ok: !errs.includes('1'), partial: found && !fields.model, message: found ? '' : 'The VIN database doesn\'t know this number. It may be a classic or a vehicle built for another market.', detail: String(r.ErrorText || '').slice(0, 300) });
    }

    const g = await gate(req, body.garage_id, 'scan');
    if ('fail' in g) return g.fail;
    const { data: garage } = await g.sb.from('garages').select('lang').eq('id', body.garage_id).single();
    const lang = garage?.lang === 'pt' ? 'Brazilian Portuguese' : 'English';

    if (body.mode === 'chassis') {
      const num = String(body.vin || '').toUpperCase().replace(/\s/g, '').slice(0, 40);
      if (num.length < 4) return json({ error: 'bad', message: 'Type the chassis number first.' }, 400);
      const h = body.hint && typeof body.hint === 'object' ? Object.entries(body.hint).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(', ') : '';
      const prompt = `A car or motorcycle collector typed this chassis / VIN number: "${num}". ${h ? `They also said: ${h}.` : ''}
Decode it using what you know about that manufacturer's numbering (pre-1981 chassis numbers, Brazilian chassis numbers, make-specific schemes like Porsche, BMW, Mercedes-Benz, VW Type 1 chassis series, Puma, Ferrari, Alfa Romeo and so on, and modern 17-character VINs from markets NHTSA doesn't cover, such as Brazil's 9BW, 9BD or 93Y prefixes).
Return the most likely make, model, series, model year, body, engine, plant (where it was built). Only fill what the number or the owner's hints actually support; leave the rest empty. Set confidence honestly. Write the explanation in ${lang}.`;
      const out = await askClaude(g.key, [{ type: 'text', text: prompt }], CHASSIS, 3000);
      if ('fail' in out && out.fail) return out.fail;
      await g.record(out.usage);
      if (!out.data) return json({ error: 'no_read', message: 'Couldn\'t decode that number. Check it against the chassis plate.' }, 422);
      return json({ ok: true, source: 'AI', fields: nulled(out.data) });
    }

    if (body.mode === 'photo') {
      const kind = String(body.kind || '');
      if (!PHOTO_TASK[kind]) return json({ error: 'bad', message: 'Unknown photo type.' }, 400);
      const media = String(body.media_type || '');
      if (!body.data || !/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(media)) return json({ error: 'bad_file', message: 'Send a photo (JPG or PNG) or, for documents, a PDF.' }, 400);
      if (media === 'application/pdf' ? body.data.length > 28_000_000 : body.data.length > 7_000_000) return json({ error: 'too_big', message: 'That file is too large to read. Take the photo again.' }, 400);
      const block = media === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: media, data: body.data } }
        : { type: 'image', source: { type: 'base64', media_type: media, data: body.data } };
      const prompt = `${PHOTO_TASK[kind]}\nKeep names as printed (don't translate). Leave a field empty when it isn't shown; never guess a VIN or plate. Write warnings in ${lang}.`;
      const out = await askClaude(g.key, [block, { type: 'text', text: prompt }], photoSchema(), 3000);
      if ('fail' in out && out.fail) return out.fail;
      await g.record(out.usage);
      const d = out.data ? nulled(out.data) as Record<string, unknown> : null;
      if (!d || d.readable === false) return json({ error: 'unreadable', message: { vin: 'Couldn\'t read a VIN in that photo. Get closer, avoid glare, and keep the whole number in frame.', plate: 'Couldn\'t read a plate in that photo. Try again, closer and straight on.', document: 'Couldn\'t read that document. Lay it flat in good light with the whole page in frame.', car: 'Couldn\'t identify the vehicle in that photo. A clear side or three-quarter view works best.' }[kind], warnings: d?.warnings || [] }, 422);
      if (typeof d.vin === 'string') d.vin = d.vin.toUpperCase().replace(/[\s-]/g, '');
      if (typeof d.plate === 'string') d.plate = d.plate.toUpperCase().replace(/\s/g, '');
      return json({ ok: true, source: 'AI', fields: d });
    }
    return json({ error: 'bad', message: 'Unknown request.' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'exception', message: 'Something went wrong. Try again.' }, 500);
  }
});
