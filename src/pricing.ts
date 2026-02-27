import type { CheckoutItem, OrderItem } from './types';

export interface PricingResult {
  items: OrderItem[];
  subtotal: number;
  tax: number;
  total: number;
}

export function calculatePricing(items: CheckoutItem[]): PricingResult {
  const orderItems: OrderItem[] = items.map(item => ({
    ...item,
    lineTotal: item.unitPrice * item.quantity,
  }));

  const subtotal = orderItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const tax = Math.floor(subtotal * 0.08);
  const total = subtotal + tax;

  return { items: orderItems, subtotal, tax, total };
}
