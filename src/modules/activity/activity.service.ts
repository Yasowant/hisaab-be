import { prisma } from "../../config/db";
import { ActivityData, ActivityType } from "./activity.model";
import { GroupDoc } from "../group/group.model";
import { notificationService } from "../notification/notification.service";
import type { Tx } from "../../utils/transaction";

export type ActivityEntry = {
  groupId: string;
  actor: string;
  type: ActivityType;
  data: ActivityData & { from?: string; to?: string };
};

export const activityService = {
  /** Always called inside the same transaction as the change it describes. */
  async record(tx: Tx, entry: ActivityEntry) {
    const { from, to, ...data } = entry.data;
    await tx.activity.create({
      data: {
        groupId: entry.groupId,
        actorId: entry.actor,
        type: entry.type,
        fromId: from ?? null,
        toId: to ?? null,
        data: stripUndefined(data),
      },
    });
    // Tell the people it concerns (same transaction: no change without its notifications)
    await notificationService.fromActivity(tx, entry);
  },

  async list(group: GroupDoc, page: number, limit: number) {
    const where = { groupId: group.id };
    const [docs, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          actor: { select: { id: true, name: true } },
          from: { select: { id: true, name: true } },
          to: { select: { id: true, name: true } },
        },
      }),
      prisma.activity.count({ where }),
    ]);

    return {
      items: docs.map((a) => {
        const d = (a.data ?? {}) as ActivityData;
        return {
          id: a.id,
          type: a.type,
          actor: { id: a.actor.id, name: a.actor.name },
          description: d.description ?? null,
          amount: d.amount ?? null,
          previousAmount: d.previousAmount ?? null,
          text: d.text ?? null,
          from: a.from ? { id: a.from.id, name: a.from.name } : null,
          to: a.to ? { id: a.to.id, name: a.to.name } : null,
          createdAt: a.createdAt,
        };
      }),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },
};

/** JSON columns can't hold `undefined`; drop those keys. */
export function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
