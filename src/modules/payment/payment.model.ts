import { Schema, model, Types, InferSchemaType } from "mongoose";

/**
 * One "Pay online" attempt: a Razorpay order for one member paying another.
 * When the payment succeeds it becomes a confirmed settlement.
 */
const paymentOrderSchema = new Schema(
  {
    groupId: { type: Types.ObjectId, ref: "Group", required: true },
    from: { type: Types.ObjectId, ref: "User", required: true }, // who pays
    to: { type: Types.ObjectId, ref: "User", required: true }, // who it's for
    amount: { type: Number, required: true, min: 100 }, // paise (Razorpay's minimum is ₹1)
    orderId: { type: String, required: true, unique: true }, // Razorpay order_…
    status: { type: String, enum: ["created", "paid"], default: "created" },
    paymentId: { type: String, default: null }, // Razorpay pay_…
    settlementId: { type: Types.ObjectId, ref: "Settlement", default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

export type PaymentOrder = InferSchemaType<typeof paymentOrderSchema>;
export const PaymentOrderModel = model("PaymentOrder", paymentOrderSchema);
