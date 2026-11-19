import { prisma } from "../../config/db";
import { GroupDoc } from "../group/group.model";
import { activityService } from "../activity/activity.service";
import { AppError } from "../../utils/AppError";
import { inTransaction } from "../../utils/transaction";
import { isUniqueViolation } from "../../utils/dbErrors";
import { isId } from "../../utils/id";
import { SettlementInput } from "./settlement.schema";
import type { Prisma } from "../../generated/prisma/client";

const named = { select: { id: true, name: true } } as const;
const withNames = { from: named, to: named } satisfies Prisma.SettlementInclude;
type Loaded = Prisma.SettlementGetPayload<{ include: typeof withNames }>;

const loadOne = (id: string) => prisma.settlement.findUnique({ where: { id }, include: withNames });

const toDTO = (s: Loaded) => ({
  id: s.id,
  from: { id: s.from.id, name: s.from.name },
  to: { id: s.to.id, name: s.to.name },
  amount: s.amount,
  note: s.note,
  date: s.date,
  kind: s.kind,
  status: s.status,
  paidOnline: Boolean(s.gatewayPaymentId),
  createdBy: s.createdById,
  createdAt: s.createdAt,
});

async function isPlaceholder(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { placeholder: true } });
  return Boolean(u?.placeholder);
}

/**
 * Who may confirm or reject a pending payment: the receiver. If the receiver
 * isn't on Hisaab yet (a placeholder), a group admin answers for them.
 */
async function ensureCanRespond(s: { toId: string }, actorId: string, actorRole: string) {
  if (s.toId === actorId) return;
  if (actorRole === "admin" && (await isPlaceholder(s.toId))) return;
  throw new AppError(403, "Only the person who received this payment can confirm or reject it");
}

const byKey = (createdById: string, idempotencyKey: string) =>
  prisma.settlement.findUnique({ where: { createdById_idempotencyKey: { createdById, idempotencyKey } }, include: withNames });

export const settlementService = {
  /**
   * Record that one member paid another.
   * - Recorded by the receiver → confirmed straight away (they know it arrived).
   * - Recorded by the payer or an admin → pending until the receiver confirms.
   * Safe to retry: the same Idempotency-Key from the same person returns the
   * first result instead of saving the payment twice.
   */
  async record(group: GroupDoc, actorId: string, actorRole: string, input: SettlementInput, key: string) {
    const members = new Set(group.members.map((m) => m.userId));
    if (!members.has(input.from) || !members.has(input.to)) {
      throw new AppError(400, "Both people must be in this group");
    }
    if (actorRole !== "admin" && actorId !== input.from && actorId !== input.to) {
      throw new AppError(403, "Only the payer, the receiver or a group admin can record this payment");
    }
    if (input.kind === "kitty") {
      if (!group.kittyHolderId) throw new AppError(400, "This group doesn't have a kitty");
      if (group.kittyHolderId !== input.to) {
        throw new AppError(400, "Money for the kitty goes to the kitty holder");
      }
    }

    // Seen this key before? Return what we saved then (a double-click or a retry)
    const existing = await byKey(actorId, key);
    if (existing) return { settlement: toDTO(existing), replayed: true };

    const receiverConfirms = actorId !== input.to && !(await isPlaceholder(input.to));
    const status = receiverConfirms ? "pending" : "confirmed";

    try {
      const id = await inTransaction(async (tx) => {
        // The payment and its activity entry save together, or neither does
        const created = await tx.settlement.create({
          data: {
            groupId: group.id,
            fromId: input.from,
            toId: input.to,
            amount: input.amount,
            note: input.note,
            kind: input.kind,
            date: input.date,
            status,
            createdById: actorId,
            idempotencyKey: key,
          },
          select: { id: true },
        });
        await activityService.record(tx, {
          groupId: group.id,
          actor: actorId,
          type: "payment_recorded",
          data: { from: input.from, to: input.to, amount: input.amount, settlementId: created.id },
        });
        return created.id;
      });
      return { settlement: toDTO((await loadOne(id))!), replayed: false };
    } catch (err) {
      // Two identical requests raced; the unique index let only one win. Return that one.
      if (isUniqueViolation(err)) {
        const winner = await byKey(actorId, key);
        if (winner) return { settlement: toDTO(winner), replayed: true };
      }
      throw err;
    }
  },

  /** The receiver says "yes, it arrived" (confirm) or "no, it didn't" (reject). */
  async respond(group: GroupDoc, actorId: string, actorRole: string, settlementId: string, accept: boolean) {
    if (!isId(settlementId)) throw new AppError(404, "Payment not found");
    const s = await prisma.settlement.findFirst({ where: { id: settlementId, groupId: group.id, deletedAt: null } });
    if (!s) throw new AppError(404, "Payment not found");
    await ensureCanRespond(s, actorId, actorRole);

    await inTransaction(async (tx) => {
      // Only a pending payment can be answered, and only once
      const res = await tx.settlement.updateMany({
        where: { id: s.id, status: "pending", deletedAt: null },
        data: { status: accept ? "confirmed" : "rejected", respondedAt: new Date() },
      });
      if (res.count === 0) throw new AppError(409, "This payment was already answered");
      await activityService.record(tx, {
        groupId: group.id,
        actor: actorId,
        type: accept ? "payment_confirmed" : "payment_rejected",
        data: { from: s.fromId, to: s.toId, amount: s.amount, settlementId: s.id },
      });
    });
    return toDTO((await loadOne(s.id))!);
  },

  /** Pending and confirmed payments, newest first (rejected ones only show in the activity feed). */
  async list(group: GroupDoc, page: number, limit: number) {
    const where: Prisma.SettlementWhereInput = { groupId: group.id, deletedAt: null, status: { not: "rejected" } };
    const [docs, total] = await Promise.all([
      prisma.settlement.findMany({
        where,
        orderBy: [{ date: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: withNames,
      }),
      prisma.settlement.count({ where }),
    ]);
    return { items: docs.map(toDTO), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  },

  /** Undo a payment recorded by mistake. The person who recorded it, or an admin. */
  async remove(group: GroupDoc, actorId: string, actorRole: string, settlementId: string) {
    if (!isId(settlementId)) throw new AppError(404, "Payment not found");
    const s = await prisma.settlement.findFirst({ where: { id: settlementId, groupId: group.id, deletedAt: null } });
    if (!s) throw new AppError(404, "Payment not found");
    if (actorRole !== "admin" && s.createdById !== actorId) {
      throw new AppError(403, "Only the person who recorded this payment, or a group admin, can undo it");
    }
    if (s.gatewayPaymentId) {
      throw new AppError(409, "This was paid online, so the money really moved. Refund it from Razorpay instead.");
    }

    await inTransaction(async (tx) => {
      await tx.settlement.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
      await activityService.record(tx, {
        groupId: group.id,
        actor: actorId,
        type: "payment_deleted",
        data: { from: s.fromId, to: s.toId, amount: s.amount, settlementId: s.id },
      });
    });
  },
};
