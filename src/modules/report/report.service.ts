import { prisma } from "../../config/db";

/** First day of a "YYYY-MM" month and of the month after, in UTC (expense dates are UTC days). */
function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)), prevStart: new Date(Date.UTC(y, m - 2, 1)) };
}

type MyExpense = {
  id: string;
  groupId: string;
  description: string;
  category: string;
  date: Date;
  amount: number;
  paidById: string;
  share: number;
};

export const reportService = {
  /**
   * What I personally spent in one month, across every group: my share of each
   * expense (not what I paid up front, which others may owe me back).
   */
  async monthly(userId: string, month: string) {
    const { start, end, prevStart } = monthRange(month);

    // Every expense I have a share in this month, with my share. Small enough to total up here.
    const [rows, [prev]] = await Promise.all([
      prisma.$queryRaw<MyExpense[]>`
        SELECT e.id, e."groupId", e.description, e.category::text AS category, e.date, e.amount, e."paidById", s.amount AS share
        FROM "Expense" e JOIN "ExpenseSplit" s ON s."expenseId" = e.id AND s."userId" = ${userId}
        WHERE e."deletedAt" IS NULL AND e.date >= ${start} AND e.date < ${end}`,
      prisma.$queryRaw<{ total: bigint | null }[]>`
        SELECT SUM(s.amount)::bigint AS total
        FROM "Expense" e JOIN "ExpenseSplit" s ON s."expenseId" = e.id AND s."userId" = ${userId}
        WHERE e."deletedAt" IS NULL AND e.date >= ${prevStart} AND e.date < ${start}`,
    ]);

    const totalBy = <K>(key: (r: MyExpense) => K) => {
      const m = new Map<K, number>();
      for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.share);
      return [...m].map(([k, total]) => ({ key: k, total })).sort((a, b) => b.total - a.total);
    };
    const byCategory = totalBy((r) => r.category);
    const byGroup = totalBy((r) => r.groupId);
    const perDay = new Map(totalBy((r) => r.date.getUTCDate()).map((d) => [d.key, d.total]));
    const top = [...rows].sort((a, b) => b.share - a.share || b.date.getTime() - a.date.getTime()).slice(0, 5);

    const groupIds = [...new Set([...byGroup.map((g) => g.key), ...top.map((t) => t.groupId)])];
    const groups = await prisma.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } });
    const nameOf = new Map(groups.map((g) => [g.id, g.name]));
    const groupName = (id: string) => nameOf.get(id) ?? "A group you left";

    const daysInMonth = Math.round((end.getTime() - start.getTime()) / 86_400_000);

    return {
      month,
      total: rows.reduce((t, r) => t + r.share, 0),
      count: rows.length,
      paidUpFront: rows.filter((r) => r.paidById === userId).reduce((t, r) => t + r.amount, 0),
      previousTotal: Number(prev?.total ?? 0),
      byCategory: byCategory.map((c) => ({ category: c.key, total: c.total })),
      byGroup: byGroup.map((g) => ({ groupId: g.key, name: groupName(g.key), total: g.total })),
      byDay: Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, total: perDay.get(i + 1) ?? 0 })),
      top: top.map((t) => ({
        id: t.id,
        description: t.description,
        groupId: t.groupId,
        groupName: groupName(t.groupId),
        date: t.date,
        amount: t.amount,
        share: t.share,
      })),
    };
  },
};
