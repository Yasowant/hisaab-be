import { prisma } from "../../config/db";
import { Prisma } from "../../generated/prisma/client";
import { StoredItem, StoredOriginal } from "./expense.model";
import { GroupDoc } from "../group/group.model";
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
import { inTransaction, type Tx } from "../../utils/transaction";
import { isId } from "../../utils/id";

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
  const memberIds = new Set(group.members.map((m) => m.userId));

  // Paid from the kitty → the kitty holder is the payer
  let paidBy = input.paidBy;
  if (input.fromKitty) {
    if (!group.kittyHolderId) throw new AppError(400, "This group doesn't have a kitty");
    paidBy = group.kittyHolderId;
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


/** Everything the API shows for an expense, loaded in one query. */
const expenseInclude = {
  paidBy: { select: { id: true, name: true } },
  disputeBy: { select: { id: true, name: true } },
  splits: { orderBy: { position: "asc" }, include: { user: { select: { id: true, name: true } } } },
  receipt: { select: { contentType: true } },
  _count: { select: { comments: { where: { deletedAt: null } } } },
} satisfies Prisma.ExpenseInclude;

type Loaded = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;

/** Loads one expense with names filled in. */
async function findOne(groupId: string, expenseId: string) {
  if (!isId(expenseId)) return null;
  return prisma.expense.findFirst({ where: { id: expenseId, groupId, deletedAt: null }, include: expenseInclude });
}

function toDTO(e: Loaded) {
  const items = e.items as StoredItem[] | null;
  const original = e.original as StoredOriginal | null;
  return {
    id: e.id,
    description: e.description,
    amount: e.amount,
    paidBy: { id: e.paidBy.id, name: e.paidBy.name },
    splitType: e.splitType,
    splits: e.splits.map((s) => ({
      userId: s.user.id,
      name: s.user.name,
      amount: s.amount,
      ...(s.percent !== null ? { percent: s.percent } : {}),
    })),
    items: items?.map((i) => ({ name: i.name, amount: i.amount, sharedBy: i.sharedBy.map(String) })) ?? null,
    extras: e.extras ?? null,
    category: e.category,
    date: e.date,
    fromKitty: e.fromKitty,
    original: original ? { currency: original.currency, amount: original.amount, rate: original.rate } : null,
    recurringId: e.recurringId ?? null,
    commentCount: e._count.comments,
    dispute: e.disputeBy
      ? { by: { id: e.disputeBy.id, name: e.disputeBy.name }, reason: e.disputeReason ?? "", at: e.disputeAt }
      : null,
    hasReceipt: Boolean(e.receipt),
    receiptType: e.receipt ? (e.receipt.contentType === "application/pdf" ? "pdf" : "image") : null,
    createdBy: e.createdById,
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** The person who added it, the person who paid, or a group admin can change it. */
function ensureCanChange(e: { createdById: string; paidById: string }, userId: string, role: string) {
  const allowed = role === "admin" || e.createdById === userId || e.paidById === userId;
  if (!allowed) {
    throw new AppError(403, "Only the person who added or paid for this, or a group admin, can change it");
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

type Fields = ReturnType<typeof toFields>;

/** The columns for an expense (splits are saved separately). */
function columns(fields: Fields) {
  return {
    description: fields.description,
    amount: fields.amount,
    paidById: fields.paidBy,
    splitType: fields.splitType,
    category: fields.category,
    date: fields.date,
    fromKitty: fields.fromKitty,
    original: fields.original ?? Prisma.DbNull,
    // Switching away from itemized clears the stored lines
    items: fields.items ?? Prisma.DbNull,
    extras: fields.extras ?? null,
  };
}

const splitRows = (fields: Fields) =>
  fields.splits.map((s, i) => ({ userId: s.userId, amount: s.amount, percent: s.percent ?? null, position: i }));

/** Insert an expense + its activity entry in the caller's transaction. Used by create and by repeats. */
export async function insertExpense(
  tx: Tx,
  group: GroupDoc,
  actorId: string,
  fields: Fields,
  extra: { recurringId?: string } = {},
) {
  const created = await tx.expense.create({
    data: {
      ...columns(fields),
      groupId: group.id,
      createdById: actorId,
      recurringId: extra.recurringId ?? null,
      splits: { create: splitRows(fields) },
    },
    select: { id: true },
  });
  await activityService.record(tx, {
    groupId: group.id,
    actor: actorId,
    type: "expense_added",
    data: { description: fields.description, amount: fields.amount, expenseId: created.id },
  });
  return created;
}

export const expenseService = {
  async create(group: GroupDoc, userId: string, input: CreateExpenseInput) {
    const { repeat, ...rest } = input;
    const fields = toFields(rest as ExpenseInput, group);

    // The expense, its activity entry and (if asked) its repeat schedule save together
    const id = await inTransaction(async (tx) => {
      let recurringId: string | undefined;
      if (repeat !== "none") {
        // Imported here to avoid a circular import at load time
        const { recurringService } = await import("../recurring/recurring.service");
        recurringId = await recurringService.createFrom(tx, group, userId, rest as ExpenseInput, repeat);
      }
      const created = await insertExpense(tx, group, userId, fields, { recurringId });
      return created.id;
    });
    return toDTO((await findOne(group.id, id))!);
  },

  async list(group: GroupDoc, query: ListExpensesQuery) {
    const { page, limit, q, category, paidBy, involving, from, to, disputed } = query;
    const where: Prisma.ExpenseWhereInput = { groupId: group.id, deletedAt: null };
    if (q) where.description = { contains: q, mode: "insensitive" };
    if (category) where.category = category;
    if (paidBy) where.paidById = paidBy;
    if (involving) where.OR = [{ paidById: involving }, { splits: { some: { userId: involving } } }];
    if (disputed === "true") where.disputeById = { not: null };
    if (from || to) {
      where.date = {
        ...(from ? { gte: from } : {}),
        // "to" is a calendar day: include the whole of it
        ...(to ? { lt: new Date(to.getTime() + DAY_MS) } : {}),
      };
    }

    const [docs, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        orderBy: [{ date: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: expenseInclude,
      }),
      prisma.expense.count({ where }),
    ]);

    return {
      items: docs.map(toDTO),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  async getOne(group: GroupDoc, expenseId: string) {
    const e = await findOne(group.id, expenseId);
    if (!e) throw new AppError(404, "Expense not found");
    return toDTO(e);
  },

  async update(group: GroupDoc, userId: string, role: string, expenseId: string, input: UpdateExpenseInput) {
    const current = await findOne(group.id, expenseId);
    if (!current) throw new AppError(404, "Expense not found");
    ensureCanChange(current, userId, role);

    const { version, ...rest } = input;
    const fields = toFields(rest as ExpenseInput, group);

    await inTransaction(async (tx) => {
      // Only saves if nobody else saved since this client loaded it (its version still matches)
      const updated = await tx.expense.updateMany({
        where: { id: expenseId, groupId: group.id, deletedAt: null, version },
        data: { ...columns(fields), version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new AppError(409, "Someone else changed this expense. Reload it and try again.");
      }
      await tx.expenseSplit.deleteMany({ where: { expenseId } });
      await tx.expenseSplit.createMany({ data: splitRows(fields).map((r) => ({ ...r, expenseId })) });
      await activityService.record(tx, {
        groupId: group.id,
        actor: userId,
        type: "expense_updated",
        data: {
          description: fields.description,
          amount: fields.amount,
          previousAmount: current.amount,
          expenseId: current.id,
        },
      });
    });
    return this.getOne(group, expenseId);
  },

  async remove(group: GroupDoc, userId: string, role: string, expenseId: string) {
    const current = await findOne(group.id, expenseId);
    if (!current) throw new AppError(404, "Expense not found");
    ensureCanChange(current, userId, role);

    // Soft delete: the history stays, balances skip it
    await inTransaction(async (tx) => {
      const res = await tx.expense.updateMany({
        where: { id: expenseId, deletedAt: null },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      if (res.count === 0) throw new AppError(404, "Expense not found");
      await activityService.record(tx, {
        groupId: group.id,
        actor: userId,
        type: "expense_deleted",
        data: { description: current.description, amount: current.amount, expenseId: current.id },
      });
    });
  },

  /** "Something's wrong": any member can flag an expense once. It still counts until it's changed. */
  async dispute(group: GroupDoc, userId: string, expenseId: string, reason: string) {
    const current = await findOne(group.id, expenseId);
    if (!current) throw new AppError(404, "Expense not found");
    await inTransaction(async (tx) => {
      const res = await tx.expense.updateMany({
        where: { id: expenseId, groupId: group.id, deletedAt: null, disputeById: null },
        data: { disputeById: userId, disputeReason: reason, disputeAt: new Date() },
      });
      if (res.count === 0) throw new AppError(409, "This expense is already flagged");
      // The reason starts the conversation in the comments
      await tx.comment.create({ data: { groupId: group.id, expenseId, userId, text: `Flagged: ${reason}` } });
      await activityService.record(tx, {
        groupId: group.id,
        actor: userId,
        type: "expense_disputed",
        data: { description: current.description, amount: current.amount, text: reason, expenseId: current.id },
      });
    });
    return this.getOne(group, expenseId);
  },

  /** Clear the flag: the person who flagged it, or anyone who can change the expense. */
  async resolveDispute(group: GroupDoc, userId: string, role: string, expenseId: string, note?: string) {
    const current = await findOne(group.id, expenseId);
    if (!current) throw new AppError(404, "Expense not found");
    if (!current.disputeById) throw new AppError(409, "This expense isn’t flagged");
    const flaggedBy = current.disputeById;
    if (flaggedBy !== userId) ensureCanChange(current, userId, role);

    await inTransaction(async (tx) => {
      const res = await tx.expense.updateMany({
        where: { id: expenseId, groupId: group.id, disputeById: flaggedBy },
        data: { disputeById: null, disputeReason: null, disputeAt: null },
      });
      if (res.count === 0) throw new AppError(409, "Someone already sorted this out");
      await tx.comment.create({
        data: { groupId: group.id, expenseId, userId, text: note ? `Sorted: ${note}` : "Marked as sorted" },
      });
      await activityService.record(tx, {
        groupId: group.id,
        actor: userId,
        type: "dispute_resolved",
        data: { description: current.description, from: flaggedBy, text: note, expenseId: current.id },
      });
    });
    return this.getOne(group, expenseId);
  },
};
