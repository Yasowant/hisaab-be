import { isValidObjectId, Types } from "mongoose";
import { CommentModel } from "./comment.model";
import { ExpenseModel } from "../expense/expense.model";
import { GroupDoc } from "../group/group.model";
import { AppError } from "../../utils/AppError";
import { notificationService } from "../notification/notification.service";

type Named = { _id: Types.ObjectId; name: string };

async function ensureExpense(group: GroupDoc, expenseId: string) {
  if (!isValidObjectId(expenseId)) throw new AppError(404, "Expense not found");
  const exists = await ExpenseModel.exists({ _id: expenseId, groupId: group._id, deletedAt: null });
  if (!exists) throw new AppError(404, "Expense not found");
}

const toDTO = (c: { _id: Types.ObjectId; userId: Named; text: string; createdAt: Date }) => ({
  id: String(c._id),
  user: { id: String(c.userId._id), name: c.userId.name },
  text: c.text,
  createdAt: c.createdAt,
});

export const commentService = {
  async list(group: GroupDoc, expenseId: string) {
    await ensureExpense(group, expenseId);
    const docs = await CommentModel.find({ expenseId, deletedAt: null })
      .sort({ createdAt: 1 })
      .limit(200)
      .populate<{ userId: Named }>("userId", "name")
      .lean();
    return docs.map(toDTO);
  },

  async add(group: GroupDoc, userId: string, expenseId: string, text: string) {
    await ensureExpense(group, expenseId);
    const created = await CommentModel.create({ groupId: group._id, expenseId, userId, text });
    // Tell the people in the expense and everyone who commented before
    const [e, earlier] = await Promise.all([
      ExpenseModel.findById(expenseId, "description paidBy createdBy splits").lean(),
      CommentModel.distinct("userId", { expenseId, deletedAt: null }),
    ]);
    if (e) {
      await notificationService.notify({
        recipients: [e.paidBy, e.createdBy, ...e.splits.map((s) => s.userId), ...earlier],
        groupId: group._id,
        actor: userId,
        type: "comment_added",
        data: { description: e.description, text, expenseId },
      });
    }
    const doc = await CommentModel.findById(created._id).populate<{ userId: Named }>("userId", "name").lean();
    return toDTO(doc!);
  },

  /** The writer, or a group admin, can delete a comment. */
  async remove(group: GroupDoc, userId: string, role: string, expenseId: string, commentId: string) {
    if (!isValidObjectId(commentId)) throw new AppError(404, "Comment not found");
    const c = await CommentModel.findOne({ _id: commentId, expenseId, groupId: group._id, deletedAt: null });
    if (!c) throw new AppError(404, "Comment not found");
    if (role !== "admin" && String(c.userId) !== userId) {
      throw new AppError(403, "Only the person who wrote this, or a group admin, can delete it");
    }
    c.deletedAt = new Date();
    await c.save();
  },
};
