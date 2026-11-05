// Works out the layout of a spreadsheet (which tab holds vehicles, history or readings, which column is
// which field, what each category label means). The app applies the map to every row itself.
import { askClaude, cors, gate, json } from '../_shared/ai.ts';

// The API allows at most 16 nullable (union-typed) fields per schema, and this map has more than 30.
// So "none" is written as "" or -1 here, and nulled() turns those back into null before the app sees them.
const str = (d: string) => ({ type: 'string', description: `${d} ("" if none)` });
const num = (d: string) => ({ type: 'number', description: `${d} (-1 if none)` });
const int = (d: string) => ({ type: 'integer', description: `${d} (-1 if none)` });
const oneOrNull = (vals: string[], d: string) => ({ type: 'string', enum: [...vals, ''], description: `${d} ("" if none)` });
const nulled = (x: unknown): unknown => Array.isArray(x) ? x.map(nulled)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, nulled(v)]))
  : x === '' || (typeof x === 'number' && x < 0) ? null : x;

const CATEGORIES = ['maintenance', 'repair', 'restoration', 'modification', 'parts', 'tyres', 'detailing', 'inspection', 'registration', 'insurance', 'other'];
const col = (d: string) => int(`0-based column index for ${d}`);
const VEHICLE = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'the exact text that identifies this vehicle in the history/readings vehicle column (copy it verbatim from the distinct values), or its name on the vehicles tab' },
    existing: str('when this is one of the vehicles already in the garage: its ref from that list (e.g. "G2"), otherwise empty'),
    other_keys: { type: 'array', items: { type: 'string' }, description: 'other exact spellings used for the same vehicle elsewhere in the file' },
    kind: { type: 'string', enum: ['car', 'bike'] },
    year: int('model year'), make: { type: 'string', description: 'manufacturer, e.g. Honda (add it when only the model is written, like CBX)' },
    model: str('model'), trim_level: str('version or trim'), colour: str('colour'), plate: str('licence plate'), vin: str('VIN or chassis number'),
    currency: oneOrNull(['BRL', 'USD'], 'currency of its prices'),
    purchase_date: str('YYYY-MM-DD'), purchase_price: num('price paid, plain number'),
    odometer: num('current odometer if given'), odometer_unit: oneOrNull(['km', 'mi'], 'odometer unit'),
    meter: { type: 'string', enum: ['distance', 'hours', 'both'] }, hours: num('engine hours if given'),
    status: { type: 'string', enum: ['owned', 'project', 'stored', 'sold'] },
    notes: str('anything else useful about the vehicle from the file, short')
  },
  required: ['key', 'existing', 'other_keys', 'kind', 'year', 'make', 'model', 'trim_level', 'colour', 'plate', 'vin', 'currency', 'purchase_date', 'purchase_price', 'odometer', 'odometer_unit', 'meter', 'hours', 'status', 'notes'],
  additionalProperties: false
};
const HISTORY = {
  type: 'object',
  properties: {
    sheet: { type: 'string', description: 'tab name, exactly' },
    header_row: { type: 'integer', description: '0-based index of the header row in that tab (data starts on the next row)' },
    vehicle_col: col('the vehicle name'), vehicle_key: str('when the whole tab is about one vehicle and has no vehicle column: that vehicle\'s key'),
    date_col: col('the date'), mileage_col: col('the odometer reading'), hours_col: col('engine hours'),
    shop_col: col('the shop or supplier'), title_col: col('the description of the work'), items_col: col('parts or detailed items'),
    category_col: col('the type/category of expense'), amount_col: col('the amount paid'), currency_col: col('the currency'), notes_col: col('notes'),
    default_currency: oneOrNull(['BRL', 'USD'], 'currency when there is no currency column'),
    default_category: { type: 'string', enum: CATEGORIES },
    category_map: { type: 'array', description: 'one entry for every distinct value of the category column', items: { type: 'object', properties: { value: { type: 'string' }, category: { type: 'string', enum: CATEGORIES } }, required: ['value', 'category'], additionalProperties: false } },
    reading_values: { type: 'array', items: { type: 'string' }, description: 'values of the category or description column that mark a row as just an odometer reading, not a service (e.g. "Leitura de odômetro")' }
  },
  required: ['sheet', 'header_row', 'vehicle_col', 'vehicle_key', 'date_col', 'mileage_col', 'hours_col', 'shop_col', 'title_col', 'items_col', 'category_col', 'amount_col', 'currency_col', 'notes_col', 'default_currency', 'default_category', 'category_map', 'reading_values'],
  additionalProperties: false
};
const READINGS = {
  type: 'object',
  properties: {
    sheet: { type: 'string' }, header_row: { type: 'integer' },
    vehicle_col: col('the vehicle name'), vehicle_key: str('when the whole tab is one vehicle'),
    date_col: col('the date'), odometer_col: col('the odometer reading'), hours_col: col('engine hours')
  },
  required: ['sheet', 'header_row', 'vehicle_col', 'vehicle_key', 'date_col', 'odometer_col', 'hours_col'],
  additionalProperties: false
};
const SCHEMA = {
  type: 'object',
  properties: {
    date_order: { type: 'string', enum: ['DMY', 'MDY', 'YMD'], description: 'how text dates are written in this file' },
    decimal_comma: { type: 'boolean', description: 'true when numbers are written like 1.234,56' },
    vehicles: { type: 'array', items: VEHICLE },
    history: { type: 'array', items: HISTORY, description: 'tabs (or tab sections) listing services, repairs, parts or other expenses' },
    readings: { type: 'array', items: READINGS, description: 'tabs that only log odometer readings' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'short notes for the owner about anything unclear, in the requested language' }
  },
  required: ['date_order', 'decimal_comma', 'vehicles', 'history', 'readings', 'warnings'],
  additionalProperties: false
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as { garage_id?: string; filename?: string; sheets?: unknown[]; existing?: unknown[] };
    if (!Array.isArray(body.sheets) || !body.sheets.length) return json({ error: 'empty', message: 'That file looks empty.' }, 400);
    const payload = JSON.stringify(body.sheets);
    if (payload.length > 400_000) return json({ error: 'too_big', message: 'That spreadsheet is too wide to read. Remove unused tabs or columns and try again.' }, 400);
    const g = await gate(req, body.garage_id, 'import');
    if ('fail' in g) return g.fail;
    const { data: garage } = await g.sb.from('garages').select('currency,distance_unit,lang').eq('id', body.garage_id).single();
    const lang = garage?.lang === 'pt' ? 'Brazilian Portuguese' : 'English';
    // Vehicles already in the garage (sent by the app as short refs), so the sheet can add to them instead of duplicating
    const existing = (Array.isArray(body.existing) ? body.existing : []).slice(0, 300)
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { ref?: unknown }).ref === 'string')
      .map(e => Object.fromEntries(['ref', 'kind', 'year', 'make', 'model', 'trim', 'colour', 'plate', 'vin', 'nickname'].filter(k => e[k] != null && e[k] !== '').map(k => [k, String(e[k]).slice(0, 60)])));
    const existingText = existing.length
      ? `\nThe garage already has these vehicles:\n${JSON.stringify(existing)}\nWhen a vehicle in the file is one of these (same plate or VIN, or clearly the same make, model and year), set existing to its ref and use the same make, model and year. Leave existing empty for anything new. Never give two file vehicles the same ref.\n`
      : '';

    const prompt = `A car and motorcycle owner uploaded the spreadsheet "${String(body.filename || '').slice(0, 120)}" to load their collection into a garage app. Below is each tab: its rows (each row an array of cells, row 0 first; a tab with many rows shows only its first rows) and, for long tabs, every distinct value per column.

Return a map of the file:
- vehicles: every distinct car or motorcycle. Split names like "CBX 1979 Vermelha" into make (Honda), model (CBX), year (1979), colour (Vermelha). key must be the exact text used to identify that vehicle in the history/readings vehicle column, copied verbatim; put other spellings of the same vehicle in other_keys. Use purchase details only when the file states them. If the file has a vehicles tab, use it for details.
- history: each tab that lists services, maintenance, repairs, parts, taxes, insurance or other costs per vehicle. Give 0-based column indexes. Map every distinct category value to one of: ${CATEGORIES.join(', ')}. List in reading_values any category/description values that mark a row as only an odometer reading.
- readings: tabs that only log odometer or hour readings.
- Keep text as written (don't translate); the app shows the user's own words.
- Default currency is ${garage?.currency || 'BRL'} and default distance unit is ${garage?.distance_unit || 'km'} unless the file says otherwise.
- warnings: up to 5 short notes in ${lang} about anything you couldn't place.
${existingText}
Tabs:
${payload}`;
    const out = await askClaude(g.key, [{ type: 'text', text: prompt }], SCHEMA, 16000);
    if ('fail' in out && out.fail) return out.fail;
    await g.record(out.usage);
    if (!out.data) return json({ error: 'no_map', message: out.stop === 'max_tokens' ? 'That file has too many vehicles to read in one go. Split it into two files and import each.' : 'Couldn\'t work out that spreadsheet. Check it lists your vehicles and try again.' }, 422);
    return json({ ok: true, map: nulled(out.data) });
  } catch (e) {
    console.error(e);
    return json({ error: 'exception', message: 'Something went wrong reading the spreadsheet. Try again.' }, 500);
  }
});
