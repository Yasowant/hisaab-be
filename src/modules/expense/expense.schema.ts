import { z } from "zod";
import { CATEGORIES, MAX_AMOUNT } from "./expense.model";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const DAY_MS = 24 * 60 * 60 * 1000;

const base = {
  description: z
    .string()
    .trim()
    .min(1, "Describe the expense")
    .max(100, "Keep it under 100 characters"),
  amount: z
    .number()
    .int("Send the amount in whole paise")
    .min(1, "Amount must be more than ₹0")
    .max(MAX_AMOUNT, "That's more than ₹10,00,000"),
  paidBy: objectId,
  category: z.enum(CATEGORIES).default("other"),
  date: z.coerce
    .date()
    .refine(
      (d) => d.getTime() <= Date.now() + DAY_MS,
      "The date can't be in the future",
    )
    .default(() => new Date()),
  // Paid out of the trip kitty (the kitty holder is then the payer)
  fromKitty: z.boolean().default(false),
  // Paid in another currency: what the bill said, and the rate used to get rupees
  original: z
    .object({
      currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code").refine((c) => c !== "INR", "That's already rupees"),
      amount: z.number().int("Send the amount in hundredths").min(1).max(1e12), // e.g. ฿1,200.50 → 120050
      rate: z.number().positive().max(1e6), // rupees for 1 unit of the currency
    })
    .nullable()
    .default(null),
};

const noDuplicates = (ids: string[]) => new Set(ids).size === ids.length;

const equal = z.object({
  ...base,
  splitType: z.literal("equal"),
  participants: z
    .array(objectId)
    .min(1, "Pick at least one person to share it")
    .max(50)
    .refine(noDuplicates, "Each person can appear only once"),
});

const exact = z.object({
  ...base,
  splitType: z.literal("exact"),
  splits: z
    .array(z.object({ userId: objectId, amount: z.number().int().min(0) }))
    .min(1)
    .max(50)
    .refine(
      (s) => noDuplicates(s.map((x) => x.userId)),
      "Each person can appear only once",
    ),
});

const percent = z.object({
  ...base,
  splitType: z.literal("percent"),
  splits: z
    .array(
      z.object({
        userId: objectId,
        percent: z
          .number()
          .min(0)
          .max(100)
          .refine(
            (p) => Math.abs(p * 100 - Math.round(p * 100)) < 1e-6,
            "Use at most 2 decimals",
          ),
      }),
    )
    .min(1)
    .max(50)
    .refine(
      (s) => noDuplicates(s.map((x) => x.userId)),
      "Each person can appear only once",
    ),
});

// A restaurant bill line by line; tax, service and tip ("extras") are shared
// in proportion to what each person had
const itemized = z.object({
  ...base,
  splitType: z.literal("itemized"),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Name each item").max(60),
        amount: z.number().int().min(1, "Each item needs a price"),
        sharedBy: z.array(objectId).min(1, "Pick who shared this item").max(50).refine(noDuplicates, "Each person can appear only once"),
      }),
    )
    .min(1, "Add at least one item")
    .max(50),
  extras: z.number().int().min(0).default(0),
});

export const expenseInputSchema = z.discriminatedUnion("splitType", [
  equal,
  exact,
  percent,
  itemized,
]);

// Creating can also make it repeat (rent, Wi-Fi). Editing doesn't change repeats.
export const createExpenseSchema = expenseInputSchema.and(
  z.object({ repeat: z.enum(["none", "weekly", "monthly"]).default("none") }),
);

export const updateExpenseSchema = expenseInputSchema.and(
  z.object({
    version: z.number().int().min(0),
  }),
);

export const listExpensesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Filters (all optional)
  q: z.string().trim().max(100).optional(), // words in the description
  category: z.enum(CATEGORIES).optional(),
  paidBy: objectId.optional(),
  involving: objectId.optional(), // paid by or has a share
  from: z.coerce.date().optional(), // on or after this day
  to: z.coerce.date().optional(), // on or before this day
  disputed: z.enum(["true", "false"]).optional(), // only flagged expenses
});

export const disputeSchema = z.object({
  reason: z.string().trim().min(3, "Say what’s wrong (at least 3 characters)").max(300, "Keep it under 300 characters"),
});

// The body is optional (a plain DELETE works)
export const resolveDisputeSchema = z.preprocess(
  (v) => v ?? {},
  z.object({
    note: z.string().trim().max(300).optional(), // what was fixed, shown as a comment
  }),
);

export type ExpenseInput = z.infer<typeof expenseInputSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuery>;
