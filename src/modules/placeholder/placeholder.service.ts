import { randomBytes } from "node:crypto";
import { isValidObjectId, Types } from "mongoose";
import { GroupDoc, GroupModel, MAX_MEMBERS } from "../group/group.model";
import { UserModel } from "../user/user.model";
import { ExpenseModel } from "../expense/expense.model";
import { SettlementModel } from "../settlement/settlement.model";
import { ActivityModel } from "../activity/activity.model";
import { CommentModel } from "../comment/comment.model";
import { RecurringModel } from "../recurring/recurring.model";
import { activityService } from "../activity/activity.service";
import { AppError } from "../../utils/AppError";
import { inTransaction } from "../../utils/transaction";

const same = (a: unknown, b: string) => String(a) === b;

export const placeholderService = {
  /**
   * Add someone who isn't on Hisaab yet ("Mom", "Rohan"). They get a real
   * user row with a made-up address that can't log in, so expenses work as usual.
   */
  async add(group: GroupDoc, name: string) {
    if (group.members.length >= MAX_MEMBERS) throw new AppError(409, `This group is full (${MAX_MEMBERS} members)`);
    const id = new Types.ObjectId();
    return inTransaction(async (session) => {
      await UserModel.create(
        [
          {
            _id: id,
            name,
            email: `placeholder+${id}@hisaab.invalid`,
            password: randomBytes(24).toString("base64url"),
            placeholder: true,
          },
        ],
        { session },
      );
      const res = await GroupModel.updateOne(
        { _id: group._id, [`members.${MAX_MEMBERS - 1}`]: { $exists: false } },
        { $push: { members: { userId: id, role: "member", joinedAt: new Date() } } },
        { session },
      );
      if (res.modifiedCount === 0) throw new AppError(409, `This group is full (${MAX_MEMBERS} members)`);
      return { id: String(id), name, placeholder: true };
    });
  },

  /**
   * "That's me": move everything recorded for the placeholder onto a real
   * member, then remove the placeholder. All in one transaction.
   */
  async claim(group: GroupDoc, actorId: string, actorRole: string, placeholderId: string, targetId = actorId) {
    if (!isValidObjectId(placeholderId)) throw new AppError(404, "That person is not in this group");
    if (targetId !== actorId && actorRole !== "admin") {
      throw new AppError(403, "Only a group admin can link someone else");
    }
    const ids = new Set(group.members.map((m) => String(m.userId)));
    if (!ids.has(placeholderId)) throw new AppError(404, "That person is not in this group");
    if (!ids.has(targetId)) throw new AppError(400, "Join the group first");

    const [p, target] = await Promise.all([
      UserModel.findById(placeholderId, "name placeholder").lean(),
      UserModel.findById(targetId, "name placeholder").lean(),
    ]);
    if (!p?.placeholder) throw new AppError(400, "This member already has an account");
    if (!target || target.placeholder) throw new AppError(400, "Pick someone who is on Hisaab");

    const P = new Types.ObjectId(placeholderId);
    const T = new Types.ObjectId(targetId);

    await inTransaction(async (session) => {
      // Taking the placeholder out of the group first means a second claim at the same time fails here
      const pulled = await GroupModel.updateOne(
        { _id: group._id, "members.userId": P },
        { $pull: { members: { userId: P } } },
        { session },
      );
      if (pulled.modifiedCount === 0) throw new AppError(409, "Someone already claimed this member");

      // Expenses: payer, shares (merged if both were in it), item lines, creator
      const expenses = await ExpenseModel.find(
        { groupId: group._id, $or: [{ paidBy: P }, { createdBy: P }, { "splits.userId": P }, { "items.sharedBy": P }] },
        null,
        { session },
      ).lean();
      for (const e of expenses) {
        const merged = new Map<string, { userId: Types.ObjectId; amount: number; percent?: number }>();
        for (const s of e.splits) {
          const uid = same(s.userId, placeholderId) ? T : s.userId;
          const prev = merged.get(String(uid));
          merged.set(String(uid), {
            userId: uid,
            amount: (prev?.amount ?? 0) + s.amount,
            ...(s.percent !== undefined && s.percent !== null ? { percent: (prev?.percent ?? 0) + s.percent } : {}),
          });
        }
        const items = e.items?.map((it) => ({
          name: it.name,
          amount: it.amount,
          sharedBy: [...new Set(it.sharedBy.map((u) => (same(u, placeholderId) ? targetId : String(u))))].map(
            (u) => new Types.ObjectId(u),
          ),
        }));
        await ExpenseModel.updateOne(
          { _id: e._id },
          {
            $set: {
              paidBy: same(e.paidBy, placeholderId) ? T : e.paidBy,
              createdBy: same(e.createdBy, placeholderId) ? T : e.createdBy,
              splits: [...merged.values()],
              ...(items ? { items } : {}),
            },
            $inc: { __v: 1 },
          },
          { session },
        );
      }

      // Payments: a payment between the two of them becomes a payment to yourself, so it's dropped
      await SettlementModel.updateMany({ groupId: group._id, from: P }, { $set: { from: T } }, { session });
      await SettlementModel.updateMany({ groupId: group._id, to: P }, { $set: { to: T } }, { session });
      await SettlementModel.updateMany({ groupId: group._id, createdBy: P }, { $set: { createdBy: T } }, { session });
      await SettlementModel.updateMany(
        { groupId: group._id, $expr: { $eq: ["$from", "$to"] }, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { session },
      );

      await ActivityModel.updateMany({ groupId: group._id, actor: P }, { $set: { actor: T } }, { session });
      await ActivityModel.updateMany({ groupId: group._id, "data.from": P }, { $set: { "data.from": T } }, { session });
      await ActivityModel.updateMany({ groupId: group._id, "data.to": P }, { $set: { "data.to": T } }, { session });
      await CommentModel.updateMany({ groupId: group._id, userId: P }, { $set: { userId: T } }, { session });

      // Repeating expenses keep their saved request; swap the id inside it
      const repeats = await RecurringModel.find({ groupId: group._id }, null, { session }).lean();
      for (const r of repeats) {
        const json = JSON.stringify(r.template);
        if (!json.includes(placeholderId)) continue;
        let template = JSON.parse(json.split(placeholderId).join(targetId));
        // Equal split: don't list the same person twice
        if (Array.isArray(template.participants)) template = { ...template, participants: [...new Set(template.participants)] };
        await RecurringModel.updateOne({ _id: r._id }, { $set: { template } }, { session });
      }
      await RecurringModel.updateMany({ groupId: group._id, createdBy: P }, { $set: { createdBy: T } }, { session });

      // The placeholder row stays (old activity still shows a name) but is retired
      await UserModel.updateOne({ _id: P }, { $set: { deletedAt: new Date() } }, { session });

      await activityService.record(session, {
        groupId: group._id,
        actor: actorId,
        type: "member_claimed",
        data: { from: P, to: T, description: p.name },
      });
    });
  },
};
