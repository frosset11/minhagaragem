// Stripe tells us about subscriptions here; we keep billing and garages.plan in step.
// Deployed with verify_jwt off: Stripe signs each request instead (STRIPE_WEBHOOK_SECRET).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { planFromLookup, stripe, webhookSecret } from '../_shared/stripe.ts';

const enc = new TextEncoder();
async function verify(payload: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')).map(([k, ...v]) => [k, v.join('=')])) as Record<string, string>;
  const sigs = header.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Apply one subscription's state to its garage
async function apply(sub: Record<string, any>, deleted = false) {
  let garage = sub.metadata?.garage_id as string | undefined;
  if (!garage) { const { data } = await admin.from('billing').select('garage_id').eq('stripe_customer_id', sub.customer).maybeSingle(); garage = data?.garage_id; }
  if (!garage) { console.warn('subscription without a garage', sub.id); return; }
  const item = sub.items?.data?.[0];
  const live = !deleted && ['active', 'trialing', 'past_due'].includes(sub.status);
  const plan = live ? (planFromLookup(item?.price?.lookup_key) || 'free') : 'free';
  const end = sub.current_period_end ?? item?.current_period_end; // newer API versions keep it on the item
  const { error } = await admin.from('billing').upsert({
    garage_id: garage, stripe_customer_id: sub.customer, stripe_subscription_id: sub.id, plan, status: deleted ? 'canceled' : sub.status,
    current_period_end: end ? new Date(end * 1000).toISOString() : null, cancel_at_period_end: !!sub.cancel_at_period_end, updated_at: new Date().toISOString()
  });
  if (error) throw error;
  const { error: e2 } = await admin.from('garages').update({ plan }).eq('id', garage);
  if (e2) throw e2;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  const secret = webhookSecret();
  if (!secret) console.error('STRIPE_WEBHOOK_SECRET missing');
  const payload = await req.text();
  if (!secret || !(await verify(payload, req.headers.get('stripe-signature') || '', secret))) return new Response('bad signature', { status: 400 });
  const event = JSON.parse(payload);
  const { data: seen } = await admin.from('stripe_events').select('id').eq('id', event.id).maybeSingle();
  if (seen) return new Response('already handled');
  try {
    const o = event.data?.object || {};
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && o.mode === 'payment' && o.metadata?.kind === 'garage_slots') {
      // extra garages: added once per paid session (grant_garage_slots ignores a session it has seen)
      if (o.payment_status === 'paid') {
        const qty = Number(o.metadata.quantity) || 1;
        const { data, error } = await admin.rpc('grant_garage_slots', { p_user: o.metadata.user_id || o.client_reference_id, p_session: o.id, p_qty: qty, p_amount: o.amount_total ?? null, p_currency: o.currency ?? null });
        if (error) throw error;
        console.log('garage slots', o.id, qty, '->', data);
      }
    } else if (event.type === 'checkout.session.completed' && o.mode === 'subscription' && o.subscription) {
      if (o.client_reference_id) await admin.from('billing').upsert({ garage_id: o.client_reference_id, stripe_customer_id: o.customer, updated_at: new Date().toISOString() });
      await apply(await stripe(`subscriptions/${o.subscription}`, undefined, 'GET'));
    } else if (['customer.subscription.created', 'customer.subscription.updated'].includes(event.type)) {
      await apply(o);
    } else if (event.type === 'customer.subscription.deleted') {
      await apply(o, true);
    }
    await admin.from('stripe_events').insert({ id: event.id, type: event.type });
    return new Response('ok');
  } catch (e) {
    console.error('webhook', event.type, e);
    return new Response('error', { status: 500 }); // Stripe retries
  }
});
