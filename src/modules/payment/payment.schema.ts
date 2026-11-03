import { z } from "zod";
import { MAX_AMOUNT } from "../expense/expense.model";

export const createOrderSchema = z.object({
  to: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id"),
  amount: z.number().int("Send the amount in whole paise").min(100, "The smallest online payment is ₹1").max(MAX_AMOUNT),
});

export const verifySchema = z.object({
  razorpay_order_id: z.string().min(1).max(100),
  razorpay_payment_id: z.string().min(1).max(100),
  razorpay_signature: z.string().min(1).max(200),
});
