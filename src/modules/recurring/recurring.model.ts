import { Schema, model, Types, InferSchemaType } from "mongoose";

export const FREQUENCIES = ["weekly", "monthly"] as const;

// "Rent ₹30,000 every month": a saved expense that adds itself again on schedule
const recurringSchema = new Schema(
  {
    groupId: { type: Types.ObjectId, ref: "Group", required: true },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    // The expense request as it was first sent (without the date)
    template: { type: Schema.Types.Mixed, required: true },
    frequency: { type: String, enum: FREQUENCIES, required: true },
    // Day of the month for monthly repeats (31 → last day in shorter months)
    anchorDay: { type: Number, min: 1, max: 31, required: true },
    nextRun: { type: Date, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

recurringSchema.index({ groupId: 1, active: 1, nextRun: 1 });

export type Recurring = InferSchemaType<typeof recurringSchema>;
export const RecurringModel = model("RecurringExpense", recurringSchema);
