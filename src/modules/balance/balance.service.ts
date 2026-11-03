import { Types } from "mongoose";
import { ExpenseModel } from "../expense/expense.model";
import { COUNTED, SettlementModel } from "../settlement/settlement.model";
import { GroupDoc, GroupModel } from "../group/group.model";
import { UserModel } from "../user/user.model";

type Totals = { _id: Types.ObjectId; total: number }[];
export type Payment = { from: string; to: string; amount: number };

const toId = (id: Types.ObjectId | string) => (typeof id === "string" ? new Types.ObjectId(id) : id);

/**
 * Net balance per person in a group, in paise.
 * Positive = the group owes them. Negative = they owe the group.
 *   net = paid for expenses − their shares + payments sent − payments received
 * The nets of a group always add up to exactly 0.
 */
async function netBalances(groupId: Types.ObjectId | string): Promise<Map<string, number>> {
  const gid = toId(groupId); // aggregate() doesn't cast strings, so pass a real ObjectId

  const [[expenses], [payments]] = await Promise.all([
    ExpenseModel.aggregate<{ paid: Totals; share: Totals }>([
      { $match: { groupId: gid, deletedAt: null } },
      {
        $facet: {
          paid: [{ $group: { _id: "$paidBy", total: { $sum: "$amount" } } }],
          share: [
            { $unwind: "$splits" },
            { $group: { _id: "$splits.userId", total: { $sum: "$splits.amount" } } },
          ],
        },
      },
    ]),
    SettlementModel.aggregate<{ sent: Totals; received: Totals }>([
      // Only payments the receiver confirmed count
      { $match: { groupId: gid, ...COUNTED } },
      {
        $facet: {
          sent: [{ $group: { _id: "$from", total: { $sum: "$amount" } } }],
          received: [{ $group: { _id: "$to", total: { $sum: "$amount" } } }],
        },
      },
    ]),
  ]);

  const net = new Map<string, number>();
  const add = (rows: Totals | undefined, sign: 1 | -1) => {
    for (const r of rows ?? []) {
      const id = String(r._id);
      net.set(id, (net.get(id) ?? 0) + sign * r.total);
    }
  };
  add(expenses?.paid, 1);
  add(expenses?.share, -1);
  add(payments?.sent, 1);
  add(payments?.received, -1);
  return net;
}

/**
 * Greedy debt simplification: the person who owes most pays the person owed most,
 * repeat until everyone is at 0. Each round clears at least one person, so a group
 * of n people never needs more than n − 1 payments.
 */
export function simplifyDebts(net: Map<string, number>): Payment[] {
  const creditors = [...net].filter(([, v]) => v > 0).map(([id, amount]) => ({ id, amount }));
  const debtors = [...net].filter(([, v]) => v < 0).map(([id, amount]) => ({ id, amount: -amount }));
  const payments: Payment[] = [];

  while (creditors.length && debtors.length) {
    creditors.sort((a, b) => b.amount - a.amount);
    debtors.sort((a, b) => b.amount - a.amount);
    const c = creditors[0]!;
    const d = debtors[0]!;
    const amount = Math.min(c.amount, d.amount);

    payments.push({ from: d.id, to: c.id, amount });
    c.amount -= amount;
    d.amount -= amount;
    if (c.amount === 0) creditors.shift();
    if (d.amount === 0) debtors.shift();
  }
  return payments;
}

export const balanceService = {
  netBalances,

  /** One person's balance in one group (used to stop people leaving with a balance). */
  async memberNet(groupId: Types.ObjectId | string, userId: string) {
    return (await netBalances(groupId)).get(userId) ?? 0;
  },

  /** Everything the group page needs: balances, who should pay whom, pending payments, the kitty. */
  async forGroup(group: GroupDoc, meId: string) {
    const net = await netBalances(group._id);
    const memberIds = group.members.map((m) => String(m.userId));
    // Include anyone with a non-zero balance, even if no longer a member
    const ids = [...new Set([...memberIds, ...net.keys()])];
    const users = await UserModel.find({ _id: { $in: ids } }, "name upiId placeholder avatar").lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const person = (id: string) => ({
      id,
      name: byId.get(id)?.name ?? "Former member",
      upiId: byId.get(id)?.upiId ?? null,
      placeholder: Boolean(byId.get(id)?.placeholder),
      avatarUrl: byId.get(id)?.avatar?.url ?? null,
    });

    const balances = ids
      .map((id) => ({ ...person(id), net: net.get(id) ?? 0, isMember: memberIds.includes(id) }))
      .filter((b) => b.isMember || b.net !== 0)
      .sort((a, b) => b.net - a.net);

    const suggestions = simplifyDebts(net).map((p) => ({ from: person(p.from), to: person(p.to), amount: p.amount }));

    // Payments waiting for the receiver to confirm (they don't count yet)
    const pendingDocs = await SettlementModel.find({ groupId: group._id, deletedAt: null, status: "pending" })
      .sort({ createdAt: -1 })
      .lean();
    for (const p of pendingDocs) {
      for (const id of [String(p.from), String(p.to)]) {
        if (!byId.has(id)) {
          const u = await UserModel.findById(id, "name upiId placeholder avatar").lean();
          if (u) byId.set(id, u);
        }
      }
    }
    const pending = pendingDocs.map((p) => ({
      id: String(p._id),
      from: person(String(p.from)),
      to: person(String(p.to)),
      amount: p.amount,
      kind: p.kind ?? "payment",
      note: p.note,
      createdBy: String(p.createdBy),
      createdAt: p.createdAt,
    }));

    // Trip kitty: money put in (confirmed) vs. spent from it
    let kitty = null;
    if (group.kittyHolderId) {
      const holderId = String(group.kittyHolderId);
      const [[inRow], [outRow]] = await Promise.all([
        SettlementModel.aggregate<{ total: number }>([
          { $match: { groupId: group._id, kind: "kitty", ...COUNTED } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        ExpenseModel.aggregate<{ total: number }>([
          { $match: { groupId: group._id, deletedAt: null, fromKitty: true } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
      ]);
      const collected = inRow?.total ?? 0;
      const spent = outRow?.total ?? 0;
      kitty = { holder: person(holderId), collected, spent, remaining: collected - spent };
    }

    return { balances, suggestions, pending, kitty, myNet: net.get(meId) ?? 0 };
  },

  /** Dashboard totals across every group I'm in. */
  async summaryFor(userId: string) {
    const uid = toId(userId);
    const groups = await GroupModel.find({ "members.userId": uid }, "_id").lean();
    const groupIds = groups.map((g) => g._id);

    const [expenseRows, paymentRows] = await Promise.all([
      // For each group: what I paid minus my share, only from expenses I'm part of
      ExpenseModel.aggregate<{ _id: Types.ObjectId; net: number }>([
        {
          $match: {
            groupId: { $in: groupIds },
            deletedAt: null,
            $or: [{ paidBy: uid }, { "splits.userId": uid }],
          },
        },
        {
          $project: {
            groupId: 1,
            paid: { $cond: [{ $eq: ["$paidBy", uid] }, "$amount", 0] },
            share: {
              $sum: {
                $map: {
                  input: { $filter: { input: "$splits", cond: { $eq: ["$$this.userId", uid] } } },
                  in: "$$this.amount",
                },
              },
            },
          },
        },
        { $group: { _id: "$groupId", net: { $sum: { $subtract: ["$paid", "$share"] } } } },
      ]),
      // Payments I sent count for me, payments I received count against
      SettlementModel.aggregate<{ _id: Types.ObjectId; net: number }>([
        {
          $match: {
            groupId: { $in: groupIds },
            ...COUNTED,
            $or: [{ from: uid }, { to: uid }],
          },
        },
        {
          $group: {
            _id: "$groupId",
            net: { $sum: { $cond: [{ $eq: ["$from", uid] }, "$amount", { $multiply: ["$amount", -1] }] } },
          },
        },
      ]),
    ]);

    const byGroup = new Map<string, number>();
    for (const r of [...expenseRows, ...paymentRows]) {
      byGroup.set(String(r._id), (byGroup.get(String(r._id)) ?? 0) + r.net);
    }

    const nets = [...byGroup.values()];
    return {
      owedToYou: nets.filter((n) => n > 0).reduce((a, b) => a + b, 0),
      youOwe: -nets.filter((n) => n < 0).reduce((a, b) => a + b, 0),
      groups: groupIds.map((id) => ({ groupId: String(id), net: byGroup.get(String(id)) ?? 0 })),
    };
  },
};
