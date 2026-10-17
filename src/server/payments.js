// Stripe Checkout creates payment intent; only a signed provider webhook grants goods.
import { CATALOG } from '../shared/catalog.js';
const encoder = new TextEncoder();
const MAX_WEBHOOK_BYTES = 128 * 1024;
const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function configuredOrigin(env) {
  try {
    const url = new URL(env.APP_ORIGIN);
    const local = (env.LOCAL_DEV === true || env.LOCAL_DEV === 'true') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) return null;
    return url.origin;
  } catch { return null; }
}
export function paymentStatus(env) {
  return { enabled: !!(typeof env.STRIPE_SECRET_KEY === 'string' && /^[sr]k_(test|live)_[A-Za-z0-9_]+$/.test(env.STRIPE_SECRET_KEY) && typeof env.STRIPE_WEBHOOK_SECRET === 'string' && /^whsec_[A-Za-z0-9_]+$/.test(env.STRIPE_WEBHOOK_SECRET) && configuredOrigin(env)) };
}
function requireConfigured(env) {
  if (!paymentStatus(env).enabled) fail(503, 'Платежи ещё не подключены');
}
function validAccountId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function validSku(value) { return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value); }
function stripeId(value, kind) { return typeof value === 'string' && new RegExp(`^${kind}_[A-Za-z0-9_]{1,180}$`).test(value); }
function owningPlayer(request, env, account, player) {
  requireConfigured(env);
  if (new URL(request.url).origin !== configuredOrigin(env)) fail(403, 'Неверный адрес приложения');
  if (!account || !validAccountId(account.id)) fail(401, 'Нужно войти в аккаунт');
  if (!player || player.id !== account.id) fail(403, 'Подписка другого аккаунта недоступна');
  if (!stripeId(player.stripeCustomerId, 'cus')) fail(409, 'У аккаунта пока нет оплаченной подписки');
}
function equalHex(expected, received) {
  let mismatch = expected.length ^ received.length;
  for (let i = 0; i < 64; i++) mismatch |= (expected.charCodeAt(i) || 0) ^ (received.charCodeAt(i) || 0);
  return mismatch === 0;
}

export async function createCheckout(request, env, account, { sku } = {}, catalog, { store } = {}) {
  requireConfigured(env);
  const origin = configuredOrigin(env);
  if (new URL(request.url).origin !== origin) fail(403, 'Неверный адрес приложения');
  if (!account || !validAccountId(account.id)) fail(401, 'Нужно войти в аккаунт');
  if (!validSku(sku) || !Array.isArray(catalog)) fail(400, 'Неизвестный товар');
  const product = catalog.find(item => item.id === sku);
  if (!product) fail(400, 'Неизвестный товар');
  if (product.available === false) fail(409, product.availabilityNote || 'Товар пока недоступен');
  // These are server catalog fields; none can be overridden by request JSON.
  if (!Number.isSafeInteger(product.priceCents) || product.priceCents < 1 || product.priceCents > 10000000 || !/^[a-z]{3}$/.test(product.currency)) fail(503, 'Товар временно недоступен');
  const reservation = product.vipDays ? await reserveVipCheckout(env, account, product, store) : null;
  if (reservation?.checkout) return reservation.checkout;
  const title = product.crystals ? `${product.crystals} кристаллов · Pixel Dominion` : product.vipDays ? `VIP на ${product.vipDays} дней · Pixel Dominion` : 'Боевой пропуск · Pixel Dominion';
  const body = new URLSearchParams({
    mode: product.vipDays ? 'subscription' : 'payment',
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancelled`,
    client_reference_id: account.id,
    'metadata[accountId]': account.id,
    'metadata[sku]': product.id,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': product.currency,
    'line_items[0][price_data][unit_amount]': String(product.priceCents),
    'line_items[0][price_data][product_data][name]': title,
  });
  if (product.vipDays) {
    body.set('line_items[0][price_data][recurring][interval]', 'month');
    body.set('subscription_data[metadata][accountId]', account.id);
    body.set('subscription_data[metadata][sku]', product.id);
    body.set('expires_at', String(Math.floor(reservation.value.expiresAt / 1000)));
    if (reservation.customerId) body.set('customer', reservation.customerId);
  }
  const fetcher = typeof env.STRIPE_FETCH === 'function' ? env.STRIPE_FETCH : fetch;
  let response;
  try {
    response = await fetcher(STRIPE_API, { method: 'POST', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2025-06-30.basil', 'Idempotency-Key': reservation ? `pd:${account.id}:${product.id}:${reservation.value.reservationId}` : crypto.randomUUID() }, body, signal: AbortSignal.timeout(15000) });
  } catch { fail(502, 'Платёжный сервис временно недоступен'); }
  if (!response.ok) fail(502, 'Не удалось открыть платёжную страницу');
  let session;
  try { session = await response.json(); } catch { fail(502, 'Некорректный ответ платёжного сервиса'); }
  let checkoutUrl;
  try { checkoutUrl = new URL(session.url); } catch { fail(502, 'Платёжный сервис не вернул страницу оплаты'); }
  const mode = /^(?:sk|rk)_live_/.test(env.STRIPE_SECRET_KEY) ? 'live' : 'test';
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com' || checkoutUrl.username || checkoutUrl.password || typeof session.id !== 'string' || !new RegExp(`^cs_${mode}_[A-Za-z0-9_]{1,180}$`).test(session.id)) fail(502, 'Некорректная платёжная страница');
  const checkout = { url: checkoutUrl.href, sessionId: session.id };
  if (reservation) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const latest = await store.get(reservation.key);
      if (!latest || latest.value.reservationId !== reservation.value.reservationId) fail(409, 'Платёжная сессия изменилась. Повторите запрос');
      if (await store.atomic({ checks: [{ key: reservation.key, version: latest.version }], puts: [{ key: reservation.key, value: { ...latest.value, state: 'ready', checkout } }] })) return checkout;
    }
    fail(409, 'Платёжная сессия сохраняется. Повторите запрос');
  }
  return checkout;
}

async function reserveVipCheckout(env, account, product, store) {
  if (!store) fail(503, 'Для подписок требуется постоянное хранилище');
  const playerKey = `player:${account.id}`;
  const playerRecord = await store.get(playerKey);
  const player = playerRecord?.value;
  if (!player || player.id !== account.id) fail(409, 'Перед подпиской необходимо основать базу');
  const now = Date.now();
  if (player.stripeSubscriptionId) {
    if (!stripeId(player.stripeSubscriptionId, 'sub')) fail(409, 'Подписка требует проверки');
    if (player.vipUntil > now) fail(409, 'VIP уже действует. Управляйте текущей подпиской');
    // An expired entitlement can still have an active or past-due subscription.
    const fetcher = typeof env.STRIPE_FETCH === 'function' ? env.STRIPE_FETCH : fetch;
    let response, subscription;
    try { response = await fetcher(`https://api.stripe.com/v1/subscriptions/${player.stripeSubscriptionId}`, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2025-06-30.basil' }, signal: AbortSignal.timeout(15000) }); }
    catch { fail(502, 'Не удалось проверить текущую подписку'); }
    if (!response.ok) fail(502, 'Не удалось проверить текущую подписку');
    try { subscription = await response.json(); } catch { fail(502, 'Некорректный ответ подписки'); }
    const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (subscription.id !== player.stripeSubscriptionId || subscription.object !== 'subscription' || subscription.livemode !== /^(?:sk|rk)_live_/.test(env.STRIPE_SECRET_KEY) || customer !== player.stripeCustomerId) fail(400, 'Подписка не прошла проверку');
    if (!['canceled', 'incomplete_expired'].includes(subscription.status)) fail(409, 'У аккаунта уже есть подписка. Откройте управление');
  }
  const key = `checkout:${account.id}:${product.id}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await store.get(key);
    if (previous?.value.expiresAt > now) {
      if (previous.value.state === 'ready' && previous.value.checkout) return { checkout: previous.value.checkout };
      if (previous.value.leaseUntil > now) fail(409, 'Платёжная страница создаётся. Повторите через несколько секунд');
    }
    const base = previous?.value.expiresAt > now ? previous.value : { reservationId: crypto.randomUUID(), expiresAt: now + 31 * 60000, createdAt: now };
    const value = { ...base, state: 'creating', leaseUntil: now + 30000 };
    if (await store.atomic({ checks: [{ key: playerKey, version: playerRecord.version }, { key, version: previous?.version ?? null }], puts: [{ key, value }] })) return { key, value, customerId: stripeId(player.stripeCustomerId, 'cus') ? player.stripeCustomerId : null };
  }
  fail(409, 'Платёжная страница создаётся. Повторите запрос');
}

async function rawBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_WEBHOOK_BYTES) fail(413, 'Webhook слишком большой');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Пустой webhook');
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEBHOOK_BYTES) { await reader.cancel(); fail(413, 'Webhook слишком большой'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

export async function verifyWebhook(request, env) {
  requireConfigured(env);
  if (request.method !== 'POST') fail(405, 'Ожидается POST webhook');
  const header = request.headers.get('stripe-signature');
  if (!header || header.length > 4096) fail(400, 'Нет подписи Stripe');
  const timestamps = [], signatures = [];
  for (const field of header.split(',')) {
    const separator = field.indexOf('=');
    const key = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (key === 't') timestamps.push(value);
    if (key === 'v1' && /^[a-fA-F0-9]{64}$/.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamps.length !== 1 || !/^\d{10}$/.test(timestamps[0]) || !signatures.length || signatures.length > 16) fail(400, 'Некорректная подпись Stripe');
  const timestamp = Number(timestamps[0]);
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) fail(400, 'Подпись Stripe устарела');
  const bytes = await rawBody(request);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + bytes.byteLength);
  signed.set(prefix); signed.set(bytes, prefix.byteLength);
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  const expected = [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
  // Evaluate every candidate, including during Stripe signing-secret rotation.
  let verified = false;
  for (const received of signatures) verified = equalHex(expected, received) || verified;
  if (!verified) fail(400, 'Подпись Stripe не прошла проверку');
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(400, 'Некорректный JSON webhook'); }
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail(400, 'Некорректный webhook Stripe');
  const live = /^(?:sk|rk)_live_/.test(env.STRIPE_SECRET_KEY);
  if (event.livemode !== live) fail(400, 'Режим платежа не совпадает с сервером');
  if (event.type === 'invoice.paid') return verifyInvoice(event, env, live);
  if (event.type !== 'checkout.session.completed') return null;
  const session = event.data?.object;
  if (!session || session.object !== 'checkout.session' || session.livemode !== live) fail(400, 'Некорректная сессия Stripe');
  if (session.payment_status !== 'paid') return null;
  if (typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,190}$/.test(event.id) || typeof session.id !== 'string' || !new RegExp(`^cs_${live ? 'live' : 'test'}_[A-Za-z0-9_]{1,180}$`).test(session.id)) fail(400, 'Некорректный ID платежа');
  const { accountId, sku } = session.metadata ?? {};
  if (!validAccountId(accountId) || !validSku(sku) || (session.client_reference_id && session.client_reference_id !== accountId)) fail(400, 'Некорректные данные получателя платежа');
  const product = CATALOG.find(item => item.id === sku);
  if (!product || session.amount_total !== product.priceCents || session.currency !== product.currency) fail(400, 'Товар или сумма платежа не совпадают с каталогом');
  // The initial VIP entitlement is issued only by invoice.paid, including renewals.
  if (product.vipDays) {
    if (session.mode !== 'subscription') fail(400, 'Неверный режим VIP-платежа');
    return null;
  }
  if (session.mode !== 'payment') fail(400, 'Неверный режим платежа');
  return { eventId: `stripe:checkout:${session.id}`, accountId, sku };
}

async function verifyInvoice(event, env, live) {
  const invoice = event.data?.object;
  if (!invoice || invoice.object !== 'invoice' || invoice.livemode !== live || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,190}$/.test(event.id) || typeof invoice.id !== 'string' || !/^in_[A-Za-z0-9_]{1,180}$/.test(invoice.id)) fail(400, 'Некорректный счёт подписки');
  if (invoice.status !== 'paid') return null;
  const details = invoice.parent?.subscription_details ?? invoice.subscription_details;
  const subscriptionValue = details?.subscription ?? invoice.subscription;
  const subscriptionId = typeof subscriptionValue === 'string' ? subscriptionValue : subscriptionValue?.id;
  if (!subscriptionId) return null; // A non-subscription invoice does not grant game goods.
  if (!/^sub_[A-Za-z0-9_]{1,180}$/.test(subscriptionId)) fail(400, 'Некорректная подписка');
  let metadata = details?.metadata;
  if (!metadata?.accountId || !metadata?.sku) {
    const fetcher = typeof env.STRIPE_FETCH === 'function' ? env.STRIPE_FETCH : fetch;
    let response;
    try { response = await fetcher(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2025-06-30.basil' }, signal: AbortSignal.timeout(15000) }); }
    catch { fail(502, 'Не удалось проверить подписку'); }
    if (!response.ok) fail(502, 'Не удалось проверить подписку');
    let subscription;
    try { subscription = await response.json(); } catch { fail(502, 'Некорректный ответ подписки'); }
    if (subscription.object !== 'subscription' || subscription.id !== subscriptionId || subscription.livemode !== live) fail(400, 'Подписка не прошла проверку');
    metadata = subscription.metadata;
  }
  const { accountId, sku } = metadata ?? {};
  const product = CATALOG.find(item => item.id === sku);
  if (!validAccountId(accountId) || !validSku(sku) || !product?.vipDays) fail(400, 'Некорректные данные VIP-подписки');
  if (invoice.amount_paid !== product.priceCents || invoice.currency !== product.currency) fail(400, 'Сумма подписки не совпадает с каталогом');
  // An invoice's own period_end looks backward; its line period is the paid service period.
  const lines = invoice.lines?.data;
  if (!Array.isArray(lines) || lines.length !== 1 || invoice.lines.has_more === true) fail(400, 'Некорректные позиции подписки');
  const line = lines[0];
  const lineSubscription = line.parent?.subscription_item_details?.subscription ?? line.subscription;
  if (lineSubscription !== subscriptionId || line.amount !== product.priceCents || line.currency !== product.currency || (line.quantity !== undefined && line.quantity !== 1) || line.proration === true || line.parent?.subscription_item_details?.proration === true) fail(400, 'Позиция счёта не совпадает с подпиской');
  const start = line.period?.start, end = line.period?.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start || end - start > 32 * 86400 || end - start < 27 * 86400 || end > Number.MAX_SAFE_INTEGER / 1000) fail(400, 'Некорректный оплаченный период подписки');
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!stripeId(customerId, 'cus')) fail(400, 'Нет клиента оплаченной подписки');
  return { eventId: `stripe:invoice:${invoice.id}`, accountId, sku, periodEnd: end * 1000, stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId };
}

export async function createPortal(request, env, account, player) {
  owningPlayer(request, env, account, player);
  const fetcher = typeof env.STRIPE_FETCH === 'function' ? env.STRIPE_FETCH : fetch;
  let response;
  try {
    response = await fetcher('https://api.stripe.com/v1/billing_portal/sessions', { method: 'POST', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2025-06-30.basil' }, body: new URLSearchParams({ customer: player.stripeCustomerId, return_url: `${configuredOrigin(env)}/?billing=returned` }), signal: AbortSignal.timeout(15000) });
  } catch { fail(502, 'Не удалось открыть управление подпиской'); }
  if (!response.ok) fail(502, 'Управление подпиской временно недоступно');
  let portal, url;
  try { portal = await response.json(); url = new URL(portal.url); } catch { fail(502, 'Платёжный сервис не вернул страницу подписки'); }
  if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com' || url.username || url.password) fail(502, 'Некорректная страница управления подпиской');
  return { url: url.href };
}

export async function cancelSubscription(request, env, account, player) {
  owningPlayer(request, env, account, player);
  if (!stripeId(player.stripeSubscriptionId, 'sub')) fail(409, 'У аккаунта нет подписки для отмены');
  const fetcher = typeof env.STRIPE_FETCH === 'function' ? env.STRIPE_FETCH : fetch;
  let response;
  try {
    response = await fetcher(`https://api.stripe.com/v1/subscriptions/${player.stripeSubscriptionId}`, { method: 'POST', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2025-06-30.basil', 'Idempotency-Key': crypto.randomUUID() }, body: new URLSearchParams({ cancel_at_period_end: 'true' }), signal: AbortSignal.timeout(15000) });
  } catch { fail(502, 'Не удалось отменить продление подписки'); }
  if (!response.ok) fail(502, 'Не удалось отменить продление подписки');
  let subscription;
  try { subscription = await response.json(); } catch { fail(502, 'Некорректный ответ платёжного сервиса'); }
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const live = /^(?:sk|rk)_live_/.test(env.STRIPE_SECRET_KEY);
  if (subscription.object !== 'subscription' || subscription.id !== player.stripeSubscriptionId || customerId !== player.stripeCustomerId || subscription.livemode !== live || subscription.cancel_at_period_end !== true) fail(502, 'Отмена подписки не подтверждена');
  // Paid service is retained. Provider stops creating subsequent renewal invoices.
  return { cancelAtPeriodEnd: true, paidUntil: player.vipUntil ?? null };
}
