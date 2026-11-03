import { isValidObjectId, Types } from "mongoose";
import { GroupModel } from "../group/group.model";
import { UserModel } from "../user/user.model";
import { SettlementModel } from "../settlement/settlement.model";
import { balanceService, simplifyDebts } from "../balance/balance.service";
import { activityService } from "../activity/activity.service";
import { publish } from "../events/events";
import { AppError } from "../../utils/AppError";
import { inTransaction } from "../../utils/transaction";

/*
 * Friends: everyone I share a group with, and where I stand with each of them
 * across all those groups. Each group's amount is that group's suggested payment
 * between the two of us, so it always matches what the group page says.
 */

type Part = { groupId: string; groupName: string; amount: number }; // + they owe me, − I owe them

async function myGroups(meId: string) {
  return GroupModel.find({ "members.userId": meId, closedAt: null }, "name members").lean();
}

/** Per friend, per group: what the group page suggests between us. */
async function ledger(meId: string) {
  const groups = await myGroups(meId);
  const parts = new Map<string, Part[]>();
  const friendIds = new Set<string>();
  for (const g of groups) {
    for (const m of g.members) if (String(m.userId) !== meId) friendIds.add(String(m.userId));
    for (const p of simplifyDebts(await balanceService.netBalances(g._id))) {
      const other = p.from === meId ? p.to : p.to === meId ? p.from : null;
      if (!other) continue;
      const amount = p.from === meId ? -p.amount : p.amount;
      friendIds.add(other);
      parts.set(other, [...(parts.get(other) ?? []), { groupId: String(g._id), groupName: g.name, amount }]);
    }
  }
  return { groups, parts, friendIds };
}

export const friendService = {
  async list(meId: string) {
    const { parts, friendIds } = await ledger(meId);
    const ids = [...friendIds];
    const [users, pending] = await Promise.all([
      UserModel.find({ _id: { $in: ids } }, "name upiId placeholder avatar").lean(),
      // Batches from the Friends page still waiting for an answer
      SettlementModel.find({
        batchId: { $ne: null },
        status: "pending",
        deletedAt: null,
        $or: [{ from: meId }, { to: meId }],
      }).lean(),
    ]);
    const batches = new Map<string, { id: string; from: string; to: string; amount: number; groups: number }>();
    for (const s of pending) {
      const id = String(s.batchId);
      const b = batches.get(id) ?? { id, from: String(s.from), to: String(s.to), amount: 0, groups: 0 };
      b.amount += s.amount;
      b.groups += 1;
      batches.set(id, b);
    }

    const friends = users.map((u) => {
      const id = String(u._id);
      const groups = parts.get(id) ?? [];
      return {
        id,
        name: u.name,
        upiId: u.upiId ?? null,
        placeholder: Boolean(u.placeholder),
        avatarUrl: u.avatar?.url ?? null,
        net: groups.reduce((t, p) => t + p.amount, 0),
        groups,
        pending: [...batches.values()]
          .filter((b) => b.from === id || b.to === id)
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
    if (!isValidObjectId(friendId) || friendId === meId) throw new AppError(404, "Friend not found");

    // Same click sent twice? Return the first batch.
    const prev = await SettlementModel.findOne({ createdBy: meId, idempotencyKey: `${key}:0` }).lean();
    if (prev?.batchId) return { batchId: String(prev.batchId), replayed: true };

    const { parts } = await ledger(meId);
    const groups = parts.get(friendId) ?? [];
    if (groups.length === 0) throw new AppError(400, "You’re all settled up with them");
    const net = groups.reduce((t, p) => t + p.amount, 0);
    if (net === 0) throw new AppError(400, "What you owe each other cancels out. Settle in each group instead.");
    const iPay = net < 0;
    const friend = await UserModel.findById(friendId, "placeholder").lean();
    if (!friend) throw new AppError(404, "Friend not found");
    // Groups where the money goes the other way are left for the group page
    const legs = groups.filter((p) => (iPay ? p.amount < 0 : p.amount > 0));
    const status = iPay && !friend.placeholder ? "pending" : "confirmed";
    const batchId = new Types.ObjectId();
    const date = new Date();

    await inTransaction(async (session) => {
      for (const [i, p] of legs.entries()) {
        const [from, to] = iPay ? [meId, friendId] : [friendId, meId];
        const [created] = await SettlementModel.create(
          [
            {
              groupId: p.groupId,
              from,
              to,
              amount: Math.abs(p.amount),
              note,
              date,
              status,
              batchId,
              createdBy: meId,
              idempotencyKey: `${key}:${i}`,
            },
          ],
          { session },
        );
        await activityService.record(session, {
          groupId: new Types.ObjectId(p.groupId),
          actor: meId,
          type: "payment_recorded",
          data: { from, to, amount: Math.abs(p.amount), settlementId: created!._id },
        });
      }
    });
    legs.forEach((p) => publish(p.groupId, meId));
    return { batchId: String(batchId), replayed: false, legs: legs.length, status };
  },

  /** The receiver answers a whole batch at once. */
  async respond(meId: string, batchId: string, accept: boolean) {
    if (!isValidObjectId(batchId)) throw new AppError(404, "Payment not found");
    const legs = await SettlementModel.find({ batchId, status: "pending", deletedAt: null }).lean();
    if (legs.length === 0) throw new AppError(409, "This payment was already answered");
    if (legs.some((s) => String(s.to) !== meId)) {
      throw new AppError(403, "Only the person who received this payment can confirm or reject it");
    }
    await inTransaction(async (session) => {
      const res = await SettlementModel.updateMany(
        { batchId, status: "pending", deletedAt: null },
        { $set: { status: accept ? "confirmed" : "rejected", respondedAt: new Date() } },
        { session },
      );
      if (res.modifiedCount !== legs.length) throw new AppError(409, "This payment was already answered");
      for (const s of legs) {
        await activityService.record(session, {
          groupId: s.groupId,
          actor: meId,
          type: accept ? "payment_confirmed" : "payment_rejected",
          data: { from: s.from, to: s.to, amount: s.amount, settlementId: s._id },
        });
      }
    });
    legs.forEach((s) => publish(String(s.groupId), meId));
    return { amount: legs.reduce((t, s) => t + s.amount, 0), groups: legs.length };
  },
};
