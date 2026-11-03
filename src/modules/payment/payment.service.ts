import { Types } from "mongoose";
import { PaymentOrderModel } from "./payment.model";
import { SettlementModel } from "../settlement/settlement.model";
import { GroupDoc } from "../group/group.model";
import { UserModel } from "../user/user.model";
import { activityService } from "../activity/activity.service";
import { publish } from "../events/events";
import { AppError } from "../../utils/AppError";
import { inTransaction } from "../../utils/transaction";
import { logger } from "../../utils/logger";
import { env } from "../../config/env";
import { checkoutSignatureValid, razorpay, razorpayEnabled, type RzpPayment } from "../../utils/razorpay";

const isDuplicateKey = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;

/**
 * Turn a paid order into a confirmed payment, exactly once. Both the browser
 * (after Checkout) and Razorpay's webhook can call this; whichever comes
 * first records it, the other finds it already done.
 */
async function settle(orderId: string, paymentId: string) {
  const order = await PaymentOrderModel.findOne({ orderId });
  if (!order) throw new AppError(404, "Payment not found");
  if (order.status === "paid") return { order, alreadyDone: true };

  try {
    await inTransaction(async (session) => {
      const claimed = await PaymentOrderModel.findOneAndUpdate(
        { _id: order._id, status: "created" },
        { $set: { status: "paid", paymentId, paidAt: new Date() } },
        { session, returnDocument: "after" },
      );
      if (!claimed) throw new AppError(409, "already paid");

      const [s] = await SettlementModel.create(
        [
          {
            groupId: order.groupId,
            from: order.from,
            to: order.to,
            amount: order.amount,
            note: "Paid online",
            date: new Date(),
            createdBy: order.from,
            idempotencyKey: `rzp:${orderId}`,
            status: "confirmed", // the gateway confirmed it; nobody needs to
            kind: "payment",
            gatewayPaymentId: paymentId,
          },
        ],
        { session },
      );
      await PaymentOrderModel.updateOne({ _id: order._id }, { $set: { settlementId: s!._id } }, { session });
      await activityService.record(session, {
        groupId: order.groupId,
        actor: String(order.from),
        type: "payment_confirmed",
        data: { from: order.from, to: order.to, amount: order.amount, settlementId: s!._id, description: "Paid online" },
      });
    });
  } catch (err) {
    // The other caller won the race: fine, it's recorded
    if ((err instanceof AppError && err.statusCode === 409) || isDuplicateKey(err)) {
      return { order: (await PaymentOrderModel.findById(order._id))!, alreadyDone: true };
    }
    throw err;
  }

  publish(String(order.groupId), String(order.from)); // everyone's page updates live
  return { order: (await PaymentOrderModel.findById(order._id))!, alreadyDone: false };
}

/** Razorpay's own record must match our order before we believe it. */
async function checkWithRazorpay(orderId: string, paymentId: string, expectedAmount: number): Promise<RzpPayment> {
  let p = await razorpay.fetchPayment(paymentId);
  if (p.order_id !== orderId || p.amount !== expectedAmount || p.currency !== "INR") {
    throw new AppError(400, "This payment doesn't match the order");
  }
  // Accounts without auto-capture leave payments "authorized"; capture so the money is kept
  if (p.status === "authorized") p = await razorpay.capturePayment(paymentId, expectedAmount);
  if (p.status !== "captured") throw new AppError(402, `The payment wasn't completed (status: ${p.status})`);
  return p;
}

export const paymentService = {
  config() {
    return { enabled: razorpayEnabled(), keyId: razorpayEnabled() ? env.RAZORPAY_KEY_ID : null };
  },

  /** Step 1: make a Razorpay order for "I pay this member this much". */
  async createOrder(group: GroupDoc, actorId: string, input: { to: string; amount: number }) {
    if (!razorpayEnabled()) throw new AppError(503, "Online payments aren't set up on this server");
    if (input.to === actorId) throw new AppError(400, "You can’t pay yourself");
    if (!group.members.some((m) => String(m.userId) === input.to)) {
      throw new AppError(400, "That person isn’t in this group");
    }

    const [payer, payee] = await Promise.all([
      UserModel.findById(actorId, "name email").lean(),
      UserModel.findById(input.to, "name").lean(),
    ]);
    const id = new Types.ObjectId();
    const rzp = await razorpay.createOrder({
      amount: input.amount,
      receipt: `hisaab_${id}`, // max 40 characters
      notes: { group: group.name.slice(0, 200), from: payer?.name ?? "", to: payee?.name ?? "" },
    });
    await PaymentOrderModel.create({
      _id: id,
      groupId: group._id,
      from: actorId,
      to: input.to,
      amount: input.amount,
      orderId: rzp.id,
    });

    return {
      orderId: rzp.id,
      amount: rzp.amount,
      currency: rzp.currency,
      keyId: env.RAZORPAY_KEY_ID!,
      description: `To ${payee?.name ?? "a friend"}, ${group.name}`,
      prefill: { name: payer?.name ?? "", email: payer?.email ?? "" },
    };
  },

  /** Step 2: the browser hands back Checkout's result; check it, then record the payment. */
  async verify(
    group: GroupDoc,
    actorId: string,
    body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
  ) {
    const order = await PaymentOrderModel.findOne({ orderId: body.razorpay_order_id, groupId: group._id });
    if (!order || String(order.from) !== actorId) throw new AppError(404, "Payment not found");
    if (!checkoutSignatureValid(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
      throw new AppError(400, "The payment signature is invalid");
    }
    if (order.status !== "paid") await checkWithRazorpay(order.orderId, body.razorpay_payment_id, order.amount);
    const { order: done } = await settle(order.orderId, body.razorpay_payment_id);
    return { status: done.status, amount: done.amount, paymentId: done.paymentId };
  },

  /** Razorpay calls this when a payment succeeds, even if the user closed the tab. */
  async handleWebhook(event: { event?: string; payload?: { payment?: { entity?: RzpPayment } } }) {
    const p = event.payload?.payment?.entity;
    if (!p || !["payment.captured", "order.paid"].includes(event.event ?? "")) return;
    const order = await PaymentOrderModel.findOne({ orderId: p.order_id });
    if (!order) return; // not one of ours
    if (p.amount !== order.amount || p.status !== "captured") {
      logger.warn({ orderId: p.order_id, amount: p.amount, status: p.status }, "Webhook payment doesn't match order");
      return;
    }
    await settle(order.orderId, p.id);
  },
};
