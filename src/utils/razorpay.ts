import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./AppError";

/**
 * A small Razorpay client using its REST API directly (no SDK needed).
 * Docs: https://razorpay.com/docs/api/orders/ and /payments/
 */
export const razorpayEnabled = () => Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!razorpayEnabled()) throw new AppError(503, "Online payments aren't set up on this server");
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const res = await fetch(`${env.RAZORPAY_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) {
    throw new AppError(502, `Razorpay: ${data.error?.description ?? `request failed (${res.status})`}`);
  }
  return data;
}

export type RzpOrder = { id: string; amount: number; currency: string; status: string };
export type RzpPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method?: string;
};

export const razorpay = {
  createOrder: (input: { amount: number; receipt: string; notes: Record<string, string> }) =>
    call<RzpOrder>("POST", "/orders", { ...input, currency: "INR" }),

  fetchPayment: (paymentId: string) => call<RzpPayment>("GET", `/payments/${encodeURIComponent(paymentId)}`),

  capturePayment: (paymentId: string, amount: number) =>
    call<RzpPayment>("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency: "INR" }),
};

function sameHmac(expected: string, given: string) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checkout's handler returns this signature: HMAC-SHA256(order_id|payment_id, key secret). */
export function checkoutSignatureValid(orderId: string, paymentId: string, signature: string) {
  const expected = createHmac("sha256", env.RAZORPAY_KEY_SECRET ?? "").update(`${orderId}|${paymentId}`).digest("hex");
  return sameHmac(expected, signature);
}

/** Webhooks are signed over the raw request body with the webhook secret. */
export function webhookSignatureValid(rawBody: Buffer, signature: string) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return sameHmac(expected, signature);
}
