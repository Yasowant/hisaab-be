// The table lives in prisma/schema.prisma (Settlement); this file keeps the shared filter.

/** Payments that count towards balances: not undone, and confirmed by the receiver. */
export const COUNTED = { deletedAt: null, status: "confirmed" as const };
