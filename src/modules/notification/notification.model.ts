import { Schema, model, Types, InferSchemaType } from "mongoose";

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

/** One line in a person's inbox. */
const notificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true }, // who it's for
    groupId: { type: Types.ObjectId, ref: "Group", required: true },
    actor: { type: Types.ObjectId, ref: "User", required: true }, // who did it
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    // A snapshot, so it still reads right after later edits
    data: {
      groupName: String,
      description: String,
      amount: Number, // paise
      text: String, // comment or dispute reason (shortened)
      expenseId: { type: Types.ObjectId, ref: "Expense" },
    },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
// Old notifications clean themselves up after 90 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export type Notification = InferSchemaType<typeof notificationSchema>;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const NotificationModel = model("Notification", notificationSchema);
