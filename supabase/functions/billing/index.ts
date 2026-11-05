// Owners start, change or manage their garage's AUTODEX subscription.
//   checkout: Stripe Checkout for a plan (or, with a subscription already running, switches its plan)
//   portal:   Stripe's customer portal (card, invoices, cancel)
//   garage:   Stripe Checkout for extra garages on the account (US$20 each, one-time)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { cors, json } from '../_shared/ai.ts';
import { MAX_GARAGES_PER_BUY, PLANS, StripeError, planFromLookup, priceFor, stripe } from '../_shared/stripe.ts';

const SITE = Deno.env.get('SITE_URL') || 'https://autodex-garage.vercel.app';
// Only send people back to this site (or a local copy while developing)
const siteOf = (origin: string | null) => origin && (/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/.test(origin) || origin === SITE || /^http:\/\/localhost(:\d+)?$/.test(origin)) ? origin : SITE;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({})) as { garage_id?: string; action?: string; plan?: string; quantity?: number };
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ error: 'signed_out', message: 'Your sign-in expired. Sign in again and retry.' }, 401);
    const site = siteOf(req.headers.get('origin'));

    // An extra garage belongs to the account, not to a garage: its own Stripe customer on accounts
    if (body.action === 'garage') {
      const qty = Math.max(1, Math.min(MAX_GARAGES_PER_BUY, Math.floor(Number(body.quantity) || 1)));
      let { data: acc } = await admin.from('accounts').select('stripe_customer_id').eq('user_id', u.user.id).maybeSingle();
      let customer = acc?.stripe_customer_id as string | undefined;
      if (!customer) {
        const c = await stripe('customers', { email: u.user.email, description: 'AUTODEX account', metadata: { user_id: u.user.id } });
        customer = c.id;
        const { error } = await admin.from('accounts').upsert({ user_id: u.user.id, stripe_customer_id: customer }, { onConflict: 'user_id' });
        if (error) throw error;
      }
      const price = await priceFor('garage');
      const meta = { kind: 'garage_slots', user_id: u.user.id, quantity: String(qty) };
      const s = await stripe('checkout/sessions', {
        mode: 'payment', customer, client_reference_id: u.user.id,
        line_items: [{ price, quantity: qty }], metadata: meta,
        success_url: `${site}/?billing=garage#/dashboard`, cancel_url: `${site}/#/dashboard`
      });
      return json({ ok: true, url: s.url });
    }

    if (typeof body.garage_id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.garage_id)) return json({ error: 'bad_garage', message: 'Open a garage first.' }, 400);
    const { data: m } = await sb.from('garage_members').select('role').eq('garage_id', body.garage_id).eq('user_id', u.user.id).maybeSingle();
    if (m?.role !== 'owner') return json({ error: 'forbidden', message: 'Only the garage\'s owner can change its plan.' }, 403);

    // the garage's Stripe customer, created once
    let { data: bill } = await admin.from('billing').select('*').eq('garage_id', body.garage_id).maybeSingle();
    if (!bill?.stripe_customer_id) {
      const { data: g } = await admin.from('garages').select('name').eq('id', body.garage_id).single();
      const c = await stripe('customers', { email: u.user.email, description: g?.name ? `Garage: ${g.name}` : undefined, metadata: { garage_id: body.garage_id, user_id: u.user.id } });
      const { data: row, error } = await admin.from('billing').upsert({ garage_id: body.garage_id, stripe_customer_id: c.id, updated_at: new Date().toISOString() }).select().single();
      if (error) throw error;
      bill = row;
    }

    if (body.action === 'portal') {
      const s = await stripe('billing_portal/sessions', { customer: bill.stripe_customer_id, return_url: `${site}/#/plans` });
      return json({ ok: true, url: s.url });
    }

    if (body.action === 'checkout') {
      const plan = String(body.plan || '');
      if (!PLANS[plan]) return json({ error: 'bad_plan', message: 'Choose Pro or Concierge.' }, 400);
      const price = await priceFor(plan);
      // already subscribed: switch the plan on the same subscription (prorated) instead of a second checkout
      if (bill.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(bill.status || '')) {
        const sub = await stripe(`subscriptions/${bill.stripe_subscription_id}`, undefined, 'GET');
        const item = sub.items?.data?.[0];
        if (planFromLookup(item?.price?.lookup_key) === plan && !sub.cancel_at_period_end) return json({ ok: true, changed: false, message: 'You\'re already on that plan.' });
        await stripe(`subscriptions/${sub.id}`, { items: [{ id: item.id, price }], proration_behavior: 'create_prorations', cancel_at_period_end: false, metadata: { garage_id: body.garage_id } });
        return json({ ok: true, changed: true });
      }
      const s = await stripe('checkout/sessions', {
        mode: 'subscription', customer: bill.stripe_customer_id, client_reference_id: body.garage_id,
        line_items: [{ price, quantity: 1 }], allow_promotion_codes: true,
        subscription_data: { metadata: { garage_id: body.garage_id } }, metadata: { garage_id: body.garage_id },
        success_url: `${site}/?billing=done#/plans`, cancel_url: `${site}/#/plans`
      });
      return json({ ok: true, url: s.url });
    }
    return json({ error: 'bad_action', message: 'Unknown request.' }, 400);
  } catch (e) {
    console.error(e);
    if (e instanceof StripeError) return json({ error: e.code, message: e.code === 'missing_key' ? e.message + ' Try again later.' : 'The payment service couldn\'t take this request. Try again in a minute.' }, 502);
    return json({ error: 'exception', message: 'Something went wrong. Try again.' }, 500);
  }
});
