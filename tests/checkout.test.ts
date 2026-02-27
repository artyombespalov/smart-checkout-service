import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { handler } from '../src/checkout';
import * as repository from '../src/repository';
import type { Order } from '../src/types';

jest.mock('../src/repository');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CART_ID = '123e4567-e89b-12d3-a456-426614174000';
const CUSTOMER_ID = 'customer-1';

// subtotal = 2000×2 + 1500×1 = 5500 | tax = floor(5500×0.08) = 440 | total = 5940
const VALID_ITEMS = [
  { productId: 'prod-1', name: 'T-Shirt', unitPrice: 2000, quantity: 2 },
  { productId: 'prod-2', name: 'Mug',     unitPrice: 1500, quantity: 1 },
];

function makeEvent(body: unknown): APIGatewayProxyEvent {
  return { body: JSON.stringify(body) } as unknown as APIGatewayProxyEvent;
}

async function callHandler(body: unknown) {
  const result = await handler(makeEvent(body), {} as Context, () => undefined);
  if (!result) throw new Error('Handler returned undefined');
  return {
    statusCode: result.statusCode,
    body: JSON.parse(result.body) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockedGetOrder = repository.getOrderByCartId as jest.MockedFunction<
  typeof repository.getOrderByCartId
>;
const mockedCreateOrder = repository.createOrder as jest.MockedFunction<
  typeof repository.createOrder
>;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  // Defaults: no existing order; creation succeeds and echoes the order back
  mockedGetOrder.mockResolvedValue(null);
  mockedCreateOrder.mockImplementation(async (order: Order) => ({ created: true, order }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC1: empty cart
// ---------------------------------------------------------------------------

test('AC1: empty items array → 400 VALIDATION_ERROR "Cart is empty"', async () => {
  const res = await callHandler({ cartId: CART_ID, customerId: CUSTOMER_ID, items: [] });

  expect(res.statusCode).toBe(400);
  expect(res.body).toMatchObject({ error: 'VALIDATION_ERROR', message: 'Cart is empty' });
});

// ---------------------------------------------------------------------------
// AC2: missing cartId
// ---------------------------------------------------------------------------

test('AC2: missing cartId → 400 VALIDATION_ERROR', async () => {
  const res = await callHandler({ customerId: CUSTOMER_ID, items: VALID_ITEMS });

  expect(res.statusCode).toBe(400);
  expect(res.body.error).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// AC3: missing customerId
// ---------------------------------------------------------------------------

test('AC3: missing customerId → 400 VALIDATION_ERROR', async () => {
  const res = await callHandler({ cartId: CART_ID, items: VALID_ITEMS });

  expect(res.statusCode).toBe(400);
  expect(res.body.error).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// AC4: unitPrice <= 0
// ---------------------------------------------------------------------------

test('AC4: unitPrice of 0 → 400 VALIDATION_ERROR', async () => {
  const res = await callHandler({
    cartId: CART_ID,
    customerId: CUSTOMER_ID,
    items: [{ productId: 'p1', name: 'Item', unitPrice: 0, quantity: 1 }],
  });

  expect(res.statusCode).toBe(400);
  expect(res.body.error).toBe('VALIDATION_ERROR');
});

test('AC4: negative unitPrice → 400 VALIDATION_ERROR', async () => {
  const res = await callHandler({
    cartId: CART_ID,
    customerId: CUSTOMER_ID,
    items: [{ productId: 'p1', name: 'Item', unitPrice: -100, quantity: 1 }],
  });

  expect(res.statusCode).toBe(400);
  expect(res.body.error).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// AC5: quantity < 1
// ---------------------------------------------------------------------------

test('AC5: quantity of 0 → 400 VALIDATION_ERROR', async () => {
  const res = await callHandler({
    cartId: CART_ID,
    customerId: CUSTOMER_ID,
    items: [{ productId: 'p1', name: 'Item', unitPrice: 1000, quantity: 0 }],
  });

  expect(res.statusCode).toBe(400);
  expect(res.body.error).toBe('VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// AC6: valid cart → 200, correct total calculation
// ---------------------------------------------------------------------------

test('AC6: valid cart → 200, total = subtotal + floor(subtotal × 0.08)', async () => {
  const res = await callHandler({ cartId: CART_ID, customerId: CUSTOMER_ID, items: VALID_ITEMS });

  expect(res.statusCode).toBe(200);
  expect(res.body.subtotal).toBe(5500);
  expect(res.body.tax).toBe(440);    // floor(5500 × 0.08) = 440
  expect(res.body.total).toBe(5940); // 5500 + 440
  expect(res.body.status).toBe('CONFIRMED');
  expect(typeof res.body.orderId).toBe('string');
  expect(typeof res.body.createdAt).toBe('string');
});

// ---------------------------------------------------------------------------
// AC7: same cartId sent twice → same orderId, no duplicate created in DB
// ---------------------------------------------------------------------------

test('AC7: same cartId sent twice → same orderId returned, createOrder called only once', async () => {
  let capturedOrder: Order | undefined;

  mockedCreateOrder.mockImplementation(async (order: Order) => {
    capturedOrder = order;
    return { created: true, order };
  });

  const firstRes = await callHandler({ cartId: CART_ID, customerId: CUSTOMER_ID, items: VALID_ITEMS });

  // Second request: order already exists in DB
  mockedGetOrder.mockResolvedValue(capturedOrder!);

  const secondRes = await callHandler({ cartId: CART_ID, customerId: CUSTOMER_ID, items: VALID_ITEMS });

  expect(firstRes.statusCode).toBe(200);
  expect(secondRes.statusCode).toBe(200);
  expect(secondRes.body.orderId).toBe(firstRes.body.orderId);
  expect(mockedCreateOrder).toHaveBeenCalledTimes(1); // no second write
});

// ---------------------------------------------------------------------------
// AC8: payment captured AFTER order is persisted
// ---------------------------------------------------------------------------

test('AC8: capturePayment is called strictly after createOrder resolves', async () => {
  const callOrder: string[] = [];

  mockedCreateOrder.mockImplementation(async (order: Order) => {
    callOrder.push('createOrder');
    return { created: true, order };
  });

  // Override the console.log spy to track the payment.capture log action
  (console.log as jest.Mock).mockImplementation((msg: unknown) => {
    try {
      const parsed = JSON.parse(String(msg)) as { action?: string };
      if (parsed.action === 'payment.capture') {
        callOrder.push('capturePayment');
      }
    } catch { /* non-JSON lines are ignored */ }
  });

  await callHandler({ cartId: CART_ID, customerId: CUSTOMER_ID, items: VALID_ITEMS });

  expect(callOrder).toEqual(['createOrder', 'capturePayment']);
});

// ---------------------------------------------------------------------------
// AC9: all monetary values are integers (no floating point)
// ---------------------------------------------------------------------------

test('AC9: subtotal, tax, total, and all lineTotals are integers (no floats)', async () => {
  const res = await callHandler({ cartId: CART_ID, customerId: CUSTOMER_ID, items: VALID_ITEMS });

  expect(res.statusCode).toBe(200);

  expect(Number.isInteger(res.body['subtotal'])).toBe(true);
  expect(Number.isInteger(res.body['tax'])).toBe(true);
  expect(Number.isInteger(res.body['total'])).toBe(true);

  const items = res.body['items'] as Array<Record<string, unknown>>;
  for (const item of items) {
    expect(Number.isInteger(item['unitPrice'])).toBe(true);
    expect(Number.isInteger(item['quantity'])).toBe(true);
    expect(Number.isInteger(item['lineTotal'])).toBe(true);
  }
});
