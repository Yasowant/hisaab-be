import { Schema, model, Types, InferSchemaType } from "mongoose";
import { MAX_AMOUNT } from "../expense/expense.model";

const settlementSchema = new Schema(
  {
    groupId: { type: Types.ObjectId, ref: "Group", required: true },
    from: { type: Types.ObjectId, ref: "User", required: true }, // who paid
    to: { type: Types.ObjectId, ref: "User", required: true }, // who received
    amount: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_AMOUNT,
      validate: { validator: Number.isInteger, message: "Amount must be whole paise" },
    },
    note: { type: String, trim: true, maxlength: 140, default: "" },
    date: { type: Date, required: true },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    // From the Idempotency-Key header: the same click sent twice saves once
    idempotencyKey: { type: String, required: true },
    deletedAt: { type: Date, default: null },
    /*
     * pending   → recorded by the payer (or an admin), waiting for the receiver
     * confirmed → counts towards balances
     * rejected  → the receiver said it never arrived; ignored
     * Older payments without a status count as confirmed.
     */
    status: { type: String, enum: ["pending", "confirmed", "rejected"], default: "confirmed" },
    respondedAt: { type: Date, default: null },
    // "kitty" = money put into the group's trip kitty (paid to the kitty holder)
    kind: { type: String, enum: ["payment", "kitty"], default: "payment" },
    // Set when paid online through Razorpay: the money really moved, so it can't be undone here
    gatewayPaymentId: { type: String, default: null },
    // Payments made together from the Friends page share one id, so they're confirmed together
    batchId: { type: Types.ObjectId, default: null },
  },
  { timestamps: true, versionKey: false },
);

settlementSchema.index({ groupId: 1, deletedAt: 1, createdAt: -1 });
settlementSchema.index({ groupId: 1, status: 1 });
// Keys only need to be unique per person, so one user can't block another's key
settlementSchema.index({ createdBy: 1, idempotencyKey: 1 }, { unique: true });
// For the dashboard summary: "every payment I sent or received"
settlementSchema.index({ from: 1 });
settlementSchema.index({ to: 1 });
settlementSchema.index({ batchId: 1 }, { sparse: true });

export type Settlement = InferSchemaType<typeof settlementSchema>;
export const SettlementModel = model("Settlement", settlementSchema);

/** Payments that count towards balances (older payments have no status: they count). */
export const COUNTED = { deletedAt: null, status: { $nin: ["pending", "rejected"] as ("pending" | "rejected")[] } };
