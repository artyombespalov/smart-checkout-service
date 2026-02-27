# How I Used Claude

I used two Claude products here: claude.ai (chat) for the spec and design decisions, and Claude Code for the actual implementation.

## Writing the spec first

Before touching any code, I used Claude chat to work through `SPEC.md`. The task explicitly said the Markdown file is the main reference and implementation should follow it exactly — so I wanted to get that right first rather than retrofitting docs after the fact.

One decision worth calling out: during spec drafting, Claude suggested adding a promo code / discount system to make the pricing rules more interesting. I pushed back on that. The original task didn't ask for it, and adding unrequested features is a bad habit — it bloats scope, introduces edge cases, and signals you didn't read the requirements carefully. We kept pricing simple: `lineTotal = unitPrice × quantity`, 8% tax, done.

Other things settled in the spec before writing code:
- Prices in cents (integers) to avoid floating point issues
- Payment capture happens strictly after the order is persisted — this is a deliberate ordering, not an accident
- Idempotency key is `cartId` with `attribute_not_exists` condition in DynamoDB

## Implementation with Claude Code

Once `SPEC.md` was solid, I gave Claude Code this prompt:

```
Read SPEC.md carefully — it is the source of truth.

Implement the checkout service based on it:
- src/types.ts — all TypeScript interfaces
- src/pricing.ts — pricing calculation logic
- src/repository.ts — DynamoDB operations (Orders table)
- src/checkout.ts — Lambda handler

Rules:
- All monetary values in USD cents (integers)
- Mock payment capture as a simple async function that logs and returns success
- Structured JSON logging as described in the spec
- No secrets in code, use process.env.ORDERS_TABLE and process.env.AWS_REGION
```

Then a separate prompt for tests:

```
Read SPEC.md — the Acceptance Criteria table is the source of truth for tests.

Write unit tests in tests/checkout.test.ts covering every acceptance criterion:
- AC1: empty cart → 400 VALIDATION_ERROR
- AC2: missing cartId → 400 VALIDATION_ERROR
- AC3: missing customerId → 400 VALIDATION_ERROR
- AC4: unitPrice <= 0 → 400 VALIDATION_ERROR
- AC5: quantity < 1 → 400 VALIDATION_ERROR
- AC6: valid cart → 200, correct total calculation
- AC7: same cartId twice → same orderId, no duplicate
- AC8: payment captured AFTER order persisted
- AC9: all monetary values are integers (no floats)

Mock DynamoDB via jest.mock('./repository').
Use jest + ts-jest.
Name each test after its AC number so it's traceable back to the spec.
```

## What I actually verified

I didn't just run the tests and ship it. A few things I checked manually:

**`pricing.ts`** — read it line by line against the spec. Confirmed `Math.floor` is used for tax (not `Math.round`), all values stay as integers, no floats sneak in.

**`repository.ts`** — confirmed `attribute_not_exists(cartId)` is there, and that the race condition (two simultaneous requests with the same `cartId`) is handled correctly by catching `ConditionalCheckFailedException` and returning the existing order.

**The `ORDERS_TABLE` issue** — Claude Code generated `process.env['ORDERS_TABLE'] ?? ''` which silently falls back to an empty string. That would produce a confusing DynamoDB error at runtime with no indication of what went wrong. I caught this in review and fixed it to throw explicitly on startup instead.

**The AC8 test** — it verifies payment ordering by intercepting `console.log` and parsing the `action` field. It works, but it's coupled to the log string. If someone renames `payment.capture`, the test passes silently without catching the regression. I kept it as-is but documented it as a known limitation rather than pretending it's a solid guarantee.

**`jest.config.js`** — after adding the `ORDERS_TABLE` startup check, tests started failing because the env variable wasn't set in the test environment. Fixed by adding test env vars to `jest.config.js`. Simple fix but it would have been easy to miss without actually running the suite.

**TypeScript compilation** — ran `npx tsc --noEmit` to verify there are no 
type errors. All types in `types.ts` flow correctly through `pricing.ts`, 
`repository.ts`, and `checkout.ts` without any `any` casts or type assertions 
that would hide bugs.