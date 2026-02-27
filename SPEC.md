# Checkout Service — Specification

## Overview

A serverless checkout service built on AWS Lambda + DynamoDB that:
- Calculates the final price server-side (never trusts client-provided totals)
- Prevents duplicate orders using idempotency via `cartId`
- Behaves consistently on retried requests
- Returns clear, structured error responses

---

## Checkout Flow

```
Client → POST /checkout
          │
          ▼
    1. Validate request (cartId, customerId, items)
          │ invalid → 400 VALIDATION_ERROR
          ▼
    2. Recalculate total price server-side
          ▼
    3. Check if order with this cartId already exists (DynamoDB)
          │ exists → return existing order (200)
          ▼
    4. Create order record in DynamoDB
          ▼
    5. Capture payment (mocked)
          ▼
    6. Return order response (200)
```

---

## API

### Endpoint

```
POST /checkout
Content-Type: application/json
```

### Request Body

```json
{
  "cartId": "string, required, UUID",
  "customerId": "string, required",
  "items": [
    {
      "productId": "string, required",
      "name": "string, required",
      "unitPrice": "number, required, integer cents, > 0",
      "quantity": "number, required, integer, >= 1"
    }
  ]
}
```

> `unitPrice` is provided by the client per item. The server uses it to recalculate
> the total — the client cannot manipulate the final amount.

### Response — Success `200`

```json
{
  "orderId": "string (UUID)",
  "cartId": "string",
  "customerId": "string",
  "items": [
    {
      "productId": "string",
      "name": "string",
      "unitPrice": 2000,
      "quantity": 2,
      "lineTotal": 4000
    }
  ],
  "subtotal": 5500,
  "tax": 440,
  "total": 5940,
  "status": "CONFIRMED",
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

> All monetary values are in **USD cents** (integers) to avoid floating point issues.

### Response — Idempotent repeat request `200`

Same response as above. No new order is created.

### Response — Validation Error `400`

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Cart is empty"
}
```

### Response — Server Error `500`

```json
{
  "error": "INTERNAL_ERROR",
  "message": "An unexpected error occurred"
}
```

---

## Retry Behavior

The API is designed to be **safe to retry at any time**:

- If a request fails before the order is created → retrying will create the order normally
- If a request fails after the order is created → retrying will return the existing order (idempotency kicks in)
- The client always gets the same response for the same `cartId` regardless of how many times it retries
- No side effects (duplicate orders, double charges) will occur from retries

This means the client can safely retry on network timeouts or 5xx errors without any special logic.

---

## Pricing Rules

### Design Decision

The server always recalculates the total from `unitPrice` and `quantity` provided in the request. The client never sends a pre-calculated total — this prevents price manipulation and ensures consistency. The `unitPrice` per item is trusted as the catalog price input; the server owns all arithmetic.

All monetary values are stored and calculated in **USD cents** (integers) to avoid floating point rounding errors (e.g. `$19.99` is stored as `1999`).

### Step 1 — Line total

```
lineTotal = unitPrice × quantity
```

### Step 2 — Subtotal

```
subtotal = sum of all lineTotals
```

### Step 3 — Tax

```
tax = floor(subtotal × 0.08)
```

### Step 4 — Total

```
total = subtotal + tax
```

### Example

| Item    | unitPrice | qty | lineTotal |
|---------|-----------|-----|-----------|
| T-Shirt | 2000      | 2   | 4000      |
| Mug     | 1500      | 1   | 1500      |

- `subtotal` = 5500
- `tax` = floor(5500 × 0.08) = 440
- `total` = 5500 + 440 = **5940**

---

## DynamoDB Table: `Orders`

| Attribute    | Type   | Notes                       |
|--------------|--------|-----------------------------|
| `cartId`     | String | **Partition Key**           |
| `orderId`    | String | UUID, generated server-side |
| `customerId` | String |                             |
| `items`      | List   | With computed lineTotals    |
| `subtotal`   | Number | cents                       |
| `tax`        | Number | cents                       |
| `total`      | Number | cents                       |
| `status`     | String | `CONFIRMED`                 |
| `createdAt`  | String | ISO timestamp               |

---

## Idempotency

- **Key**: `cartId`
- On order creation use DynamoDB `ConditionExpression: attribute_not_exists(cartId)`
- If the condition fails (item already exists) → fetch and return the existing order
- Guarantees exactly-once order creation even under concurrent retries
- A repeated request with the same `cartId` but different items still returns the **original** order — idempotency wins, no update

---

## Acceptance Criteria

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 1 | `items` is an empty array | 400, `VALIDATION_ERROR`, "Cart is empty" |
| 2 | `cartId` is missing | 400, `VALIDATION_ERROR` |
| 3 | `customerId` is missing | 400, `VALIDATION_ERROR` |
| 4 | `unitPrice` is 0 or negative | 400, `VALIDATION_ERROR` |
| 5 | `quantity` is less than 1 | 400, `VALIDATION_ERROR` |
| 6 | Valid cart, first request | 200, order created, `total = subtotal + floor(subtotal × 0.08)` |
| 7 | Same `cartId` sent twice | 200, same `orderId` returned, no duplicate created in DB |
| 8 | Payment is captured after order creation | Order exists in DB before payment mock is called |
| 9 | Monetary values calculated in cents | No floating point in any field |

---

## Edge Cases

- Single item in cart → valid, should work fine
- `unitPrice` must be a positive integer (cents), not a float
- `cartId` repeated with different items → return original order unchanged
- Very large quantities or prices → no overflow expected within JS safe integer range

---

## Error Scenarios

| Scenario | HTTP | `error` field |
|----------|------|---------------|
| Empty cart | 400 | `VALIDATION_ERROR` |
| Missing `cartId` | 400 | `VALIDATION_ERROR` |
| Missing `customerId` | 400 | `VALIDATION_ERROR` |
| `unitPrice` ≤ 0 | 400 | `VALIDATION_ERROR` |
| `quantity` < 1 | 400 | `VALIDATION_ERROR` |
| DynamoDB unavailable | 500 | `INTERNAL_ERROR` |
| Payment mock throws | 500 | `INTERNAL_ERROR` |

---

## Security Rules

- No secrets or credentials in source code
- Environment variables: `ORDERS_TABLE`, `AWS_REGION`
- `unitPrice` from the client is used as calculation input — server owns the final total
- `cartId` must be a valid UUID (validated on input)
- Internal error details are logged server-side but never exposed to the client

---

## Logging

All logs are structured JSON:

```json
{
  "level": "info | warn | error",
  "action": "checkout.start | checkout.duplicate | checkout.complete | checkout.error",
  "cartId": "...",
  "orderId": "... (when available)",
  "durationMs": 42
}
```
