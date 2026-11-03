import { Types } from "mongoose";
import { ExpenseModel } from "../expense/expense.model";
import { GroupModel } from "../group/group.model";

type Row = { _id: unknown; total: number };

/** First day of a "YYYY-MM" month and of the month after, in UTC (expense dates are UTC days). */
function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)), prevStart: new Date(Date.UTC(y, m - 2, 1)) };
}

export const reportService = {
  /**
   * What I personally spent in one month, across every group: my share of each
   * expense (not what I paid up front, which others may owe me back).
   */
  async monthly(userId: string, month: string) {
    const me = new Types.ObjectId(userId);
    const { start, end, prevStart } = monthRange(month);

    const [facets] = await ExpenseModel.aggregate<{
      totals: { total: number; count: number }[];
      byCategory: Row[];
      byGroup: Row[];
      byDay: Row[];
      top: { _id: Types.ObjectId; description: string; groupId: Types.ObjectId; date: Date; amount: number; share: number }[];
      paid: { total: number }[];
    }>([
      { $match: { deletedAt: null, "splits.userId": me, date: { $gte: start, $lt: end } } },
      { $set: { share: { $sum: { $map: { input: { $filter: { input: "$splits", cond: { $eq: ["$$this.userId", me] } } }, in: "$$this.amount" } } } } },
      {
        $facet: {
          totals: [{ $group: { _id: null, total: { $sum: "$share" }, count: { $sum: 1 } } }],
          byCategory: [{ $group: { _id: "$category", total: { $sum: "$share" } } }, { $sort: { total: -1 } }],
          byGroup: [{ $group: { _id: "$groupId", total: { $sum: "$share" } } }, { $sort: { total: -1 } }],
          byDay: [{ $group: { _id: { $dayOfMonth: "$date" }, total: { $sum: "$share" } } }, { $sort: { _id: 1 } }],
          top: [{ $sort: { share: -1, date: -1 } }, { $limit: 5 }, { $project: { description: 1, groupId: 1, date: 1, amount: 1, share: 1 } }],
          paid: [{ $match: { paidBy: me } }, { $group: { _id: null, total: { $sum: "$amount" } } }],
        },
      },
    ]);

    const [prev] = await ExpenseModel.aggregate<{ total: number }>([
      { $match: { deletedAt: null, "splits.userId": me, date: { $gte: prevStart, $lt: start } } },
      { $unwind: "$splits" },
      { $match: { "splits.userId": me } },
      { $group: { _id: null, total: { $sum: "$splits.amount" } } },
    ]);

    const groupIds = [...(facets?.byGroup ?? []).map((g) => g._id), ...(facets?.top ?? []).map((t) => t.groupId)];
    const groups = await GroupModel.find({ _id: { $in: groupIds } }, "name").lean();
    const nameOf = new Map(groups.map((g) => [String(g._id), g.name]));
    const groupName = (id: unknown) => nameOf.get(String(id)) ?? "A group you left";

    const daysInMonth = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    const perDay = new Map((facets?.byDay ?? []).map((d) => [Number(d._id), d.total]));

    return {
      month,
      total: facets?.totals[0]?.total ?? 0,
      count: facets?.totals[0]?.count ?? 0,
      paidUpFront: facets?.paid[0]?.total ?? 0,
      previousTotal: prev?.total ?? 0,
      byCategory: (facets?.byCategory ?? []).map((c) => ({ category: String(c._id), total: c.total })),
      byGroup: (facets?.byGroup ?? []).map((g) => ({ groupId: String(g._id), name: groupName(g._id), total: g.total })),
      byDay: Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, total: perDay.get(i + 1) ?? 0 })),
      top: (facets?.top ?? []).map((t) => ({
        id: String(t._id),
        description: t.description,
        groupId: String(t.groupId),
        groupName: groupName(t.groupId),
        date: t.date,
        amount: t.amount,
        share: t.share,
      })),
    };
  },
};
