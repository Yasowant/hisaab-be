import { prisma } from "../../config/db";
import { balanceService, simplifyDebts } from "../balance/balance.service";
import { activityService } from "../activity/activity.service";
import { publish } from "../events/events";
import { AppError } from "../../utils/AppError";
import { inTransaction } from "../../utils/transaction";
import { isId, newId } from "../../utils/id";

/*
 * Friends: everyone I share a group with, and where I stand with each of them
 * across all those groups. Each group's amount is that group's suggested payment
 * between the two of us, so it always matches what the group page says.
 */

type Part = { groupId: string; groupName: string; amount: number }; // + they owe me, − I owe them

async function myGroups(meId: string) {
  return prisma.group.findMany({
    where: { closedAt: null, members: { some: { userId: meId } } },
    select: { id: true, name: true, members: { select: { userId: true } } },
  });
}

/** Per friend, per group: what the group page suggests between us. */
async function ledger(meId: string) {
  const groups = await myGroups(meId);
  const parts = new Map<string, Part[]>();
  const friendIds = new Set<string>();
  for (const g of groups) {
    for (const m of g.members) if (m.userId !== meId) friendIds.add(m.userId);
    for (const p of simplifyDebts(await balanceService.netBalances(g.id))) {
      const other = p.from === meId ? p.to : p.to === meId ? p.from : null;
      if (!other) continue;
      const amount = p.from === meId ? -p.amount : p.amount;
      friendIds.add(other);
      parts.set(other, [...(parts.get(other) ?? []), { groupId: g.id, groupName: g.name, amount }]);
    }
  }
  return { groups, parts, friendIds };
}

export const friendService = {
  async list(meId: string) {
    const { parts, friendIds } = await ledger(meId);
    const ids = [...friendIds];
    const [users, pending] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, upiId: true, placeholder: true, avatarUrl: true },
      }),
      // Batches from the Friends page still waiting for an answer
      prisma.settlement.findMany({
        where: {
          batchId: { not: null },
          status: "pending",
          deletedAt: null,
          OR: [{ fromId: meId }, { toId: meId }],
        },
      }),
    ]);
    const batches = new Map<string, { id: string; from: string; to: string; amount: number; groups: number }>();
    for (const s of pending) {
      const id = s.batchId!;
      const b = batches.get(id) ?? { id, from: s.fromId, to: s.toId, amount: 0, groups: 0 };
      b.amount += s.amount;
      b.groups += 1;
      batches.set(id, b);
    }

    const friends = users.map((u) => {
      const groups = parts.get(u.id) ?? [];
      return {
        id: u.id,
        name: u.name,
        upiId: u.upiId ?? null,
        placeholder: u.placeholder,
        avatarUrl: u.avatarUrl ?? null,
        net: groups.reduce((t, p) => t + p.amount, 0),
        groups,
        pending: [...batches.values()]
          .filter((b) => b.from === u.id || b.to === u.id)
          .map((b) => ({ id: b.id, amount: b.amount, groups: b.groups, iPaid: b.from === meId })),
      };
    });
    // People with money to sort out first, biggest first; then everyone else by name
    friends.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name));
    return friends;
  },

  /**
   * Settle everything with one friend in one go: one payment in each group where
   * money is owed between us, all sharing a batch id.
   * - I paid them → pending until they confirm (once, for the whole batch).
   * - They paid me → confirmed straight away (I'm the one who received it).
   */
  async settle(meId: string, friendId: string, key: string, note: string) {
    if (!isId(friendId) || friendId === meId) throw new AppError(404, "Friend not found");

    // Same click sent twice? Return the first batch.
    const prev = await prisma.settlement.findUnique({
      where: { createdById_idempotencyKey: { createdById: meId, idempotencyKey: `${key}:0` } },
      select: { batchId: true },
    });
    if (prev?.batchId) return { batchId: prev.batchId, replayed: true };

    const { parts } = await ledger(meId);
    const groups = parts.get(friendId) ?? [];
    if (groups.length === 0) throw new AppError(400, "You’re all settled up with them");
    const net = groups.reduce((t, p) => t + p.amount, 0);
    if (net === 0) throw new AppError(400, "What you owe each other cancels out. Settle in each group instead.");
    const iPay = net < 0;
    const friend = await prisma.user.findUnique({ where: { id: friendId }, select: { placeholder: true } });
    if (!friend) throw new AppError(404, "Friend not found");
    // Groups where the money goes the other way are left for the group page
    const legs = groups.filter((p) => (iPay ? p.amount < 0 : p.amount > 0));
    const status = iPay && !friend.placeholder ? "pending" : "confirmed";
    const batchId = newId();
    const date = new Date();

    await inTransaction(async (tx) => {
      for (const [i, p] of legs.entries()) {
        const [from, to] = iPay ? [meId, friendId] : [friendId, meId];
        const created = await tx.settlement.create({
          data: {
            groupId: p.groupId,
            fromId: from,
            toId: to,
            amount: Math.abs(p.amount),
            note,
            date,
            status,
            batchId,
            createdById: meId,
            idempotencyKey: `${key}:${i}`,
          },
          select: { id: true },
        });
        await activityService.record(tx, {
          groupId: p.groupId,
          actor: meId,
          type: "payment_recorded",
          data: { from, to, amount: Math.abs(p.amount), settlementId: created.id },
        });
      }
    });
    legs.forEach((p) => publish(p.groupId, meId));
    return { batchId, replayed: false, legs: legs.length, status };
  },

  /** The receiver answers a whole batch at once. */
  async respond(meId: string, batchId: string, accept: boolean) {
    if (!isId(batchId)) throw new AppError(404, "Payment not found");
    const legs = await prisma.settlement.findMany({ where: { batchId, status: "pending", deletedAt: null } });
    if (legs.length === 0) throw new AppError(409, "This payment was already answered");
    if (legs.some((s) => s.toId !== meId)) {
      throw new AppError(403, "Only the person who received this payment can confirm or reject it");
    }
    await inTransaction(async (tx) => {
      const res = await tx.settlement.updateMany({
        where: { batchId, status: "pending", deletedAt: null },
        data: { status: accept ? "confirmed" : "rejected", respondedAt: new Date() },
      });
      if (res.count !== legs.length) throw new AppError(409, "This payment was already answered");
      for (const s of legs) {
        await activityService.record(tx, {
          groupId: s.groupId,
          actor: meId,
          type: accept ? "payment_confirmed" : "payment_rejected",
          data: { from: s.fromId, to: s.toId, amount: s.amount, settlementId: s.id },
        });
      }
    });
    legs.forEach((s) => publish(s.groupId, meId));
    return { amount: legs.reduce((t, s) => t + s.amount, 0), groups: legs.length };
  },
};
