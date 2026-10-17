import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentStatus, createCheckout, verifyWebhook, createPortal, cancelSubscription } from '../src/server/payments.js';
import { MemoryStore } from '../src/server/store.js';

const origin = 'https://world.example';
const env = { STRIPE_SECRET_KEY: 'sk_test_mock_secret', STRIPE_WEBHOOK_SECRET: 'whsec_mock_signing_secret', APP_ORIGIN: origin };
const catalog = [
  { id: 'crystals_80', crystals: 80, priceCents: 199, currency: 'usd' },
  { id: 'vip_month', vipDays: 30, priceCents: 499, currency: 'usd' },
  { id: 'season_pass', seasonPass: true, priceCents: 999, currency: 'usd', available: false, availabilityNote: 'Награды сезона готовятся' },
];
const account = { id: 'account_123' };
const request = () => new Request(`${origin}/api/shop/checkout`, { method: 'POST' });

test('payments are disabled unless every provider setting and valid origin exists', async () => {
  assert.deepEqual(paymentStatus({}), { enabled: false });
  assert.equal(paymentStatus(env).enabled, true);
  for (const missing of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'APP_ORIGIN']) {
    const incomplete = { ...env, [missing]: '' };
    assert.equal(paymentStatus(incomplete).enabled, false);
    await assert.rejects(() => createCheckout(request(), incomplete, account, { sku: 'crystals_80' }, catalog), error => error.status === 503);
  }
  assert.equal(paymentStatus({ ...env, APP_ORIGIN: 'http://public.example' }).enabled, false);
  assert.equal(paymentStatus({ ...env, APP_ORIGIN: 'https://attacker@example.com' }).enabled, false);
});

test('checkout uses only server catalog price, fixed quantity and authenticated account metadata', async () => {
  let calls = 0;
  const fakeEnv = { ...env, STRIPE_FETCH: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, `Bearer ${env.STRIPE_SECRET_KEY}`);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('metadata[accountId]'), account.id);
    assert.equal(form.get('metadata[sku]'), 'crystals_80');
    assert.equal(form.get('line_items[0][quantity]'), '1');
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '199');
    assert.equal(form.get('line_items[0][price_data][currency]'), 'usd');
    assert.equal(form.get('success_url'), `${origin}/?checkout=success`);
    assert.equal(form.get('cancel_url'), `${origin}/?checkout=cancelled`);
    return new Response(JSON.stringify({ id: 'cs_test_checkout123', url: 'https://checkout.stripe.com/c/pay/cs_test_checkout123' }));
  } };
  const response = await createCheckout(request(), fakeEnv, account, { sku: 'crystals_80', priceCents: 1, quantity: 1000, accountId: 'attacker' }, catalog);
  assert.equal(response.sessionId, 'cs_test_checkout123');
  assert.equal(calls, 1);
  await assert.rejects(() => createCheckout(request(), fakeEnv, account, { sku: 'give_everything' }, catalog), error => error.status === 400);
  assert.equal(calls, 1);
});

test('VIP creates monthly subscription metadata; unfinished season rewards cannot be sold', async () => {
  const store = new MemoryStore();
  await store.atomic({ puts: [{ key: `player:${account.id}`, value: { id: account.id } }] });
  const modes = [];
  const fakeEnv = { ...env, STRIPE_FETCH: async (_url, options) => {
    const form = new URLSearchParams(options.body);
    modes.push([form.get('mode'), form.get('line_items[0][price_data][unit_amount]'), form.get('line_items[0][price_data][recurring][interval]'), form.get('subscription_data[metadata][accountId]'), form.get('subscription_data[metadata][sku]')]);
    return new Response(JSON.stringify({ id: 'cs_test_checkout', url: 'https://checkout.stripe.com/c/pay/cs_test_checkout' }));
  } };
  await createCheckout(request(), fakeEnv, account, { sku: 'vip_month' }, catalog, { store });
  await assert.rejects(() => createCheckout(request(), fakeEnv, account, { sku: 'season_pass' }, catalog), error => error.status === 409 && /Награды/.test(error.message));
  assert.deepEqual(modes, [['subscription', '499', 'month', account.id, 'vip_month']], 'unavailable pass makes no provider request');
});

test('provider failure is sanitized and arbitrary checkout redirects are rejected', async () => {
  await assert.rejects(() => createCheckout(request(), { ...env, STRIPE_FETCH: async () => new Response('secret-provider-error', { status: 400 }) }, account, { sku: 'crystals_80' }, catalog), error => error.status === 502 && !error.message.includes('secret-provider'));
  await assert.rejects(() => createCheckout(request(), { ...env, STRIPE_FETCH: async () => new Response(JSON.stringify({ id: 'cs_test_fake', url: 'https://attacker.example/pay' })) }, account, { sku: 'crystals_80' }, catalog), error => error.status === 502);
});

function event(overrides = {}) {
  return { id: 'evt_payment123', object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_paid123', object: 'checkout.session', livemode: false, mode: 'payment', payment_status: 'paid', amount_total: 199, currency: 'usd', client_reference_id: account.id, metadata: { accountId: account.id, sku: 'crystals_80' } } }, ...overrides };
}
async function signedRequest(value, { timestamp = Math.floor(Date.now() / 1000), signingSecret = env.STRIPE_WEBHOOK_SECRET, extraSignature, bodyOverride } = {}) {
  const body = JSON.stringify(value);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return new Request(`${origin}/api/payments/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},${extraSignature ? `v1=${extraSignature},` : ''}v1=${hash}` }, body: bodyOverride ?? body });
}

test('Stripe webhook verifies raw signed bytes and accepts rotated signature candidates', async () => {
  const value = event();
  const receipt = await verifyWebhook(await signedRequest(value), env);
  assert.deepEqual(receipt, { eventId: 'stripe:checkout:cs_test_paid123', accountId: account.id, sku: 'crystals_80' });
  assert.deepEqual(await verifyWebhook(await signedRequest(value, { extraSignature: '0'.repeat(64) }), env), receipt);
  assert.deepEqual(value, event(), 'verification must not mutate the provider event');
});

test('Stripe rejects tampering, wrong secret, expired/future signatures and malformed headers', async () => {
  const value = event();
  await assert.rejects(() => signedRequest(value, { bodyOverride: JSON.stringify({ ...value, id: 'evt_tampered' }) }).then(req => verifyWebhook(req, env)), error => error.status === 400);
  await assert.rejects(() => signedRequest(value, { signingSecret: 'whsec_attacker' }).then(req => verifyWebhook(req, env)), error => error.status === 400);
  for (const offset of [-301, 301]) await assert.rejects(() => signedRequest(value, { timestamp: Math.floor(Date.now() / 1000) + offset }).then(req => verifyWebhook(req, env)), error => error.status === 400);
  const malformed = new Request(`${origin}/api/payments/webhook`, { method: 'POST', headers: { 'stripe-signature': 't=invalid,v1=invalid' }, body: '{}' });
  await assert.rejects(() => verifyWebhook(malformed, env), error => error.status === 400);
});

test('Stripe rejects wrong live mode and missing/mismatched recipient metadata', async () => {
  await assert.rejects(() => signedRequest(event({ livemode: true })).then(req => verifyWebhook(req, env)), error => error.status === 400);
  for (const metadata of [{ sku: 'crystals_80' }, { accountId: account.id }, { accountId: 'other_account', sku: 'crystals_80' }, { accountId: account.id, sku: '../crystals' }]) {
    const value = event(); value.data.object.metadata = metadata;
    await assert.rejects(() => signedRequest(value).then(req => verifyWebhook(req, env)), error => error.status === 400);
  }
});

test('only paid checkout completion grants a receipt; oversized payloads are rejected', async () => {
  const unpaid = event(); unpaid.data.object.payment_status = 'unpaid';
  assert.equal(await verifyWebhook(await signedRequest(unpaid), env), null);
  assert.equal(await verifyWebhook(await signedRequest(event({ type: 'checkout.session.expired' })), env), null);
  const huge = event({ padding: 'x'.repeat(128 * 1024) });
  await assert.rejects(() => signedRequest(huge).then(req => verifyWebhook(req, env)), error => error.status === 413);
});

function invoiceEvent(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return event({ id: 'evt_invoice123', type: 'invoice.paid', data: { object: {
    id: 'in_monthly123', object: 'invoice', livemode: false, status: 'paid', amount_paid: 499, currency: 'usd', customer: 'cus_vip123',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_vip123', metadata: { accountId: account.id, sku: 'vip_month' } } },
    lines: { data: [{ id: 'il_vip123', amount: 499, currency: 'usd', quantity: 1, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_vip123', proration: false } }, period: { start: now, end: now + 31 * 86400 } }], has_more: false }, ...overrides,
  } } });
}
test('VIP checkout never double-grants; invoice pays the actual calendar service period', async () => {
  const checkout = event();
  Object.assign(checkout.data.object, { mode: 'subscription', amount_total: 499, metadata: { accountId: account.id, sku: 'vip_month' } });
  assert.equal(await verifyWebhook(await signedRequest(checkout), env), null);
  const invoice = invoiceEvent();
  const receipt = await verifyWebhook(await signedRequest(invoice), env);
  assert.deepEqual(receipt, { eventId: 'stripe:invoice:in_monthly123', accountId: account.id, sku: 'vip_month', periodEnd: invoice.data.object.lines.data[0].period.end * 1000, stripeCustomerId: 'cus_vip123', stripeSubscriptionId: 'sub_vip123' });
  const anotherEvent = structuredClone(invoice); anotherEvent.id = 'evt_anotherDelivery';
  assert.deepEqual(await verifyWebhook(await signedRequest(anotherEvent), env), receipt, 'distinct event IDs for the same invoice must have one logical receipt');
  const nextInvoice = invoiceEvent({ id: 'in_monthlyRenewal' });
  assert.equal((await verifyWebhook(await signedRequest(nextInvoice), env)).eventId, 'stripe:invoice:in_monthlyRenewal');
});

test('VIP invoice validates amount, currency, product, subscription and service period', async () => {
  for (const update of [{ amount_paid: 1 }, { currency: 'eur' }, { parent: { subscription_details: { subscription: 'sub_vip123', metadata: { accountId: account.id, sku: 'crystals_80' } } } }]) {
    await assert.rejects(() => signedRequest(invoiceEvent(update)).then(req => verifyWebhook(req, env)), error => error.status === 400);
  }
  const wrongLine = invoiceEvent(); wrongLine.data.object.lines.data[0].parent.subscription_item_details.subscription = 'sub_other';
  await assert.rejects(() => signedRequest(wrongLine).then(req => verifyWebhook(req, env)), error => error.status === 400);
  const wrongPeriod = invoiceEvent(); wrongPeriod.data.object.lines.data[0].period.end += 90 * 86400;
  await assert.rejects(() => signedRequest(wrongPeriod).then(req => verifyWebhook(req, env)), error => error.status === 400);
  const unknownSku = event(); unknownSku.data.object.metadata.sku = 'free_infinite_crystals';
  await assert.rejects(() => signedRequest(unknownSku).then(req => verifyWebhook(req, env)), error => error.status === 400);
  const alteredPrice = event(); alteredPrice.data.object.amount_total = 1;
  await assert.rejects(() => signedRequest(alteredPrice).then(req => verifyWebhook(req, env)), error => error.status === 400);
});

test('legacy invoice retrieves subscription through mocked Stripe API when snapshot metadata is absent', async () => {
  const value = invoiceEvent();
  const invoice = value.data.object;
  delete invoice.parent;
  invoice.subscription = 'sub_vip123';
  delete invoice.lines.data[0].parent;
  invoice.lines.data[0].subscription = 'sub_vip123';
  let calls = 0;
  const fakeEnv = { ...env, STRIPE_FETCH: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.stripe.com/v1/subscriptions/sub_vip123');
    assert.equal(options.headers.authorization, `Bearer ${env.STRIPE_SECRET_KEY}`);
    return new Response(JSON.stringify({ id: 'sub_vip123', object: 'subscription', livemode: false, status: 'canceled', metadata: { accountId: account.id, sku: 'vip_month' } }));
  } };
  const receipt = await verifyWebhook(await signedRequest(value), fakeEnv);
  assert.equal(receipt.sku, 'vip_month');
  assert.equal(calls, 1, 'paid period remains valid even if recurring subscription was canceled afterwards');
});

test('billing portal uses only server saved customer and returns a verified Stripe URL', async () => {
  const player = { id: account.id, stripeCustomerId: 'cus_serverOnly123', stripeSubscriptionId: 'sub_serverOnly123' };
  let calls = 0;
  const fakeEnv = { ...env, STRIPE_FETCH: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.stripe.com/v1/billing_portal/sessions');
    assert.equal(options.headers.authorization, `Bearer ${env.STRIPE_SECRET_KEY}`);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('customer'), player.stripeCustomerId);
    assert.equal(form.get('return_url'), `${origin}/?billing=returned`);
    return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/test_portal' }));
  } };
  assert.deepEqual(await createPortal(request(), fakeEnv, account, player), { url: 'https://billing.stripe.com/p/session/test_portal' });
  await assert.rejects(() => createPortal(request(), fakeEnv, account, { ...player, id: 'other_account' }), error => error.status === 403);
  await assert.rejects(() => createPortal(request(), fakeEnv, account, { id: account.id }), error => error.status === 409);
  assert.equal(calls, 1);
  await assert.rejects(() => createPortal(request(), { ...env, STRIPE_FETCH: async () => new Response(JSON.stringify({ url: 'https://evil.example' })) }, account, player), error => error.status === 502);
});

test('subscription cancellation uses server saved subscription, stops renewal and preserves paid time', async () => {
  const player = { id: account.id, stripeCustomerId: 'cus_serverOnly123', stripeSubscriptionId: 'sub_serverOnly123', vipUntil: Date.now() + 86400000 };
  const original = structuredClone(player);
  let calls = 0;
  const fakeEnv = { ...env, STRIPE_FETCH: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.stripe.com/v1/subscriptions/sub_serverOnly123');
    assert.equal(options.method, 'POST');
    assert.equal(new URLSearchParams(options.body).get('cancel_at_period_end'), 'true');
    return new Response(JSON.stringify({ id: player.stripeSubscriptionId, object: 'subscription', customer: player.stripeCustomerId, livemode: false, cancel_at_period_end: true }));
  } };
  assert.deepEqual(await cancelSubscription(request(), fakeEnv, account, player), { cancelAtPeriodEnd: true, paidUntil: player.vipUntil });
  assert.deepEqual(player, original, 'canceling renewal must not revoke the paid period');
  await assert.rejects(() => cancelSubscription(request(), fakeEnv, account, { ...player, id: 'other_account' }), error => error.status === 403);
  assert.equal(calls, 1);
});

test('concurrent VIP checkout reserves one provider session and reuses its URL', async () => {
  const store = new MemoryStore();
  await store.atomic({ puts: [{ key: `player:${account.id}`, value: { id: account.id } }] });
  let calls = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const keys = [];
  const fakeEnv = { ...env, STRIPE_FETCH: async (_url, options) => {
    calls++; keys.push(options.headers['Idempotency-Key']);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('mode'), 'subscription');
    assert.ok(Number(form.get('expires_at')) >= Math.floor(Date.now() / 1000) + 1800);
    await blocked;
    return new Response(JSON.stringify({ id: 'cs_test_singleSubscription', url: 'https://checkout.stripe.com/c/pay/cs_test_singleSubscription' }));
  } };
  const first = createCheckout(request(), fakeEnv, account, { sku: 'vip_month' }, catalog, { store });
  // Let the first reserve and enter the mock provider, without using a timer.
  while (calls === 0) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => createCheckout(request(), fakeEnv, account, { sku: 'vip_month' }, catalog, { store }), error => error.status === 409);
  release();
  const result = await first;
  assert.deepEqual(await createCheckout(request(), fakeEnv, account, { sku: 'vip_month' }, catalog, { store }), result);
  assert.equal(calls, 1);
  assert.match(keys[0], /^pd:account_123:vip_month:/);
  await store.atomic({ puts: [{ key: `player:${account.id}`, value: { id: account.id, stripeSubscriptionId: 'sub_paid', stripeCustomerId: 'cus_paid', vipUntil: Date.now() + 86400000 } }] });
  await assert.rejects(() => createCheckout(request(), fakeEnv, account, { sku: 'vip_month' }, catalog, { store }), error => error.status === 409);
  assert.equal(calls, 1, 'active VIP cannot create a second subscription');
});

test('VIP checkout recovers unknown provider outcome with stable idempotency key and expires old reservations', async () => {
  const store = new MemoryStore();
  await store.atomic({ puts: [{ key: `player:${account.id}`, value: { id: account.id } }] });
  const keys = [];
  const fakeEnv = { ...env, STRIPE_FETCH: async (_url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (keys.length === 1) throw new Error('simulated unknown network outcome');
    return new Response(JSON.stringify({ id: 'cs_test_recovered', url: 'https://checkout.stripe.com/c/pay/cs_test_recovered' }));
  } };
  await assert.rejects(() => createCheckout(request(), fakeEnv, account, { sku: 'vip_month' }, catalog, { store }), error => error.status === 502);
  const key = `checkout:${account.id}:vip_month`, pending = await store.get(key);
  await store.atomic({ puts: [{ key, value: { ...pending.value, leaseUntil: Date.now() - 1 } }] });
  await createCheckout(request(), fakeEnv, account, { sku: 'vip_month' }, catalog, { store });
  assert.equal(keys[0], keys[1], 'a retry resumes the same provider operation');
  const ready = await store.get(key);
  await store.atomic({ puts: [{ key, value: { ...ready.value, expiresAt: Date.now() - 1 } }] });
  await createCheckout(request(), fakeEnv, account, { sku: 'vip_month' }, catalog, { store });
  assert.notEqual(keys[2], keys[1], 'an expired checkout receives a fresh reservation');
});
