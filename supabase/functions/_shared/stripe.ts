// Stripe over plain fetch (no SDK). Prices are found, or created on first use, by lookup key,
// so the only setup in Stripe is the secret key and the webhook.
export const PLANS: Record<string, { lookup: string; amount: number; name: string }> = {
  pro: { lookup: 'autodex_pro_monthly', amount: 500, name: 'AUTODEX Pro' },
  concierge: { lookup: 'autodex_concierge_monthly', amount: 2000, name: 'AUTODEX Concierge' }
};
export const planFromLookup = (k?: string | null) => Object.entries(PLANS).find(([, p]) => p.lookup === k)?.[0] ?? null;

// Stripe takes form-encoded bodies with bracketed keys: a[b][0]=c
function form(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === 'object' ? form(x as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x)));
    else if (typeof v === 'object') form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}
export async function stripe(path: string, params?: Record<string, unknown>, method = params ? 'POST' : 'GET') {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new StripeError('Payments aren\'t set up yet.', 'missing_key');
  const qs = method === 'GET' && params ? '?' + form(params).toString() : '';
  const res = await fetch(`https://api.stripe.com/v1/${path}${qs}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : form(params || {}).toString()
  });
  const data = await res.json();
  if (!res.ok) { console.error('stripe', res.status, path, JSON.stringify(data).slice(0, 800)); throw new StripeError(data?.error?.message || `Stripe error ${res.status}`, data?.error?.code || 'stripe'); }
  return data;
}
export class StripeError extends Error { constructor(msg: string, public code: string) { super(msg); } }

export async function priceFor(plan: string): Promise<string> {
  const p = PLANS[plan]; if (!p) throw new StripeError('Unknown plan.', 'bad_plan');
  const found = await stripe('prices', { lookup_keys: [p.lookup], active: true, limit: 1 }, 'GET');
  if (found.data?.[0]?.id) return found.data[0].id;
  const product = await stripe('products', { name: p.name, metadata: { app: 'autodex', plan } });
  const price = await stripe('prices', { product: product.id, unit_amount: p.amount, currency: 'usd', recurring: { interval: 'month' }, lookup_key: p.lookup, nickname: `${p.name} monthly` });
  return price.id;
}
