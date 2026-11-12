// Finds comparable sales and listings for a vehicle by searching the public web with Claude's web search tool.
// Nothing is saved here: the app shows what was found and the owner chooses which ones to add as comparables.
// Every result must carry a link that really came back from the search (links the model writes from memory are dropped).
// Counts as one scan from the garage's monthly allowance.
import { cors, gate, json, MODEL } from '../_shared/ai.ts';

const REPORT = {
  name: 'report_comparables',
  description: 'Report the comparable sales and listings found. Call this exactly once, after searching, even if nothing suitable was found (then with an empty list).',
  input_schema: {
    type: 'object', required: ['comparables', 'note'],
    properties: {
      comparables: { type: 'array', maxItems: 10, items: {
        type: 'object', required: ['title', 'url', 'price', 'currency', 'kind', 'date'],
        properties: {
          title: { type: 'string', description: 'Short description as listed, e.g. "1973 Porsche 911 S 2.4 Coupe, matching numbers"' },
          url: { type: 'string', description: 'The exact URL of the search result this came from. Never a URL from memory.' },
          price: { type: 'number', description: 'Sold price, or asking price for a listing, as a plain number in the listed currency' },
          currency: { type: 'string', description: 'ISO 4217 code of the listed price, e.g. USD, BRL, EUR, GBP' },
          kind: { type: 'string', enum: ['sold', 'asking'], description: 'sold = a completed sale with a final price; asking = a listing or an unsold high bid' },
          date: { type: 'string', description: 'Sale date, or listing date, as YYYY-MM-DD. For a live listing with no date shown, today.' },
          mileage: { type: ['integer', 'null'], description: 'Odometer shown, or null' },
          mileage_unit: { anyOf: [{ type: 'string', enum: ['mi', 'km'] }, { type: 'null' }] },
          why: { type: 'string', description: 'A few words on how it compares: condition, spec, anything that makes it worth more or less' }
        } } },
      note: { type: 'string', description: 'One sentence for the owner on what was found and how good a match it is' }
    }
  }
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const norm = (u: string) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase(); } catch (_) { return ''; } };
type Block = { type: string; [k: string]: unknown };

async function ask(key: string, body: Record<string, unknown>) {
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text(); console.error('anthropic', res.status, t.slice(0, 1000));
    const off = res.status === 400 && /web search/i.test(t);
    return { fail: json({ error: 'claude', message: off ? 'Web search isn\'t switched on for this app yet. Contact support.' : res.status === 429 ? 'Too many requests at once. Wait a moment and try again.' : res.status >= 500 ? 'The search is busy right now. Try again in a minute.' : `The search couldn't run (${res.status}). Try again, or contact support if it keeps happening.` }, 502) };
  }
  return { out: await res.json() as { content: Block[]; stop_reason: string; usage?: { input_tokens?: number; output_tokens?: number } } };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as { garage_id?: string; vehicle_id?: string };
    const g = await gate(req, body.garage_id, 'scan');
    if ('fail' in g) return g.fail;
    if (typeof body.vehicle_id !== 'string') return json({ error: 'bad_request', message: 'Open a vehicle first.' }, 400);
    // read through the caller's own access, so only a member of the garage can ask about its vehicles
    const { data: v } = await g.sb!.from('vehicles').select('id,garage_id,kind,year,make,model,trim_level,series,body,gearbox,transmission,colour,odometer,odometer_unit,currency').eq('id', body.vehicle_id).eq('garage_id', body.garage_id!).maybeSingle();
    if (!v) return json({ error: 'not_found', message: 'That vehicle isn\'t in this garage.' }, 404);
    if (!v.make || !v.model) return json({ error: 'bad_request', message: 'Add the make and model first, so there is something to search for.' }, 400);
    const { data: gar } = await g.sb!.from('garages').select('country,currency').eq('id', body.garage_id!).maybeSingle();
    const country = (gar?.country || '').toUpperCase(), cur = v.currency || gar?.currency || 'USD';
    const today = new Date(), oldest = new Date(today.getTime() - 3 * 365 * 864e5);
    const car = [v.year, v.make, v.model, v.trim_level].filter(Boolean).join(' ');
    const extra = [v.series && `series/generation ${v.series}`, v.body && `body ${v.body}`, (v.gearbox || v.transmission) && `gearbox ${v.gearbox || v.transmission}`, v.odometer != null && `about ${v.odometer} ${v.odometer_unit || 'km'}`].filter(Boolean).join(', ');
    const where = country === 'BR' ? 'It is in Brazil: look first for Brazilian listings and sales in BRL (for example Webmotors, OLX, Mercado Livre, Brazilian classic-car dealers and auctions). Only if there are too few, add sales from other countries.'
      : country === 'US' ? 'It is in the United States: look first for US sales and listings in USD (for example Bring a Trailer and Cars & Bids results, Classic.com, Hemmings, dealer listings).'
      : country ? `It is in country code ${country}: look first for sales and listings there, in the local currency, then well-known international auction results.` : 'Look for well-known auction results and listings.';
    const prompt = `Find comparable sales and listings for this ${v.kind === 'bike' ? 'motorcycle' : 'car'}, to estimate its market value: ${car}${extra ? ` (${extra})` : ''}. The owner keeps its figures in ${cur}.
${where}
Search the web, then call report_comparables once.
Rules:
- The same model and generation, and as close as possible in year, version, body and gearbox. Leave out different generations, replicas, project or salvage cars and parts.
- Prefer completed sales with a final price and date (kind "sold"). Listings with an asking price are fine too (kind "asking"); an auction that ended unsold is "asking" at its high bid.
- From ${iso(oldest)} to today (${iso(today)}) only. Newest first.
- Report only what the search results themselves show: the price, its currency, the date and the result's own URL. If a price or a URL isn't in the results, leave that car out. Never estimate a price and never write a link from memory.
- One entry per car; at most 10; fewer good matches are better than many loose ones. If nothing fits, report an empty list and say so in the note.`;
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4, ...(/^[A-Z]{2}$/.test(country) ? { user_location: { type: 'approximate', country } } : {}) }, REPORT];
    const messages: { role: string; content: unknown }[] = [{ role: 'user', content: prompt }];
    const usage = { input_tokens: 0, output_tokens: 0 }, seen = new Set<string>();
    let report: Block | undefined, searches = 0;
    for (let i = 0; i < 4 && !report; i++) {
      // the last round insists on the report, in case the model answered in prose
      const r = await ask(g.key!, { model: MODEL, max_tokens: 3500, tools, messages, ...(i === 3 && messages[messages.length - 1].role === 'user' ? { tool_choice: { type: 'tool', name: 'report_comparables' } } : {}) });
      if ('fail' in r) return r.fail;
      const out = r.out; usage.input_tokens += out.usage?.input_tokens || 0; usage.output_tokens += out.usage?.output_tokens || 0;
      for (const b of out.content || []) {
        if (b.type === 'server_tool_use') searches++;
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const s of b.content as Block[]) { const k = norm(String(s.url || '')); if (k) seen.add(k); }
        if (b.type === 'tool_use' && b.name === 'report_comparables') report = b;
      }
      if (report) break;
      messages.push({ role: 'assistant', content: out.content });
      if (out.stop_reason !== 'pause_turn') { messages.push({ role: 'user', content: 'Now call report_comparables with what you found.' }); i = Math.max(i, 2); }
    }
    await g.record(usage);
    const inp = (report?.input || {}) as { comparables?: Record<string, unknown>[]; note?: string };
    const out: Record<string, unknown>[] = [], dup = new Set<string>(); let dropped = 0;
    for (const c of inp.comparables || []) {
      const url = String(c.url || '').trim(), k = norm(url), price = Number(c.price), currency = String(c.currency || '').toUpperCase(), date = String(c.date || '');
      const ok = /^https?:\/\//.test(url) && k && seen.has(k) && !dup.has(k) && isFinite(price) && price > 0 && /^[A-Z]{3}$/.test(currency) && /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date)) && date <= iso(today) && date >= iso(oldest);
      if (!ok) { dropped++; continue; }
      dup.add(k);
      const mi = Number.isInteger(c.mileage) && (c.mileage as number) >= 0 ? c.mileage : null;
      out.push({ title: String(c.title || '').slice(0, 160), url, price: Math.round(price * 100) / 100, currency, kind: c.kind === 'sold' ? 'sold' : 'asking', date, mileage: mi, mileage_unit: mi != null ? (c.mileage_unit === 'km' || c.mileage_unit === 'mi' ? c.mileage_unit : (v.odometer_unit || 'km')) : null, why: String(c.why || '').slice(0, 200) });
    }
    out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    console.log('find-comps', car, { searches, results: seen.size, reported: (inp.comparables || []).length, kept: out.length, dropped, usage });
    return json({ ok: true, vehicle: car, comparables: out, note: String(inp.note || '').slice(0, 300), dropped });
  } catch (e) {
    console.error(e);
    return json({ error: 'exception', message: 'Something went wrong while searching. Try again.' }, 500);
  }
});
