import { z } from "zod";
import { MAX_AMOUNT } from "../expense/expense.model";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const DAY_MS = 24 * 60 * 60 * 1000;

export const settlementInputSchema = z
  .object({
    from: objectId, // who paid
    to: objectId, // who received
    amount: z.number().int("Send the amount in whole paise").min(1, "Amount must be more than ₹0").max(MAX_AMOUNT),
    note: z.string().trim().max(140, "Keep the note under 140 characters").default(""),
    kind: z.enum(["payment", "kitty"]).default("payment"),
    date: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + DAY_MS, "The date can't be in the future")
      .default(() => new Date()),
  })
  .refine((v) => v.from !== v.to, { message: "Choose two different people", path: ["to"] });

/** The client makes a fresh random key (a UUID) each time the payment form opens. */
export const idempotencyKeySchema = z
  .string({ error: "Send an Idempotency-Key header" })
  .trim()
  .min(8, "Idempotency-Key is too short")
  .max(100, "Idempotency-Key is too long");

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type SettlementInput = z.infer<typeof settlementInputSchema>;
