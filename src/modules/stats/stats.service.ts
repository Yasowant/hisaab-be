import { Types } from "mongoose";
import { ExpenseModel } from "../expense/expense.model";
import { SettlementModel } from "../settlement/settlement.model";
import { GroupDoc } from "../group/group.model";
import { UserModel } from "../user/user.model";

type Row = { _id: unknown; total: number };
type Named = { _id: Types.ObjectId; name: string };

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
    const me = new Types.ObjectId(meId);
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 11, 1);
    since.setUTCHours(0, 0, 0, 0);

    const [facets] = await ExpenseModel.aggregate<{
      totals: { total: number; count: number }[];
      byCategory: Row[];
      byPayer: Row[];
      byMonth: Row[];
      mine: { total: number }[];
      shares: Row[];
      span: { first: Date; last: Date }[];
    }>([
      { $match: { groupId: group._id, deletedAt: null } },
      {
        $facet: {
          totals: [{ $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }],
          byCategory: [{ $group: { _id: "$category", total: { $sum: "$amount" } } }, { $sort: { total: -1 } }],
          byPayer: [{ $group: { _id: "$paidBy", total: { $sum: "$amount" } } }, { $sort: { total: -1 } }],
          byMonth: [
            { $match: { date: { $gte: since } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$date" } }, total: { $sum: "$amount" } } },
            { $sort: { _id: 1 } },
          ],
          shares: [{ $unwind: "$splits" }, { $group: { _id: "$splits.userId", total: { $sum: "$splits.amount" } } }],
          span: [{ $group: { _id: null, first: { $min: "$date" }, last: { $max: "$date" } } }],
          mine: [
            { $unwind: "$splits" },
            { $match: { "splits.userId": me } },
            { $group: { _id: null, total: { $sum: "$splits.amount" } } },
          ],
        },
      },
    ]);

    const payerIds = [...(facets?.byPayer ?? []).map((r) => r._id), ...(facets?.shares ?? []).map((r) => r._id)];
    const users = await UserModel.find({ _id: { $in: payerIds } }, "name").lean();
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));

    // Fill the months with no spending so the chart has no gaps
    const monthTotals = new Map((facets?.byMonth ?? []).map((r) => [String(r._id), r.total]));
    const byMonth = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(since);
      d.setUTCMonth(since.getUTCMonth() + i);
      const key = d.toISOString().slice(0, 7);
      byMonth.push({ month: key, total: monthTotals.get(key) ?? 0 });
    }

    const total = facets?.totals[0]?.total ?? 0;
    return {
      total,
      count: facets?.totals[0]?.count ?? 0,
      myShare: facets?.mine[0]?.total ?? 0,
      budget: group.budget ?? null,
      byCategory: (facets?.byCategory ?? []).map((r) => ({ category: String(r._id), total: r.total })),
      byPayer: (facets?.byPayer ?? []).map((r) => ({
        id: String(r._id),
        name: nameOf.get(String(r._id)) ?? "Former member",
        total: r.total,
      })),
      byMonth,
      // For the final summary of a closed trip: what each person paid and what their share was
      byPerson: (facets?.shares ?? [])
        .map((r) => ({
          id: String(r._id),
          name: nameOf.get(String(r._id)) ?? "Former member",
          share: r.total,
          paid: (facets?.byPayer ?? []).find((p) => String(p._id) === String(r._id))?.total ?? 0,
        }))
        .sort((a, b) => b.share - a.share),
      firstDate: facets?.span[0]?.first ?? null,
      lastDate: facets?.span[0]?.last ?? null,
    };
  },

  /** Every expense (with each person's share) and every payment, as a CSV spreadsheet. */
  async csv(group: GroupDoc) {
    const [expenses, payments] = await Promise.all([
      ExpenseModel.find({ groupId: group._id, deletedAt: null })
        .sort({ date: 1, _id: 1 })
        .populate<{ paidBy: Named }>("paidBy", "name")
        .lean(),
      SettlementModel.find({ groupId: group._id, deletedAt: null, status: { $ne: "rejected" as const } })
        .sort({ date: 1, _id: 1 })
        .populate<{ from: Named }>("from", "name")
        .populate<{ to: Named }>("to", "name")
        .lean(),
    ]);

    // One column per person who appears in any split (members and former members)
    const ids = [...new Set([...group.members.map((m) => String(m.userId)), ...expenses.flatMap((e) => e.splits.map((s) => String(s.userId)))])];
    const users = await UserModel.find({ _id: { $in: ids } }, "name").lean();
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));

    const out: string[] = [];
    out.push(line([`${group.name}: expenses`]));
    out.push(line(["Date", "Description", "Category", "Split", "Paid by", "Amount (INR)", ...ids.map((id) => `${nameOf.get(id) ?? "Former member"}'s share`)]));
    for (const e of expenses) {
      const share = new Map(e.splits.map((s) => [String(s.userId), s.amount]));
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
      out.push(
        line([day(p.date), p.from.name, p.to.name, rupees(p.amount), p.kind ?? "payment", p.status ?? "confirmed", p.note ?? ""]),
      );
    }
    // Byte-order mark so Excel opens ₹ and names in other scripts correctly
    return "﻿" + out.join("\r\n") + "\r\n";
  },
};
