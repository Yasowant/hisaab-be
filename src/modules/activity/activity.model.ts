import { Schema, model, Types, InferSchemaType } from "mongoose";

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

const activitySchema = new Schema(
  {
    groupId: { type: Types.ObjectId, ref: "Group", required: true },
    actor: { type: Types.ObjectId, ref: "User", required: true }, // who did it
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    // A snapshot of what it was about, so the feed still reads right after later edits
    data: {
      description: String,
      amount: Number, // paise
      previousAmount: Number, // paise, for edits
      text: String, // dispute reason
      from: { type: Types.ObjectId, ref: "User" },
      to: { type: Types.ObjectId, ref: "User" },
      expenseId: { type: Types.ObjectId, ref: "Expense" },
      settlementId: { type: Types.ObjectId, ref: "Settlement" },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

activitySchema.index({ groupId: 1, createdAt: -1 });

export type Activity = InferSchemaType<typeof activitySchema>;
export const ActivityModel = model("Activity", activitySchema);
