// Shared by the edge functions (import from "../_shared/ai.ts").
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

export const MODEL = 'claude-sonnet-5-5';
// Monthly AI allowance per garage, by plan
export const LIMITS: Record<string, Record<string, number>> = {
  free: { scan: 10, import: 2, illustrate: 3, specs: 25 },          // Free
  pro: { scan: 50, import: 10, illustrate: 15, specs: 100 },         // Pro, US$5/month
  concierge: { scan: 200, import: 30, illustrate: 50, specs: 400 }   // Concierge, US$20/month
};
export const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
export const str = (d: string) => ({ type: ['string', 'null'], description: d });
export const num = (d: string) => ({ type: ['number', 'null'], description: d });
export const int = (d: string) => ({ type: ['integer', 'null'], description: d });
// "one of these values, or null" must be written as anyOf: an enum under a union type is rejected
export const oneOrNull = (vals: string[], d: string) => ({ anyOf: [{ type: 'string', enum: vals }, { type: 'null' }], description: d });

export const findKey = (): string | null => {
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'anthropic_api_key']) { const t = Deno.env.get(k); if (t && t.trim()) return t.trim(); }
  try { for (const [k, t] of Object.entries(Deno.env.toObject())) if (/anthropic|claude/i.test(k) && t && t.trim()) return t.trim(); } catch (_) { /* env listing not allowed */ }
  return null;
};

// Who's calling, can they write to this garage, and is there allowance left this month?
export type Kind = 'scan' | 'import' | 'illustrate' | 'specs';
const KIND_WORDS: Record<Kind, string> = { scan: 'invoice scans', import: 'spreadsheet imports', illustrate: 'illustrations', specs: 'spec lookups' };
export async function gate(req: Request, garageId: unknown, kind: Kind, needsKey = true) {
  const auth = req.headers.get('Authorization') ?? '';
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: u } = await sb.auth.getUser();
  if (!u?.user) return { fail: json({ error: 'signed_out', message: 'Your sign-in expired. Sign in again and retry.' }, 401) };
  if (typeof garageId !== 'string' || !/^[0-9a-f-]{36}$/.test(garageId)) return { fail: json({ error: 'bad_garage', message: 'Open a garage first.' }, 400) };
  const { data: m } = await sb.from('garage_members').select('role, garage:garages(plan)').eq('garage_id', garageId).eq('user_id', u.user.id).maybeSingle();
  if (!m || !['owner', 'editor'].includes(m.role)) return { fail: json({ error: 'forbidden', message: 'Only owners and editors of this garage can do this.' }, 403) };
  const plan = (m.garage as { plan?: string } | null)?.plan || 'free';
  const limit = (LIMITS[plan] || LIMITS.free)[kind];
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
  const { count } = await admin.from('usage_events').select('id', { count: 'exact', head: true }).eq('garage_id', garageId).eq('kind', kind).gte('created_at', since.toISOString());
  if ((count ?? 0) >= limit) return { fail: json({ error: 'limit', message: `This garage has used its ${limit} ${KIND_WORDS[kind]} for this month. The allowance resets on the 1st.` }, 429) };
  const key = needsKey ? findKey() : '';
  if (needsKey && !key) return { fail: json({ error: 'missing_key', message: 'The AI reader isn\'t set up yet. Try again later.' }, 503) };
  const record = (usage: { input_tokens?: number; output_tokens?: number } | undefined) =>
    admin.from('usage_events').insert({ garage_id: garageId, user_id: u.user.id, kind, tokens_in: usage?.input_tokens ?? null, tokens_out: usage?.output_tokens ?? null });
  return { sb, key, record };
}

export async function askClaude(key: string, content: unknown[], schema: unknown, maxTokens: number) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, output_config: { effort: 'low', format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content }] })
  });
  if (!res.ok) {
    const t = await res.text();
    let reason = ''; try { reason = JSON.parse(t)?.error?.message || ''; } catch (_) { reason = t.slice(0, 200); }
    console.error('anthropic', res.status, t.slice(0, 1000));
    const message = res.status === 429 ? 'Too many requests at once. Wait a moment and try again.'
      : res.status === 529 || res.status >= 500 ? 'The AI reader is busy right now. Try again in a minute.'
      : `The AI reader couldn't take this request (${res.status}). Try again, or contact support if it keeps happening.`;
    return { fail: json({ error: 'claude', message, detail: reason }, 502) };
  }
  const out = await res.json();
  const text = (out.content || []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
  let data: Record<string, unknown> | null = null;
  try { data = JSON.parse(text); } catch (_) { console.error('unparseable', out.stop_reason, text.slice(0, 500)); }
  return { data, usage: out.usage, stop: out.stop_reason };
}
