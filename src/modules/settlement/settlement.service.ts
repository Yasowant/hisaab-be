import { isValidObjectId, Types } from "mongoose";
import { SettlementModel } from "./settlement.model";
import { GroupDoc } from "../group/group.model";
import { UserModel } from "../user/user.model";
import { activityService } from "../activity/activity.service";
import { AppError } from "../../utils/AppError";
import { inTransaction } from "../../utils/transaction";
import { SettlementInput } from "./settlement.schema";

type Named = { _id: Types.ObjectId; name: string };

const isDuplicateKey = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;

async function loadOne(id: Types.ObjectId | string) {
  return SettlementModel.findById(id)
    .populate<{ from: Named }>("from", "name")
    .populate<{ to: Named }>("to", "name")
    .lean();
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadOne>>>;

const toDTO = (s: Loaded) => ({
  id: String(s._id),
  from: { id: String(s.from._id), name: s.from.name },
  to: { id: String(s.to._id), name: s.to.name },
  amount: s.amount,
  note: s.note,
  date: s.date,
  kind: s.kind ?? "payment",
  status: s.status ?? "confirmed",
  paidOnline: Boolean(s.gatewayPaymentId),
  createdBy: String(s.createdBy),
  createdAt: s.createdAt,
});

async function isPlaceholder(userId: string | Types.ObjectId) {
  const u = await UserModel.findById(userId, "placeholder").lean();
  return Boolean(u?.placeholder);
}

/**
 * Who may confirm or reject a pending payment: the receiver. If the receiver
 * isn't on Hisaab yet (a placeholder), a group admin answers for them.
 */
async function ensureCanRespond(s: { to: Types.ObjectId }, actorId: string, actorRole: string) {
  if (String(s.to) === actorId) return;
  if (actorRole === "admin" && (await isPlaceholder(s.to))) return;
  throw new AppError(403, "Only the person who received this payment can confirm or reject it");
}

export const settlementService = {
  /**
   * Record that one member paid another.
   * - Recorded by the receiver → confirmed straight away (they know it arrived).
   * - Recorded by the payer or an admin → pending until the receiver confirms.
   * Safe to retry: the same Idempotency-Key from the same person returns the
   * first result instead of saving the payment twice.
   */
  async record(group: GroupDoc, actorId: string, actorRole: string, input: SettlementInput, key: string) {
    const members = new Set(group.members.map((m) => String(m.userId)));
    if (!members.has(input.from) || !members.has(input.to)) {
      throw new AppError(400, "Both people must be in this group");
    }
    if (actorRole !== "admin" && actorId !== input.from && actorId !== input.to) {
      throw new AppError(403, "Only the payer, the receiver or a group admin can record this payment");
    }
    if (input.kind === "kitty") {
      if (!group.kittyHolderId) throw new AppError(400, "This group doesn't have a kitty");
      if (String(group.kittyHolderId) !== input.to) {
        throw new AppError(400, "Money for the kitty goes to the kitty holder");
      }
    }

    // Seen this key before? Return what we saved then (a double-click or a retry)
    const existing = await SettlementModel.findOne({ createdBy: actorId, idempotencyKey: key });
    if (existing) return { settlement: toDTO((await loadOne(existing._id))!), replayed: true };

    const receiverConfirms = actorId !== input.to && !(await isPlaceholder(input.to));
    const status = receiverConfirms ? "pending" : "confirmed";

    try {
      const id = await inTransaction(async (session) => {
        // The payment and its activity entry save together, or neither does
        const [created] = await SettlementModel.create(
          [{ ...input, status, groupId: group._id, createdBy: actorId, idempotencyKey: key }],
          { session },
        );
        await activityService.record(session, {
          groupId: group._id,
          actor: actorId,
          type: "payment_recorded",
          data: { from: input.from, to: input.to, amount: input.amount, settlementId: created!._id },
        });
        return created!._id;
      });
      return { settlement: toDTO((await loadOne(id))!), replayed: false };
    } catch (err) {
      // Two identical requests raced; the unique index let only one win. Return that one.
      if (isDuplicateKey(err)) {
        const winner = await SettlementModel.findOne({ createdBy: actorId, idempotencyKey: key });
        if (winner) return { settlement: toDTO((await loadOne(winner._id))!), replayed: true };
      }
      throw err;
    }
  },

  /** The receiver says "yes, it arrived" (confirm) or "no, it didn't" (reject). */
  async respond(group: GroupDoc, actorId: string, actorRole: string, settlementId: string, accept: boolean) {
    if (!isValidObjectId(settlementId)) throw new AppError(404, "Payment not found");
    const s = await SettlementModel.findOne({ _id: settlementId, groupId: group._id, deletedAt: null });
    if (!s) throw new AppError(404, "Payment not found");
    await ensureCanRespond(s, actorId, actorRole);

    await inTransaction(async (session) => {
      // Only a pending payment can be answered, and only once
      const res = await SettlementModel.updateOne(
        { _id: s._id, status: "pending", deletedAt: null },
        { $set: { status: accept ? "confirmed" : "rejected", respondedAt: new Date() } },
        { session },
      );
      if (res.modifiedCount === 0) throw new AppError(409, "This payment was already answered");
      await activityService.record(session, {
        groupId: group._id,
        actor: actorId,
        type: accept ? "payment_confirmed" : "payment_rejected",
        data: { from: s.from, to: s.to, amount: s.amount, settlementId: s._id },
      });
    });
    return toDTO((await loadOne(s._id))!);
  },

  /** Pending and confirmed payments, newest first (rejected ones only show in the activity feed). */
  async list(group: GroupDoc, page: number, limit: number) {
    const filter = { groupId: group._id, deletedAt: null, status: { $ne: "rejected" as const } };
    const [docs, total] = await Promise.all([
      SettlementModel.find(filter)
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate<{ from: Named }>("from", "name")
        .populate<{ to: Named }>("to", "name")
        .lean(),
      SettlementModel.countDocuments(filter),
    ]);
    return { items: docs.map(toDTO), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  },

  /** Undo a payment recorded by mistake. The person who recorded it, or an admin. */
  async remove(group: GroupDoc, actorId: string, actorRole: string, settlementId: string) {
    if (!isValidObjectId(settlementId)) throw new AppError(404, "Payment not found");
    const s = await SettlementModel.findOne({ _id: settlementId, groupId: group._id, deletedAt: null });
    if (!s) throw new AppError(404, "Payment not found");
    if (actorRole !== "admin" && String(s.createdBy) !== actorId) {
      throw new AppError(403, "Only the person who recorded this payment, or a group admin, can undo it");
    }
    if (s.gatewayPaymentId) {
      throw new AppError(409, "This was paid online, so the money really moved. Refund it from Razorpay instead.");
    }

    await inTransaction(async (session) => {
      await SettlementModel.updateOne({ _id: s._id }, { $set: { deletedAt: new Date() } }, { session });
      await activityService.record(session, {
        groupId: group._id,
        actor: actorId,
        type: "payment_deleted",
        data: { from: s.from, to: s.to, amount: s.amount, settlementId: s._id },
      });
    });
  },
};
