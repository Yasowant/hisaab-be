import { isValidObjectId, Types, type ClientSession } from "mongoose";
import { ExpenseModel } from "./expense.model";
import { GroupDoc } from "../group/group.model";
import { CommentModel } from "../comment/comment.model";
import { AppError } from "../../utils/AppError";
import {
  formatPaise,
  splitByPercent,
  splitByWeights,
  splitEqual,
  sum,
  type Share,
} from "../../utils/money";
import { CreateExpenseInput, ExpenseInput, ListExpensesQuery, UpdateExpenseInput } from "./expense.schema";
import { activityService } from "../activity/activity.service";
import { inTransaction } from "../../utils/transaction";

type Named = { _id: Types.ObjectId; name: string };

type StoredSplit = Share & { percent?: number };

/** Turn the request into the exact paise each person owes. */
function buildSplits(input: ExpenseInput, memberIds: Set<string>): StoredSplit[] {
  const ensureMember = (id: string) => {
    if (!memberIds.has(id)) throw new AppError(400, `User ${id} is not in this group`);
  };
  ensureMember(input.paidBy);

  if (input.splitType === "equal") {
    input.participants.forEach(ensureMember);
    return splitEqual(input.amount, input.participants);
  }

  if (input.splitType === "exact") {
    input.splits.forEach((s) => ensureMember(s.userId));
    const total = sum(input.splits.map((s) => s.amount));
    if (total !== input.amount) {
      throw new AppError(
        400,
        `Shares add up to ${formatPaise(total)} but the expense is ${formatPaise(input.amount)}`,
      );
    }
    return input.splits.map((s) => ({ userId: s.userId, amount: s.amount }));
  }

  if (input.splitType === "itemized") {
    // 1. Each item is split equally between the people who shared it
    const subtotal = new Map<string, number>();
    for (const item of input.items) {
      item.sharedBy.forEach(ensureMember);
      for (const s of splitEqual(item.amount, item.sharedBy)) {
        subtotal.set(s.userId, (subtotal.get(s.userId) ?? 0) + s.amount);
      }
    }
    const itemsTotal = sum(input.items.map((i) => i.amount));
    if (itemsTotal + input.extras !== input.amount) {
      throw new AppError(
        400,
        `Items (${formatPaise(itemsTotal)}) plus tax and tip (${formatPaise(input.extras)}) must add up to ${formatPaise(input.amount)}`,
      );
    }
    // 2. Tax, service and tip are shared in proportion to what each person had
    const people = [...subtotal.keys()];
    const extras = splitByWeights(
      input.extras,
      people.map((userId) => ({ userId, weight: subtotal.get(userId)! })),
    );
    return people.map((userId, i) => ({ userId, amount: subtotal.get(userId)! + extras[i]!.amount }));
  }

  input.splits.forEach((s) => ensureMember(s.userId));
  const totalBp = sum(input.splits.map((s) => Math.round(s.percent * 100)));
  if (totalBp !== 10_000) {
    throw new AppError(400, `Percentages add up to ${totalBp / 100}%. They need to make 100%.`);
  }
  const shares = splitByPercent(input.amount, input.splits);
  return shares.map((s, i) => ({ ...s, percent: input.splits[i]!.percent }));
}

export function toFields(input: ExpenseInput, group: GroupDoc) {
  const memberIds = new Set(group.members.map((m) => String(m.userId)));

  // Paid from the kitty → the kitty holder is the payer
  let paidBy = input.paidBy;
  if (input.fromKitty) {
    if (!group.kittyHolderId) throw new AppError(400, "This group doesn't have a kitty");
    paidBy = String(group.kittyHolderId);
  }
  const resolved = { ...input, paidBy } as ExpenseInput;

  // Foreign currency: the rupee amount must be the bill times the rate
  if (input.original && Math.abs(Math.round(input.original.amount * input.original.rate) - input.amount) > 1) {
    throw new AppError(400, "The rupee amount doesn't match the bill and exchange rate");
  }

  return {
    description: input.description,
    amount: input.amount,
    paidBy,
    splitType: input.splitType,
    splits: buildSplits(resolved, memberIds),
    category: input.category,
    date: input.date,
    fromKitty: input.fromKitty,
    original: input.original ?? null,
    items: input.splitType === "itemized" ? input.items : undefined,
    extras: input.splitType === "itemized" ? input.extras : undefined,
  };
}

const populated = <T>(q: T) => q;

/** Loads one expense with names filled in, shaped for the API. */
async function findOne(groupId: Types.ObjectId | string, expenseId: string) {
  if (!isValidObjectId(expenseId)) return null;
  return populated(
    ExpenseModel.findOne({ _id: expenseId, groupId, deletedAt: null })
      .populate<{ paidBy: Named }>("paidBy", "name")
      .populate<{ splits: { userId: Named; amount: number; percent?: number }[] }>("splits.userId", "name")
      .populate<{ dispute: { by: Named; reason: string; at: Date } | null }>("dispute.by", "name")
      .lean(),
  );
}

type Loaded = NonNullable<Awaited<ReturnType<typeof findOne>>>;

function toDTO(e: Loaded, commentCount = 0) {
  return {
    id: String(e._id),
    description: e.description,
    amount: e.amount,
    paidBy: { id: String(e.paidBy._id), name: e.paidBy.name },
    splitType: e.splitType,
    splits: e.splits.map((s) => ({
      userId: String(s.userId._id),
      name: s.userId.name,
      amount: s.amount,
      ...(s.percent !== undefined && s.percent !== null ? { percent: s.percent } : {}),
    })),
    items: e.items?.map((i) => ({ name: i.name, amount: i.amount, sharedBy: i.sharedBy.map(String) })) ?? null,
    extras: e.extras ?? null,
    category: e.category,
    date: e.date,
    fromKitty: Boolean(e.fromKitty),
    original: e.original ? { currency: e.original.currency, amount: e.original.amount, rate: e.original.rate } : null,
    recurringId: e.recurringId ? String(e.recurringId) : null,
    commentCount,
    dispute: e.dispute?.by
      ? { by: { id: String(e.dispute.by._id), name: e.dispute.by.name }, reason: e.dispute.reason, at: e.dispute.at }
      : null,
    hasReceipt: Boolean(e.receipt),
    receiptType: e.receipt ? (e.receipt.contentType === "application/pdf" ? "pdf" : "image") : null,
    createdBy: String(e.createdBy),
    version: e.__v,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** The person who added it, the person who paid, or a group admin can change it. */
function ensureCanChange(e: { createdBy: unknown; paidBy: { _id: unknown } }, userId: string, role: string) {
  const allowed = role === "admin" || String(e.createdBy) === userId || String(e.paidBy._id) === userId;
  if (!allowed) {
    throw new AppError(403, "Only the person who added or paid for this, or a group admin, can change it");
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Insert an expense + its activity entry in the caller's transaction. Used by create and by repeats. */
export async function insertExpense(
  session: ClientSession,
  group: GroupDoc,
  actorId: string,
  fields: ReturnType<typeof toFields>,
  extra: { recurringId?: Types.ObjectId } = {},
) {
  const [created] = await ExpenseModel.create([{ ...fields, ...extra, groupId: group._id, createdBy: actorId }], {
    session,
  });
  await activityService.record(session, {
    groupId: group._id,
    actor: actorId,
    type: "expense_added",
    data: { description: fields.description, amount: fields.amount, expenseId: created!._id },
  });
  return created!;
}

export const expenseService = {
  async create(group: GroupDoc, userId: string, input: CreateExpenseInput) {
    const { repeat, ...rest } = input;
    const fields = toFields(rest as ExpenseInput, group);

    // The expense, its activity entry and (if asked) its repeat schedule save together
    const id = await inTransaction(async (session) => {
      let recurringId: Types.ObjectId | undefined;
      if (repeat !== "none") {
        // Imported here to avoid a circular import at load time
        const { recurringService } = await import("../recurring/recurring.service");
        recurringId = await recurringService.createFrom(session, group, userId, rest as ExpenseInput, repeat);
      }
      const created = await insertExpense(session, group, userId, fields, { recurringId });
      return created.id as string;
    });
    return toDTO((await findOne(group._id, id))!);
  },

  async list(group: GroupDoc, query: ListExpensesQuery) {
    const { page, limit, q, category, paidBy, involving, from, to, disputed } = query;
    const filter: Record<string, unknown> = { groupId: group._id, deletedAt: null };
    if (q) filter.description = { $regex: escapeRegex(q), $options: "i" };
    if (category) filter.category = category;
    if (paidBy) filter.paidBy = paidBy;
    if (involving) filter.$or = [{ paidBy: involving }, { "splits.userId": involving }];
    if (disputed === "true") filter.dispute = { $ne: null };
    if (from || to) {
      filter.date = {
        ...(from ? { $gte: from } : {}),
        // "to" is a calendar day: include the whole of it
        ...(to ? { $lt: new Date(to.getTime() + DAY_MS) } : {}),
      };
    }

    const [docs, total] = await Promise.all([
      ExpenseModel.find(filter)
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate<{ paidBy: Named }>("paidBy", "name")
        .populate<{ splits: { userId: Named; amount: number; percent?: number }[] }>("splits.userId", "name")
        .populate<{ dispute: { by: Named; reason: string; at: Date } | null }>("dispute.by", "name")
        .lean(),
      ExpenseModel.countDocuments(filter),
    ]);

    // Comment counts for just this page of expenses, in one query
    const counts = await CommentModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { expenseId: { $in: docs.map((d) => d._id) }, deletedAt: null } },
      { $group: { _id: "$expenseId", n: { $sum: 1 } } },
    ]);
    const countOf = new Map(counts.map((c) => [String(c._id), c.n]));

    return {
      items: docs.map((d) => toDTO(d, countOf.get(String(d._id)) ?? 0)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  async getOne(group: GroupDoc, expenseId: string) {
    const e = await findOne(group._id, expenseId);
    if (!e) throw new AppError(404, "Expense not found");
    const commentCount = await CommentModel.countDocuments({ expenseId: e._id, deletedAt: null });
    return toDTO(e, commentCount);
  },

  async update(group: GroupDoc, userId: string, role: string, expenseId: string, input: UpdateExpenseInput) {
    const current = await findOne(group._id, expenseId);
    if (!current) throw new AppError(404, "Expense not found");
    ensureCanChange(current, userId, role);

    const { version, ...rest } = input;
    const fields = toFields(rest as ExpenseInput, group);
    // Switching away from itemized clears the stored lines
    const unset = rest.splitType === "itemized" ? {} : { items: 1, extras: 1 };
    const { items, extras, ...plain } = fields;
    const set = rest.splitType === "itemized" ? { ...plain, items, extras } : plain;

    await inTransaction(async (session) => {
      // Only saves if nobody else saved since this client loaded it (its __v still matches)
      const updated = await ExpenseModel.findOneAndUpdate(
        { _id: expenseId, groupId: group._id, deletedAt: null, __v: version },
        { $set: set, $unset: unset, $inc: { __v: 1 } },
        { returnDocument: "after", runValidators: true, session },
      );
      if (!updated) {
        throw new AppError(409, "Someone else changed this expense. Reload it and try again.");
      }
      await activityService.record(session, {
        groupId: group._id,
        actor: userId,
        type: "expense_updated",
        data: {
          description: fields.description,
          amount: fields.amount,
          previousAmount: current.amount,
          expenseId: current._id,
        },
      });
    });
    return this.getOne(group, expenseId);
  },

  async remove(group: GroupDoc, userId: string, role: string, expenseId: string) {
    const current = await findOne(group._id, expenseId);
    if (!current) throw new AppError(404, "Expense not found");
    ensureCanChange(current, userId, role);

    // Soft delete: the history stays, balances skip it
    await inTransaction(async (session) => {
      const res = await ExpenseModel.updateOne(
        { _id: expenseId, deletedAt: null },
        { $set: { deletedAt: new Date() }, $inc: { __v: 1 } },
        { session },
      );
      if (res.modifiedCount === 0) throw new AppError(404, "Expense not found");
      await activityService.record(session, {
        groupId: group._id,
        actor: userId,
        type: "expense_deleted",
        data: { description: current.description, amount: current.amount, expenseId: current._id },
      });
    });
  },

  /** "Something's wrong": any member can flag an expense once. It still counts until it's changed. */
  async dispute(group: GroupDoc, userId: string, expenseId: string, reason: string) {
    const current = await findOne(group._id, expenseId);
    if (!current) throw new AppError(404, "Expense not found");
    await inTransaction(async (session) => {
      const res = await ExpenseModel.updateOne(
        { _id: expenseId, groupId: group._id, deletedAt: null, dispute: null },
        { $set: { dispute: { by: userId, reason, at: new Date() } } },
        { session },
      );
      if (res.modifiedCount === 0) throw new AppError(409, "This expense is already flagged");
      // The reason starts the conversation in the comments
      await CommentModel.create([{ groupId: group._id, expenseId, userId, text: `Flagged: ${reason}` }], { session });
      await activityService.record(session, {
        groupId: group._id,
        actor: userId,
        type: "expense_disputed",
        data: { description: current.description, amount: current.amount, text: reason, expenseId: current._id },
      });
    });
    return this.getOne(group, expenseId);
  },

  /** Clear the flag: the person who flagged it, or anyone who can change the expense. */
  async resolveDispute(group: GroupDoc, userId: string, role: string, expenseId: string, note?: string) {
    const current = await findOne(group._id, expenseId);
    if (!current) throw new AppError(404, "Expense not found");
    if (!current.dispute) throw new AppError(409, "This expense isn’t flagged");
    const flaggedBy = String(current.dispute.by._id);
    if (flaggedBy !== userId) ensureCanChange(current, userId, role);

    await inTransaction(async (session) => {
      const res = await ExpenseModel.updateOne(
        { _id: expenseId, groupId: group._id, "dispute.by": current.dispute!.by._id },
        { $set: { dispute: null } },
        { session },
      );
      if (res.modifiedCount === 0) throw new AppError(409, "Someone already sorted this out");
      await CommentModel.create(
        [{ groupId: group._id, expenseId, userId, text: note ? `Sorted: ${note}` : "Marked as sorted" }],
        { session },
      );
      await activityService.record(session, {
        groupId: group._id,
        actor: userId,
        type: "dispute_resolved",
        data: { description: current.description, from: flaggedBy, text: note, expenseId: current._id },
      });
    });
    return this.getOne(group, expenseId);
  },
};
