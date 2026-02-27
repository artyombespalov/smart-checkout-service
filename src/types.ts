export interface CheckoutItem {
  productId: string;
  name: string;
  unitPrice: number; // USD cents, positive integer
  quantity: number;  // integer >= 1
}

export interface CheckoutRequest {
  cartId: string;    // UUID
  customerId: string;
  items: CheckoutItem[];
}

export interface OrderItem extends CheckoutItem {
  lineTotal: number; // unitPrice * quantity
}

export interface Order {
  orderId: string;    // UUID, generated server-side
  cartId: string;
  customerId: string;
  items: OrderItem[];
  subtotal: number;   // sum of lineTotals, cents
  tax: number;        // floor(subtotal * 0.08), cents
  total: number;      // subtotal + tax, cents
  status: 'CONFIRMED';
  createdAt: string;  // ISO 8601 timestamp
}

export interface ValidationError {
  error: 'VALIDATION_ERROR';
  message: string;
}

export interface InternalError {
  error: 'INTERNAL_ERROR';
  message: string;
}

export type CheckoutErrorResponse = ValidationError | InternalError;
