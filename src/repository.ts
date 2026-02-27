import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { Order } from './types';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env['ORDERS_TABLE'];
if (!TABLE_NAME) {
  throw new Error('Missing required environment variable: ORDERS_TABLE');
}

export async function getOrderByCartId(cartId: string): Promise<Order | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { cartId },
    })
  );

  return result.Item ? (result.Item as Order) : null;
}

export interface CreateOrderResult {
  created: boolean;
  order: Order;
}

/**
 * Attempts to create the order using attribute_not_exists(cartId).
 * If a race condition causes the condition to fail, fetches and returns
 * the existing order. Guarantees exactly-once creation under concurrent retries.
 */
export async function createOrder(order: Order): Promise<CreateOrderResult> {
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: order,
        ConditionExpression: 'attribute_not_exists(cartId)',
      })
    );
    return { created: true, order };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      const existing = await getOrderByCartId(order.cartId);
      if (!existing) {
        // Should not happen, but re-throw to surface as 500
        throw new Error(`Idempotency check failed: order for cartId ${order.cartId} not found after conflict`);
      }
      return { created: false, order: existing };
    }
    throw err;
  }
}
