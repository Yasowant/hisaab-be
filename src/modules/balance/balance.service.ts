import { prisma } from "../../config/db";
import { COUNTED } from "../settlement/settlement.model";
import { GroupDoc } from "../group/group.model";
import type { Db } from "../../utils/transaction";

export type Payment = { from: string; to: string; amount: number };

const n = (v: number | bigint | null | undefined) => Number(v ?? 0);

/**
 * Net balance per person in a group, in paise.
 * Positive = the group owes them. Negative = they owe the group.
 *   net = paid for expenses − their shares + payments sent − payments received
 * The nets of a group always add up to exactly 0.
 */
async function netBalances(groupId: string, db: Db = prisma): Promise<Map<string, number>> {
  const live = { groupId, deletedAt: null };
  const counted = { groupId, ...COUNTED };

  const [paid, shares, sent, received] = await Promise.all([
    db.expense.groupBy({ by: ["paidById"], where: live, _sum: { amount: true } }),
    db.expenseSplit.groupBy({ by: ["userId"], where: { expense: live }, _sum: { amount: true } }),
    // Only payments the receiver confirmed count
    db.settlement.groupBy({ by: ["fromId"], where: counted, _sum: { amount: true } }),
    db.settlement.groupBy({ by: ["toId"], where: counted, _sum: { amount: true } }),
  ]);

  const net = new Map<string, number>();
  const add = (id: string, amount: number) => net.set(id, (net.get(id) ?? 0) + amount);
  for (const r of paid) add(r.paidById, n(r._sum.amount));
  for (const r of shares) add(r.userId, -n(r._sum.amount));
  for (const r of sent) add(r.fromId, n(r._sum.amount));
  for (const r of received) add(r.toId, -n(r._sum.amount));
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

const personSelect = { id: true, name: true, upiId: true, placeholder: true, avatarUrl: true } as const;
type PersonRow = { id: string; name: string; upiId: string | null; placeholder: boolean; avatarUrl: string | null };

export const balanceService = {
  netBalances,

  /** One person's balance in one group (used to stop people leaving with a balance). */
  async memberNet(groupId: string, userId: string) {
    return (await netBalances(groupId)).get(userId) ?? 0;
  },

  /** Everything the group page needs: balances, who should pay whom, pending payments, the kitty. */
  async forGroup(group: GroupDoc, meId: string) {
    const net = await netBalances(group.id);
    const memberIds = group.members.map((m) => m.userId);

    // Payments waiting for the receiver to confirm (they don't count yet)
    const pendingDocs = await prisma.settlement.findMany({
      where: { groupId: group.id, deletedAt: null, status: "pending" },
      orderBy: { createdAt: "desc" },
    });

    // Include anyone with a non-zero balance, even if no longer a member
    const ids = [...new Set([...memberIds, ...net.keys()])];
    const lookup = [...new Set([...ids, ...pendingDocs.flatMap((p) => [p.fromId, p.toId]), ...(group.kittyHolderId ? [group.kittyHolderId] : [])])];
    const users: PersonRow[] = await prisma.user.findMany({ where: { id: { in: lookup } }, select: personSelect });
    const byId = new Map(users.map((u) => [u.id, u]));
    const person = (id: string) => ({
      id,
      name: byId.get(id)?.name ?? "Former member",
      upiId: byId.get(id)?.upiId ?? null,
      placeholder: Boolean(byId.get(id)?.placeholder),
      avatarUrl: byId.get(id)?.avatarUrl ?? null,
    });

    const balances = ids
      .map((id) => ({ ...person(id), net: net.get(id) ?? 0, isMember: memberIds.includes(id) }))
      .filter((b) => b.isMember || b.net !== 0)
      .sort((a, b) => b.net - a.net);

    const suggestions = simplifyDebts(net).map((p) => ({ from: person(p.from), to: person(p.to), amount: p.amount }));

    const pending = pendingDocs.map((p) => ({
      id: p.id,
      from: person(p.fromId),
      to: person(p.toId),
      amount: p.amount,
      kind: p.kind,
      note: p.note,
      createdBy: p.createdById,
      createdAt: p.createdAt,
    }));

    // Trip kitty: money put in (confirmed) vs. spent from it
    let kitty = null;
    if (group.kittyHolderId) {
      const [inRow, outRow] = await Promise.all([
        prisma.settlement.aggregate({ where: { groupId: group.id, kind: "kitty", ...COUNTED }, _sum: { amount: true } }),
        prisma.expense.aggregate({ where: { groupId: group.id, deletedAt: null, fromKitty: true }, _sum: { amount: true } }),
      ]);
      const collected = n(inRow._sum.amount);
      const spent = n(outRow._sum.amount);
      kitty = { holder: person(group.kittyHolderId), collected, spent, remaining: collected - spent };
    }

    return { balances, suggestions, pending, kitty, myNet: net.get(meId) ?? 0 };
  },

  /** Dashboard totals across every group I'm in. */
  async summaryFor(userId: string) {
    const memberships = await prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } });
    const groupIds = memberships.map((g) => g.groupId);

    const [paidRows, shareRows, sentRows, gotRows] = await Promise.all([
      // What I paid for expenses, per group
      prisma.expense.groupBy({
        by: ["groupId"],
        where: { groupId: { in: groupIds }, deletedAt: null, paidById: userId },
        _sum: { amount: true },
      }),
      // My shares of expenses, per group
      groupIds.length
        ? prisma.$queryRaw<{ groupId: string; total: bigint }[]>`
            SELECT e."groupId", SUM(s.amount)::bigint AS total
            FROM "ExpenseSplit" s JOIN "Expense" e ON e.id = s."expenseId"
            WHERE s."userId" = ${userId} AND e."deletedAt" IS NULL AND e."groupId" = ANY(${groupIds})
            GROUP BY e."groupId"`
        : Promise.resolve([]),
      // Payments I sent count for me, payments I received count against
      prisma.settlement.groupBy({ by: ["groupId"], where: { groupId: { in: groupIds }, ...COUNTED, fromId: userId }, _sum: { amount: true } }),
      prisma.settlement.groupBy({ by: ["groupId"], where: { groupId: { in: groupIds }, ...COUNTED, toId: userId }, _sum: { amount: true } }),
    ]);

    const byGroup = new Map<string, number>();
    const add = (id: string, amount: number) => byGroup.set(id, (byGroup.get(id) ?? 0) + amount);
    for (const r of paidRows) add(r.groupId, n(r._sum.amount));
    for (const r of shareRows) add(r.groupId, -n(r.total));
    for (const r of sentRows) add(r.groupId, n(r._sum.amount));
    for (const r of gotRows) add(r.groupId, -n(r._sum.amount));

    const nets = [...byGroup.values()];
    return {
      owedToYou: nets.filter((v) => v > 0).reduce((a, b) => a + b, 0),
      youOwe: -nets.filter((v) => v < 0).reduce((a, b) => a + b, 0),
      groups: groupIds.map((id) => ({ groupId: id, net: byGroup.get(id) ?? 0 })),
    };
  },
};
