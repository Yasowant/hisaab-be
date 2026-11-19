// The table lives in prisma/schema.prisma (Notification); this file keeps the shared constants.

export const NOTIFICATION_TYPES = [
  "expense_added", // you have a share in a new expense
  "expense_updated",
  "expense_deleted",
  "payment_to_confirm", // someone says they paid you: confirm it
  "payment_received", // money came in (recorded by you or paid online)
  "payment_confirmed", // the receiver confirmed your payment
  "payment_rejected", // the receiver says it never arrived
  "comment_added",
  "expense_disputed",
  "dispute_resolved",
  "payment_reminder", // you still owe someone; sent on a schedule or by a friend
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** What Notification.data holds: a snapshot, so it still reads right after later edits. */
export type NotificationData = {
  groupName?: string;
  description?: string;
  amount?: number; // paise
  text?: string; // comment or dispute reason (shortened)
  expenseId?: string;
};

/** Old notifications are cleaned up after this long. */
export const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
