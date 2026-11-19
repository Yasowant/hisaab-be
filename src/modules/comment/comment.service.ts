import { prisma } from "../../config/db";
import { GroupDoc } from "../group/group.model";
import { AppError } from "../../utils/AppError";
import { isId } from "../../utils/id";
import { notificationService } from "../notification/notification.service";

async function ensureExpense(group: GroupDoc, expenseId: string) {
  if (!isId(expenseId)) throw new AppError(404, "Expense not found");
  const exists = await prisma.expense.findFirst({ where: { id: expenseId, groupId: group.id, deletedAt: null }, select: { id: true } });
  if (!exists) throw new AppError(404, "Expense not found");
}

const withUser = { user: { select: { id: true, name: true } } } as const;

const toDTO = (c: { id: string; user: { id: string; name: string }; text: string; createdAt: Date }) => ({
  id: c.id,
  user: { id: c.user.id, name: c.user.name },
  text: c.text,
  createdAt: c.createdAt,
});

export const commentService = {
  async list(group: GroupDoc, expenseId: string) {
    await ensureExpense(group, expenseId);
    const docs = await prisma.comment.findMany({
      where: { expenseId, deletedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
      include: withUser,
    });
    return docs.map(toDTO);
  },

  async add(group: GroupDoc, userId: string, expenseId: string, text: string) {
    await ensureExpense(group, expenseId);
    const created = await prisma.comment.create({ data: { groupId: group.id, expenseId, userId, text }, include: withUser });
    // Tell the people in the expense and everyone who commented before
    const [e, earlier] = await Promise.all([
      prisma.expense.findUnique({
        where: { id: expenseId },
        select: { description: true, paidById: true, createdById: true, splits: { select: { userId: true } } },
      }),
      prisma.comment.findMany({ where: { expenseId, deletedAt: null }, distinct: ["userId"], select: { userId: true } }),
    ]);
    if (e) {
      await notificationService.notify({
        recipients: [e.paidById, e.createdById, ...e.splits.map((s) => s.userId), ...earlier.map((c) => c.userId)],
        groupId: group.id,
        actor: userId,
        type: "comment_added",
        data: { description: e.description, text, expenseId },
      });
    }
    return toDTO(created);
  },

  /** The writer, or a group admin, can delete a comment. */
  async remove(group: GroupDoc, userId: string, role: string, expenseId: string, commentId: string) {
    if (!isId(commentId)) throw new AppError(404, "Comment not found");
    const c = await prisma.comment.findFirst({ where: { id: commentId, expenseId, groupId: group.id, deletedAt: null } });
    if (!c) throw new AppError(404, "Comment not found");
    if (role !== "admin" && c.userId !== userId) {
      throw new AppError(403, "Only the person who wrote this, or a group admin, can delete it");
    }
    await prisma.comment.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
  },
};
