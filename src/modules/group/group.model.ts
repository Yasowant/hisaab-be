import { prisma } from "../../config/db";
import type { Group, GroupMember } from "../../generated/prisma/client";
import type { Db } from "../../utils/transaction";

// Tables live in prisma/schema.prisma (Group, GroupMember); this file keeps the shared constants and helpers.

export const GROUP_TYPES = ["trip", "home", "other"] as const;
export const MEMBER_ROLES = ["admin", "member"] as const;
export const MAX_MEMBERS = 50;

/** A group with its members, oldest member first (what req.group holds). */
export type GroupDoc = Group & { members: GroupMember[] };

export const membersInclude = { members: { orderBy: { joinedAt: "asc" as const } } };

export async function loadGroup(id: string, db: Db = prisma): Promise<GroupDoc | null> {
  return db.group.findUnique({ where: { id }, include: membersInclude });
}
