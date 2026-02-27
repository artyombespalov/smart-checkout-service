# Smart Checkout Service

A serverless checkout service built with Node.js, TypeScript, AWS Lambda, API Gateway, and DynamoDB.

## Design

The spec-first approach means `SPEC.md` is the source of truth. The implementation follows it exactly — if behavior needs to change, the spec is updated first.

### Key decisions

**Idempotency via `cartId`** — DynamoDB `ConditionExpression: attribute_not_exists(cartId)` guarantees exactly-once order creation even under concurrent retries. If two requests arrive simultaneously with the same `cartId`, one will win the write and the other will fetch and return the existing order.

**Prices in cents** — all monetary values are stored and calculated as integers (USD cents) to avoid floating point rounding errors.

**Payment after persist** — payment is captured only after the order is durably written to DynamoDB. This means a failed payment does not leave a ghost order, and a retry will find the existing order and skip re-creation.

**Server-side pricing** — the client provides `unitPrice` per item but never a total. The server recalculates everything. This prevents price manipulation.

## Project Structure

```
smart-checkout-service/
├── SPEC.md                  # source of truth — read this first
├── CLAUDE.md                # how Claude was used in development
├── src/
│   ├── types.ts             # TypeScript interfaces
│   ├── pricing.ts           # pure pricing calculation
│   ├── repository.ts        # DynamoDB operations
│   └── checkout.ts          # Lambda handler
└── tests/
    └── checkout.test.ts     # unit tests, one per acceptance criterion
```

## Running Tests

```bash
npm install
npm test
```

All 10 tests should pass. Each test is named after its acceptance criterion (AC1–AC9) from `SPEC.md`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ORDERS_TABLE` | DynamoDB table name for orders |
| `AWS_REGION` | AWS region |

No secrets in code. All configuration via environment variables.

## Known Trade-offs

**Double DynamoDB read in happy path** — `checkout.ts` performs a `GetItem` check before attempting to create the order, resulting in two DynamoDB calls per new order. An optimized version would go straight to `PutCommand` with `attribute_not_exists` and only fall back to a `Get` on conflict. The current approach prioritizes clarity and direct alignment with the spec flow.

**AC8 test coupled to log action name** — the test verifying that payment is captured after order creation works by intercepting `console.log` and parsing the `action: 'payment.capture'` field. If that string is renamed, the test will silently pass without catching the regression. A more robust solution would inject the payment function as a dependency and use a Jest mock directly.
