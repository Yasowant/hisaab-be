import { prisma } from "../../config/db";
import { GroupDoc } from "../group/group.model";

const n = (v: number | bigint | null | undefined) => Number(v ?? 0);

const rupees = (paise: number) => (paise / 100).toFixed(2);

/** Stops spreadsheet apps treating a cell as a formula (=, +, -, @ at the start). */
function cell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const line = (values: unknown[]) => values.map(cell).join(",");
const day = (d: Date) => d.toISOString().slice(0, 10);

export const statsService = {
  /** Where the money went: by category, by who paid, by month, plus the budget. */
  async forGroup(group: GroupDoc, meId: string) {
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 11, 1);
    since.setUTCHours(0, 0, 0, 0);
    const live = { groupId: group.id, deletedAt: null };

    const [totals, byCategoryRows, byPayerRows, byMonthRows, shareRows, mine] = await Promise.all([
      prisma.expense.aggregate({ where: live, _sum: { amount: true }, _count: { _all: true }, _min: { date: true }, _max: { date: true } }),
      prisma.expense.groupBy({ by: ["category"], where: live, _sum: { amount: true } }),
      prisma.expense.groupBy({ by: ["paidById"], where: live, _sum: { amount: true } }),
      prisma.$queryRaw<{ month: string; total: bigint }[]>`
        SELECT to_char(date AT TIME ZONE 'UTC', 'YYYY-MM') AS month, SUM(amount)::bigint AS total
        FROM "Expense"
        WHERE "groupId" = ${group.id} AND "deletedAt" IS NULL AND date >= ${since}
        GROUP BY 1`,
      prisma.expenseSplit.groupBy({ by: ["userId"], where: { expense: live }, _sum: { amount: true } }),
      prisma.expenseSplit.aggregate({ where: { userId: meId, expense: live }, _sum: { amount: true } }),
    ]);

    const byPayer = byPayerRows.map((r) => ({ id: r.paidById, total: n(r._sum.amount) })).sort((a, b) => b.total - a.total);
    const users = await prisma.user.findMany({
      where: { id: { in: [...byPayer.map((r) => r.id), ...shareRows.map((r) => r.userId)] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    // Fill the months with no spending so the chart has no gaps
    const monthTotals = new Map(byMonthRows.map((r) => [r.month, n(r.total)]));
    const byMonth = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(since);
      d.setUTCMonth(since.getUTCMonth() + i);
      const key = d.toISOString().slice(0, 7);
      byMonth.push({ month: key, total: monthTotals.get(key) ?? 0 });
    }

    return {
      total: n(totals._sum.amount),
      count: totals._count._all,
      myShare: n(mine._sum.amount),
      budget: group.budget ?? null,
      byCategory: byCategoryRows
        .map((r) => ({ category: String(r.category), total: n(r._sum.amount) }))
        .sort((a, b) => b.total - a.total),
      byPayer: byPayer.map((r) => ({
        id: r.id,
        name: nameOf.get(r.id) ?? "Former member",
        total: r.total,
      })),
      byMonth,
      // For the final summary of a closed trip: what each person paid and what their share was
      byPerson: shareRows
        .map((r) => ({
          id: r.userId,
          name: nameOf.get(r.userId) ?? "Former member",
          share: n(r._sum.amount),
          paid: byPayer.find((p) => p.id === r.userId)?.total ?? 0,
        }))
        .sort((a, b) => b.share - a.share),
      firstDate: totals._min.date ?? null,
      lastDate: totals._max.date ?? null,
    };
  },

  /** Every expense (with each person's share) and every payment, as a CSV spreadsheet. */
  async csv(group: GroupDoc) {
    const named = { select: { name: true } } as const;
    const [expenses, payments] = await Promise.all([
      prisma.expense.findMany({
        where: { groupId: group.id, deletedAt: null },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        include: { paidBy: named, splits: { orderBy: { position: "asc" } } },
      }),
      prisma.settlement.findMany({
        where: { groupId: group.id, deletedAt: null, status: { not: "rejected" } },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        include: { from: named, to: named },
      }),
    ]);

    // One column per person who appears in any split (members and former members)
    const ids = [...new Set([...group.members.map((m) => m.userId), ...expenses.flatMap((e) => e.splits.map((s) => s.userId))])];
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    const out: string[] = [];
    out.push(line([`${group.name}: expenses`]));
    out.push(line(["Date", "Description", "Category", "Split", "Paid by", "Amount (INR)", ...ids.map((id) => `${nameOf.get(id) ?? "Former member"}'s share`)]));
    for (const e of expenses) {
      const share = new Map(e.splits.map((s) => [s.userId, s.amount]));
      out.push(
        line([
          day(e.date),
          e.description + (e.fromKitty ? " (from kitty)" : ""),
          e.category,
          e.splitType,
          e.paidBy.name,
          rupees(e.amount),
          ...ids.map((id) => (share.has(id) ? rupees(share.get(id)!) : "")),
        ]),
      );
    }
    out.push("");
    out.push(line(["Payments"]));
    out.push(line(["Date", "From", "To", "Amount (INR)", "Type", "Status", "Note"]));
    for (const p of payments) {
      out.push(line([day(p.date), p.from.name, p.to.name, rupees(p.amount), p.kind, p.status, p.note ?? ""]));
    }
    // Byte-order mark so Excel opens ₹ and names in other scripts correctly
    return "\ufeff" + out.join("\r\n") + "\r\n";
  },
};
