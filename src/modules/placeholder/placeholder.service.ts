import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { GroupDoc, MAX_MEMBERS } from "../group/group.model";
import { prisma } from "../../config/db";
import { Prisma } from "../../generated/prisma/client";
import { StoredItem } from "../expense/expense.model";
import { activityService } from "../activity/activity.service";
import { AppError } from "../../utils/AppError";
import { inTransaction, type Tx } from "../../utils/transaction";
import { isId, newId } from "../../utils/id";

/** Lock the group row so two adds/joins at once can't push it over the member limit. */
async function lockGroup(tx: Tx, groupId: string) {
  await tx.$queryRaw`SELECT id FROM "Group" WHERE id = ${groupId} FOR UPDATE`;
}

export const placeholderService = {
  /**
   * Add someone who isn't on Hisaab yet ("Mom", "Rohan"). They get a real
   * user row with a made-up address that can't log in, so expenses work as usual.
   */
  async add(group: GroupDoc, name: string) {
    if (group.members.length >= MAX_MEMBERS) throw new AppError(409, `This group is full (${MAX_MEMBERS} members)`);
    const id = newId();
    const password = await bcrypt.hash(randomBytes(24).toString("base64url"), 10); // nobody knows it
    return inTransaction(async (tx) => {
      await lockGroup(tx, group.id);
      const count = await tx.groupMember.count({ where: { groupId: group.id } });
      if (count >= MAX_MEMBERS) throw new AppError(409, `This group is full (${MAX_MEMBERS} members)`);
      await tx.user.create({
        data: { id, name, email: `placeholder+${id}@hisaab.invalid`, password, placeholder: true },
      });
      await tx.groupMember.create({ data: { groupId: group.id, userId: id, role: "member" } });
      return { id, name, placeholder: true };
    });
  },

  /**
   * "That's me": move everything recorded for the placeholder onto a real
   * member, then remove the placeholder. All in one transaction.
   */
  async claim(group: GroupDoc, actorId: string, actorRole: string, placeholderId: string, targetId = actorId) {
    if (!isId(placeholderId)) throw new AppError(404, "That person is not in this group");
    if (targetId !== actorId && actorRole !== "admin") {
      throw new AppError(403, "Only a group admin can link someone else");
    }
    const ids = new Set(group.members.map((m) => m.userId));
    if (!ids.has(placeholderId)) throw new AppError(404, "That person is not in this group");
    if (!ids.has(targetId)) throw new AppError(400, "Join the group first");

    const [p, target] = await Promise.all([
      prisma.user.findUnique({ where: { id: placeholderId }, select: { name: true, placeholder: true } }),
      prisma.user.findUnique({ where: { id: targetId }, select: { name: true, placeholder: true } }),
    ]);
    if (!p?.placeholder) throw new AppError(400, "This member already has an account");
    if (!target || target.placeholder) throw new AppError(400, "Pick someone who is on Hisaab");

    const P = placeholderId;
    const T = targetId;
    const swap = (id: string) => (id === P ? T : id);

    await inTransaction(async (tx) => {
      // Taking the placeholder out of the group first means a second claim at the same time fails here
      const pulled = await tx.groupMember.deleteMany({ where: { groupId: group.id, userId: P } });
      if (pulled.count === 0) throw new AppError(409, "Someone already claimed this member");

      // Expenses: payer, shares (merged if both were in it), item lines, creator
      const expenses = await tx.expense.findMany({
        where: {
          groupId: group.id,
          // Anyone on an item line also has a share, so this finds those too
          OR: [{ paidById: P }, { createdById: P }, { splits: { some: { userId: P } } }],
        },
        include: { splits: { orderBy: { position: "asc" } } },
      });
      for (const e of expenses) {
        const merged = new Map<string, { userId: string; amount: number; percent: number | null }>();
        for (const s of e.splits) {
          const uid = swap(s.userId);
          const prev = merged.get(uid);
          merged.set(uid, {
            userId: uid,
            amount: (prev?.amount ?? 0) + s.amount,
            percent: s.percent !== null ? (prev?.percent ?? 0) + s.percent : (prev?.percent ?? null),
          });
        }
        const items = (e.items as StoredItem[] | null)?.map((it) => ({
          name: it.name,
          amount: it.amount,
          sharedBy: [...new Set(it.sharedBy.map(swap))],
        }));
        await tx.expense.update({
          where: { id: e.id },
          data: {
            paidById: swap(e.paidById),
            createdById: swap(e.createdById),
            items: items ?? Prisma.DbNull,
            version: { increment: 1 },
          },
        });
        await tx.expenseSplit.deleteMany({ where: { expenseId: e.id } });
        await tx.expenseSplit.createMany({
          data: [...merged.values()].map((s, i) => ({ expenseId: e.id, ...s, position: i })),
        });
      }

      // Payments: a payment between the two of them becomes a payment to yourself, so it's dropped
      await tx.settlement.updateMany({ where: { groupId: group.id, fromId: P }, data: { fromId: T } });
      await tx.settlement.updateMany({ where: { groupId: group.id, toId: P }, data: { toId: T } });
      await tx.settlement.updateMany({ where: { groupId: group.id, createdById: P }, data: { createdById: T } });
      await tx.$executeRaw`
        UPDATE "Settlement" SET "deletedAt" = now(), "updatedAt" = now()
        WHERE "groupId" = ${group.id} AND "fromId" = "toId" AND "deletedAt" IS NULL`;

      await tx.activity.updateMany({ where: { groupId: group.id, actorId: P }, data: { actorId: T } });
      await tx.activity.updateMany({ where: { groupId: group.id, fromId: P }, data: { fromId: T } });
      await tx.activity.updateMany({ where: { groupId: group.id, toId: P }, data: { toId: T } });
      await tx.comment.updateMany({ where: { groupId: group.id, userId: P }, data: { userId: T } });

      // Repeating expenses keep their saved request; swap the id inside it
      const repeats = await tx.recurringExpense.findMany({ where: { groupId: group.id } });
      for (const r of repeats) {
        const json = JSON.stringify(r.template);
        if (!json.includes(P)) continue;
        let template = JSON.parse(json.split(P).join(T));
        // Equal split: don't list the same person twice
        if (Array.isArray(template.participants)) template = { ...template, participants: [...new Set(template.participants)] };
        await tx.recurringExpense.update({ where: { id: r.id }, data: { template } });
      }
      await tx.recurringExpense.updateMany({ where: { groupId: group.id, createdById: P }, data: { createdById: T } });

      // The placeholder row stays (old activity still shows a name) but is retired
      await tx.user.update({ where: { id: P }, data: { deletedAt: new Date() } });

      await activityService.record(tx, {
        groupId: group.id,
        actor: actorId,
        type: "member_claimed",
        data: { from: P, to: T, description: p.name },
      });
    });
  },
};
