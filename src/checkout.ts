import { randomUUID } from 'crypto';
import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import type { CheckoutItem, CheckoutRequest, Order } from './types';
import { calculatePricing } from './pricing';
import { getOrderByCartId, createOrder } from './repository';

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  action: string;
  cartId?: string | undefined;
  orderId?: string | undefined;
  durationMs?: number | undefined;
  [key: string]: unknown;
}

function log(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Payment capture (mock)
// ---------------------------------------------------------------------------

async function capturePayment(orderId: string, total: number): Promise<void> {
  log({ level: 'info', action: 'payment.capture', orderId, total });
  // In production: call the real payment provider here.
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function ok(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function validationError(message: string): APIGatewayProxyResult {
  return {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'VALIDATION_ERROR', message }),
  };
}

function internalError(): APIGatewayProxyResult {
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateRequest(body: unknown): { ok: true; value: CheckoutRequest } | { ok: false; message: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }

  const raw = body as Record<string, unknown>;

  if (typeof raw['cartId'] !== 'string' || raw['cartId'] === '') {
    return { ok: false, message: 'Missing or invalid cartId' };
  }
  if (!UUID_RE.test(raw['cartId'])) {
    return { ok: false, message: 'cartId must be a valid UUID' };
  }

  if (typeof raw['customerId'] !== 'string' || raw['customerId'] === '') {
    return { ok: false, message: 'Missing or invalid customerId' };
  }

  if (!Array.isArray(raw['items']) || raw['items'].length === 0) {
    return { ok: false, message: 'Cart is empty' };
  }

  for (const item of raw['items'] as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: 'Each item must be an object' };
    }
    const i = item as Record<string, unknown>;

    if (typeof i['productId'] !== 'string' || i['productId'] === '') {
      return { ok: false, message: 'Each item must have a productId' };
    }
    if (typeof i['name'] !== 'string' || i['name'] === '') {
      return { ok: false, message: 'Each item must have a name' };
    }
    if (!Number.isInteger(i['unitPrice']) || (i['unitPrice'] as number) <= 0) {
      return { ok: false, message: 'unitPrice must be a positive integer (cents)' };
    }
    if (!Number.isInteger(i['quantity']) || (i['quantity'] as number) < 1) {
      return { ok: false, message: 'quantity must be an integer >= 1' };
    }
  }

  return {
    ok: true,
    value: {
      cartId: raw['cartId'] as string,
      customerId: raw['customerId'] as string,
      items: raw['items'] as CheckoutItem[],
    },
  };
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export const handler: APIGatewayProxyHandler = async (event) => {
  const start = Date.now();
  let cartId: string | undefined;

  try {
    // 1. Parse body
    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '');
    } catch {
      return validationError('Invalid JSON body');
    }

    // 2. Validate request
    const validation = validateRequest(body);
    if (!validation.ok) {
      return validationError(validation.message);
    }

    const req = validation.value;
    cartId = req.cartId;

    log({ level: 'info', action: 'checkout.start', cartId });

    // 3. Check idempotency — return early if order already exists
    const existing = await getOrderByCartId(cartId);
    if (existing) {
      log({ level: 'info', action: 'checkout.duplicate', cartId, orderId: existing.orderId, durationMs: Date.now() - start });
      return ok(existing);
    }

    // 4. Recalculate total server-side (never trust client totals)
    const pricing = calculatePricing(req.items);

    const order: Order = {
      orderId: randomUUID(),
      cartId,
      customerId: req.customerId,
      items: pricing.items,
      subtotal: pricing.subtotal,
      tax: pricing.tax,
      total: pricing.total,
      status: 'CONFIRMED',
      createdAt: new Date().toISOString(),
    };

    // 5. Persist order before capturing payment (idempotent write)
    const result = await createOrder(order);
    if (!result.created) {
      // A concurrent request already created this order
      log({ level: 'info', action: 'checkout.duplicate', cartId, orderId: result.order.orderId, durationMs: Date.now() - start });
      return ok(result.order);
    }

    // 6. Capture payment (order is safely persisted first)
    await capturePayment(order.orderId, order.total);

    log({ level: 'info', action: 'checkout.complete', cartId, orderId: order.orderId, durationMs: Date.now() - start });
    return ok(order);

  } catch (err) {
    log({ level: 'error', action: 'checkout.error', cartId, error: String(err), durationMs: Date.now() - start });
    return internalError();
  }
};
