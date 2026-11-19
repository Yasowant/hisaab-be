import { prisma } from "../../config/db";
import { GroupDoc, loadGroup, MAX_MEMBERS, membersInclude } from "./group.model";
import { AppError } from "../../utils/AppError";
import { newInviteCode } from "../../utils/inviteCode";
import { formatPaise } from "../../utils/money";
import { isUniqueViolation } from "../../utils/dbErrors";
import { inTransaction } from "../../utils/transaction";
import { balanceService } from "../balance/balance.service";
import {
  ChangeRoleInput,
  CreateGroupInput,
  UpdateGroupInput,
} from "./group.schema";

/** Invite codes are random; on the rare clash with an existing code, try again. */
async function withFreshInviteCode<T>(
  fn: (code: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn(newInviteCode());
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AppError(500, "Could not create an invite code. Try again.");
}

const summary = (g: GroupDoc, userId: string) => ({
  id: g.id,
  name: g.name,
  type: g.type,
  memberCount: g.members.length,
  myRole: g.members.find((m) => m.userId === userId)?.role ?? "member",
  settleBy: g.settleBy ?? null,
  closedAt: g.closedAt ?? null,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
});

export const groupService = {
  async create(userId: string, input: CreateGroupInput) {
    const group = await withFreshInviteCode((inviteCode) =>
      prisma.group.create({
        data: {
          ...input,
          inviteCode,
          createdById: userId,
          members: { create: [{ userId, role: "admin" }] },
        },
        include: membersInclude,
      }),
    );
    return { ...summary(group, userId), inviteCode: group.inviteCode };
  },

  async listMine(userId: string) {
    const groups = await prisma.group.findMany({
      where: { members: { some: { userId } } },
      orderBy: { updatedAt: "desc" },
      include: membersInclude,
    });
    return groups.map((g) => summary(g, userId));
  },

  async getDetails(group: GroupDoc, userId: string) {
    const users = await prisma.user.findMany({
      where: { id: { in: group.members.map((m) => m.userId) } },
      select: { id: true, name: true, email: true, placeholder: true, upiId: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const members = group.members.map((m) => {
      const u = byId.get(m.userId)!;
      return {
        id: u.id,
        name: u.name,
        // Placeholders have a made-up address; don't show it
        email: u.placeholder ? null : u.email,
        role: m.role,
        joinedAt: m.joinedAt,
        placeholder: u.placeholder,
        upiId: u.upiId ?? null,
        avatarUrl: u.avatarUrl ?? null,
      };
    });
    return {
      ...summary(group, userId),
      inviteCode: group.inviteCode,
      budget: group.budget ?? null,
      kittyHolderId: group.kittyHolderId ?? null,
      closedBy: group.closedById ?? null,
      members,
    };
  },

  async update(group: GroupDoc, userId: string, input: UpdateGroupInput) {
    const data: {
      name?: string;
      type?: GroupDoc["type"];
      budget?: number | null;
      settleBy?: Date | null;
      kittyHolderId?: string | null;
    } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.type !== undefined) data.type = input.type;
    if (input.budget !== undefined) data.budget = input.budget;
    if (input.settleBy !== undefined) data.settleBy = input.settleBy;
    if (input.kittyHolderId !== undefined) {
      if (input.kittyHolderId !== null) {
        const holder = group.members.find((m) => m.userId === input.kittyHolderId);
        if (!holder) throw new AppError(400, "The kitty holder must be in this group");
        const holderUser = await prisma.user.findUnique({ where: { id: input.kittyHolderId }, select: { placeholder: true } });
        if (holderUser?.placeholder) throw new AppError(400, "Pick someone who is on Hisaab to hold the kitty");
      }
      data.kittyHolderId = input.kittyHolderId;
    }

    const saved = input.regenerateInviteCode
      ? // The old link stops working straight away
        await withFreshInviteCode((inviteCode) =>
          prisma.group.update({ where: { id: group.id }, data: { ...data, inviteCode }, include: membersInclude }),
        )
      : await prisma.group.update({ where: { id: group.id }, data, include: membersInclude });
    return { ...summary(saved, userId), inviteCode: saved.inviteCode };
  },

  async join(userId: string, inviteCode: string) {
    // One transaction with the group row locked: adds me only if I'm not in yet, it isn't full and isn't closed
    const result = await inTransaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string; closedAt: Date | null }[]>`
        SELECT id, "closedAt" FROM "Group" WHERE "inviteCode" = ${inviteCode} FOR UPDATE`;
      if (!locked) throw new AppError(404, "This invite link is not valid. Ask for a new one.");
      const group = (await loadGroup(locked.id, tx))!;
      if (group.members.some((m) => m.userId === userId)) return { group, alreadyMember: true };
      if (locked.closedAt) throw new AppError(409, "This group is closed, so nobody new can join.");
      if (group.members.length >= MAX_MEMBERS) throw new AppError(409, `This group is full (${MAX_MEMBERS} members)`);
      await tx.groupMember.create({ data: { groupId: group.id, userId, role: "member" } });
      // Bump updatedAt so the group moves to the top of the list
      await tx.group.update({ where: { id: group.id }, data: { updatedAt: new Date() } });
      return { group: (await loadGroup(group.id, tx))!, alreadyMember: false };
    });
    return { group: summary(result.group, userId), alreadyMember: result.alreadyMember };
  },

  async changeRole(
    group: GroupDoc,
    targetUserId: string,
    { role }: ChangeRoleInput,
  ) {
    const target = group.members.find((m) => m.userId === targetUserId);
    if (!target) throw new AppError(404, "That person is not in this group");

    const admins = group.members.filter((m) => m.role === "admin").length;
    if (target.role === "admin" && role === "member" && admins === 1) {
      throw new AppError(
        409,
        "A group needs at least one admin. Make someone else admin first.",
      );
    }

    await prisma.groupMember.update({
      where: { groupId_userId: { groupId: group.id, userId: targetUserId } },
      data: { role },
    });
  },

  /** An admin can remove anyone; anyone can remove themselves (leave). */
  async removeMember(
    group: GroupDoc,
    actorId: string,
    actorRole: string,
    targetUserId: string,
  ) {
    const leaving = actorId === targetUserId;
    if (!leaving && actorRole !== "admin") {
      throw new AppError(403, "Only group admins can remove members");
    }

    const removed = group.members.find((m) => m.userId === targetUserId);
    if (!removed) throw new AppError(404, "That person is not in this group");

    // Nobody leaves (or is removed) while money is still owed either way
    const net = await balanceService.memberNet(group.id, targetUserId);
    if (net !== 0) {
      throw new AppError(
        409,
        leaving
          ? `Settle up first: your balance in this group is ${formatPaise(Math.abs(net))}.`
          : `This member still has a ${formatPaise(Math.abs(net))} balance here. Settle up first.`,
      );
    }

    const rest = group.members.filter((m) => m.userId !== targetUserId);

    return inTransaction(async (tx) => {
      // Last person out: the group goes too (its expenses, payments and feed with it)
      if (rest.length === 0) {
        await tx.group.delete({ where: { id: group.id } });
        return { groupDeleted: true };
      }

      await tx.groupMember.delete({ where: { groupId_userId: { groupId: group.id, userId: targetUserId } } });

      // The kitty holder left: the kitty is switched off (an admin can pick a new holder)
      if (group.kittyHolderId === targetUserId) {
        await tx.group.update({ where: { id: group.id }, data: { kittyHolderId: null } });
      }

      // Last admin left: the longest-standing member becomes admin
      if (removed.role === "admin" && !rest.some((m) => m.role === "admin")) {
        const oldest = [...rest].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0]!;
        await tx.groupMember.update({
          where: { groupId_userId: { groupId: group.id, userId: oldest.userId } },
          data: { role: "admin" },
        });
      }
      return { groupDeleted: false };
    });
  },

  /** Close a finished trip. Only when everyone is settled and nothing is waiting for confirmation. */
  async close(group: GroupDoc, actorId: string) {
    if (group.closedAt) throw new AppError(409, "This group is already closed");
    const nets = await balanceService.netBalances(group.id);
    if ([...nets.values()].some((n) => n !== 0)) {
      throw new AppError(409, "Settle up first: someone still owes money in this group.");
    }
    const pending = await prisma.settlement.findFirst({
      where: { groupId: group.id, status: "pending", deletedAt: null },
      select: { id: true },
    });
    if (pending) throw new AppError(409, "A payment is still waiting for confirmation. Confirm or undo it first.");
    const saved = await prisma.group.update({
      where: { id: group.id },
      data: { closedAt: new Date(), closedById: actorId, settleBy: null },
      include: membersInclude,
    });
    return { ...summary(saved, actorId), inviteCode: saved.inviteCode };
  },

  async reopen(group: GroupDoc, actorId: string) {
    if (!group.closedAt) throw new AppError(409, "This group isn’t closed");
    const saved = await prisma.group.update({
      where: { id: group.id },
      data: { closedAt: null, closedById: null },
      include: membersInclude,
    });
    return { ...summary(saved, actorId), inviteCode: saved.inviteCode };
  },
};
