// The table lives in prisma/schema.prisma (Activity); this file keeps the shared constants.

export const ACTIVITY_TYPES = [
  "expense_added",
  "expense_updated",
  "expense_deleted",
  "payment_recorded",
  "payment_deleted",
  "payment_confirmed",
  "payment_rejected",
  "member_claimed",
  "expense_disputed",
  "dispute_resolved",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** What Activity.data holds: a snapshot of what it was about. */
export type ActivityData = {
  description?: string;
  amount?: number; // paise
  previousAmount?: number; // paise, for edits
  text?: string; // dispute reason
  expenseId?: string;
  settlementId?: string;
};
