// Tables live in prisma/schema.prisma (Expense, ExpenseSplit, ExpenseReceipt); this file keeps the shared constants.

export const SPLIT_TYPES = ["equal", "exact", "percent", "itemized"] as const;
export const CATEGORIES = [
  "food",
  "travel",
  "stay",
  "rent",
  "utilities",
  "shopping",
  "other",
] as const;
export const MAX_AMOUNT = 10_00_00_000;

/** One line of an itemized bill, stored in Expense.items (JSON). */
export type StoredItem = { name: string; amount: number; sharedBy: string[] };

/** A bill in another currency, stored in Expense.original (JSON). */
export type StoredOriginal = { currency: string; amount: number; rate: number };
