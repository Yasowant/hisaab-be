import { ClientSession, Types } from "mongoose";
import { ActivityModel, ACTIVITY_TYPES } from "./activity.model";
import { GroupDoc } from "../group/group.model";
import { notificationService } from "../notification/notification.service";

type ActivityType = (typeof ACTIVITY_TYPES)[number];
type Named = { _id: Types.ObjectId; name: string };

export const activityService = {
  /** Always called inside the same transaction as the change it describes. */
  async record(
    session: ClientSession,
    entry: {
      groupId: Types.ObjectId | string;
      actor: string;
      type: ActivityType;
      data: Record<string, unknown>;
    },
  ) {
    await ActivityModel.create([entry], { session });
    // Tell the people it concerns (same transaction: no change without its notifications)
    await notificationService.fromActivity(session, entry);
  },

  async list(group: GroupDoc, page: number, limit: number) {
    const filter = { groupId: group._id };
    const [docs, total] = await Promise.all([
      ActivityModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate<{ actor: Named }>("actor", "name")
        .populate<{
          data: { description?: string; amount?: number; previousAmount?: number; text?: string; from?: Named; to?: Named };
        }>([
          { path: "data.from", select: "name" },
          { path: "data.to", select: "name" },
        ])
        .lean(),
      ActivityModel.countDocuments(filter),
    ]);

    return {
      items: docs.map((a) => ({
        id: String(a._id),
        type: a.type,
        actor: { id: String(a.actor._id), name: a.actor.name },
        description: a.data?.description ?? null,
        amount: a.data?.amount ?? null,
        previousAmount: a.data?.previousAmount ?? null,
        text: a.data?.text ?? null,
        from: a.data?.from ? { id: String(a.data.from._id), name: a.data.from.name } : null,
        to: a.data?.to ? { id: String(a.data.to._id), name: a.data.to.name } : null,
        createdAt: a.createdAt,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },
};
