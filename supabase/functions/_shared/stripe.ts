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
// Find a secret by its usual name, or any env var whose name mentions stripe and whose value looks right
export function stripeSecret(names: string[], prefix: RegExp): string | null {
  for (const n of names) { const v = Deno.env.get(n)?.trim(); if (v && prefix.test(v)) return v; }
  try {
    const all = Object.entries(Deno.env.toObject());
    // sk_test_/sk_live_/whsec_ values are Stripe's own, so a match under any name is safe to use
    const hit = all.find(([k, v]) => /stripe/i.test(k) && prefix.test((v || '').trim())) || all.find(([, v]) => prefix.test((v || '').trim()));
    if (hit) return hit[1].trim();
    // names only, never values: enough to tell a missing secret from a misnamed or wrong one
    console.error('stripe secret not found. Names mentioning stripe:', all.map(([k]) => k).filter(k => /stripe/i.test(k)).join(', ') || '(none)',
      '| holding a publishable key (pk_):', all.filter(([, v]) => /^pk_/.test((v || '').trim())).map(([k]) => k).join(', ') || '(none)');
  } catch (_) { /* env listing not allowed */ }
  return null;
}
export const secretKey = () => stripeSecret(['STRIPE_SECRET_KEY', 'STRIPE_SECRET', 'STRIPE_KEY', 'STRIPE_API_KEY'], /^(sk|rk)_(test|live)_/);
export const webhookSecret = () => stripeSecret(['STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SIGNING_SECRET', 'STRIPE_SIGNING_SECRET', 'STRIPE_WHSEC'], /^whsec_/);

export async function stripe(path: string, params?: Record<string, unknown>, method = params ? 'POST' : 'GET') {
  const key = secretKey();
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

// Stripe Managed Payments (Stripe is the merchant of record and handles sales tax/VAT) needs a digital-goods
// tax code on every product: SaaS, personal use (browser-based, sold to individuals)
export const TAX_CODE = 'txcd_10103000';

export async function priceFor(plan: string): Promise<string> {
  const p = PLANS[plan]; if (!p) throw new StripeError('Unknown plan.', 'bad_plan');
  const found = await stripe('prices', { lookup_keys: [p.lookup], active: true, limit: 1, expand: ['data.product'] }, 'GET');
  const hit = found.data?.[0];
  if (hit?.id) {
    // products made before the tax code was set get it now
    const prod = hit.product, code = typeof prod?.tax_code === 'string' ? prod.tax_code : prod?.tax_code?.id;
    if (prod?.id && code !== TAX_CODE) await stripe(`products/${prod.id}`, { tax_code: TAX_CODE });
    return hit.id;
  }
  const product = await stripe('products', { name: p.name, tax_code: TAX_CODE, metadata: { app: 'autodex', plan } });
  const price = await stripe('prices', { product: product.id, unit_amount: p.amount, currency: 'usd', recurring: { interval: 'month' }, lookup_key: p.lookup, nickname: `${p.name} monthly` });
  return price.id;
}
