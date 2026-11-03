import { Types } from "mongoose";
import { GroupDoc, GroupModel, MAX_MEMBERS } from "./group.model";
import { AppError } from "../../utils/AppError";
import { newInviteCode } from "../../utils/inviteCode";
import { formatPaise } from "../../utils/money";
import { balanceService } from "../balance/balance.service";
import { UserModel } from "../user/user.model";
import { SettlementModel } from "../settlement/settlement.model";
import {
  ChangeRoleInput,
  CreateGroupInput,
  UpdateGroupInput,
} from "./group.schema";

type PopulatedUser = {
  _id: Types.ObjectId;
  name: string;
  email: string;
  placeholder?: boolean;
  upiId?: string | null;
  avatar?: { url: string } | null;
};

const isDuplicateKey = (err: unknown) =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: number }).code === 11000;

/** Invite codes are random; on the rare clash with an existing code, try again. */
async function withFreshInviteCode<T>(
  fn: (code: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn(newInviteCode());
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }
  throw new AppError(500, "Could not create an invite code. Try again.");
}

const summary = (g: GroupDoc, userId: string) => ({
  id: g.id as string,
  name: g.name,
  type: g.type,
  memberCount: g.members.length,
  // members.userId may be populated (getDetails), so compare ids, not objects
  myRole:
    g.members.find((m) => String((m.userId as unknown as { _id?: unknown })?._id ?? m.userId) === userId)?.role ?? "member",
  settleBy: g.settleBy ?? null,
  closedAt: g.closedAt ?? null,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
});

export const groupService = {
  async create(userId: string, input: CreateGroupInput) {
    const group = await withFreshInviteCode((inviteCode) =>
      GroupModel.create({
        ...input,
        inviteCode,
        createdBy: userId,
        members: [{ userId, role: "admin" }],
      }),
    );
    return { ...summary(group, userId), inviteCode: group.inviteCode };
  },

  async listMine(userId: string) {
    const groups = await GroupModel.find({ "members.userId": userId }).sort({
      updatedAt: -1,
    });
    return groups.map((g) => summary(g, userId));
  },

  async getDetails(group: GroupDoc, userId: string) {
    await group.populate<{ members: { userId: PopulatedUser }[] }>(
      "members.userId",
      "name email placeholder upiId avatar",
    );
    const members = group.members.map((m) => {
      const u = m.userId as unknown as PopulatedUser;
      return {
        id: String(u._id),
        name: u.name,
        // Placeholders have a made-up address; don't show it
        email: u.placeholder ? null : u.email,
        role: m.role,
        joinedAt: m.joinedAt,
        placeholder: Boolean(u.placeholder),
        upiId: u.upiId ?? null,
        avatarUrl: u.avatar?.url ?? null,
      };
    });
    return {
      ...summary(group, userId),
      inviteCode: group.inviteCode,
      budget: group.budget ?? null,
      kittyHolderId: group.kittyHolderId ? String(group.kittyHolderId) : null,
      closedBy: group.closedBy ? String(group.closedBy) : null,
      members,
    };
  },

  async update(group: GroupDoc, userId: string, input: UpdateGroupInput) {
    if (input.name !== undefined) group.name = input.name;
    if (input.type !== undefined) group.type = input.type;
    if (input.budget !== undefined) group.budget = input.budget;
    if (input.settleBy !== undefined) group.settleBy = input.settleBy;
    if (input.kittyHolderId !== undefined) {
      if (input.kittyHolderId !== null) {
        const holder = group.members.find((m) => String(m.userId) === input.kittyHolderId);
        if (!holder) throw new AppError(400, "The kitty holder must be in this group");
        const holderUser = await UserModel.findById(input.kittyHolderId, "placeholder").lean();
        if (holderUser?.placeholder) throw new AppError(400, "Pick someone who is on Hisaab to hold the kitty");
      }
      group.kittyHolderId = input.kittyHolderId as unknown as Types.ObjectId | null;
    }

    if (input.regenerateInviteCode) {
      // The old link stops working straight away
      await withFreshInviteCode(async (code) => {
        group.inviteCode = code;
        return group.save();
      });
    } else {
      await group.save();
    }
    return { ...summary(group, userId), inviteCode: group.inviteCode };
  },

  async join(userId: string, inviteCode: string) {
    // One atomic update: adds me only if I'm not in yet, the group isn't full and isn't closed
    const joined = await GroupModel.findOneAndUpdate(
      {
        inviteCode,
        closedAt: null,
        "members.userId": { $ne: userId },
        [`members.${MAX_MEMBERS - 1}`]: { $exists: false },
      },
      { $push: { members: { userId, role: "member", joinedAt: new Date() } } },
      { returnDocument: "after" },
    );
    if (joined) return { group: summary(joined, userId), alreadyMember: false };

    // Work out why it didn't join
    const group = await GroupModel.findOne({ inviteCode });
    if (!group)
      throw new AppError(
        404,
        "This invite link is not valid. Ask for a new one.",
      );
    if (group.members.some((m) => String(m.userId) === userId)) {
      return { group: summary(group, userId), alreadyMember: true };
    }
    if (group.closedAt) throw new AppError(409, "This group is closed, so nobody new can join.");
    throw new AppError(409, `This group is full (${MAX_MEMBERS} members)`);
  },

  async changeRole(
    group: GroupDoc,
    targetUserId: string,
    { role }: ChangeRoleInput,
  ) {
    const target = group.members.find((m) => String(m.userId) === targetUserId);
    if (!target) throw new AppError(404, "That person is not in this group");

    const admins = group.members.filter((m) => m.role === "admin").length;
    if (target.role === "admin" && role === "member" && admins === 1) {
      throw new AppError(
        409,
        "A group needs at least one admin. Make someone else admin first.",
      );
    }

    target.role = role;
    await group.save();
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

    const index = group.members.findIndex(
      (m) => String(m.userId) === targetUserId,
    );
    if (index === -1)
      throw new AppError(404, "That person is not in this group");

    // Nobody leaves (or is removed) while money is still owed either way
    const net = await balanceService.memberNet(group._id, targetUserId);
    if (net !== 0) {
      throw new AppError(
        409,
        leaving
          ? `Settle up first: your balance in this group is ${formatPaise(Math.abs(net))}.`
          : `This member still has a ${formatPaise(Math.abs(net))} balance here. Settle up first.`,
      );
    }

    const [removed] = group.members.splice(index, 1);

    // The kitty holder left: the kitty is switched off (an admin can pick a new holder)
    if (group.kittyHolderId && String(group.kittyHolderId) === targetUserId) {
      group.kittyHolderId = null;
    }

    // Last person out: the group goes too
    if (group.members.length === 0) {
      await group.deleteOne();
      return { groupDeleted: true };
    }

    // Last admin left: the longest-standing member becomes admin
    if (
      removed?.role === "admin" &&
      !group.members.some((m) => m.role === "admin")
    ) {
      const oldest = [...group.members].sort(
        (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
      )[0]!;
      oldest.role = "admin";
    }

    await group.save();
    return { groupDeleted: false };
  },

  /** Close a finished trip. Only when everyone is settled and nothing is waiting for confirmation. */
  async close(group: GroupDoc, actorId: string) {
    if (group.closedAt) throw new AppError(409, "This group is already closed");
    const nets = await balanceService.netBalances(group._id);
    if ([...nets.values()].some((n) => n !== 0)) {
      throw new AppError(409, "Settle up first: someone still owes money in this group.");
    }
    const pending = await SettlementModel.exists({ groupId: group._id, status: "pending", deletedAt: null });
    if (pending) throw new AppError(409, "A payment is still waiting for confirmation. Confirm or undo it first.");
    group.closedAt = new Date();
    group.closedBy = new Types.ObjectId(actorId);
    group.settleBy = null;
    await group.save();
    return { ...summary(group, actorId), inviteCode: group.inviteCode };
  },

  async reopen(group: GroupDoc, actorId: string) {
    if (!group.closedAt) throw new AppError(409, "This group isn’t closed");
    group.closedAt = null;
    group.closedBy = null;
    await group.save();
    return { ...summary(group, actorId), inviteCode: group.inviteCode };
  },
};
