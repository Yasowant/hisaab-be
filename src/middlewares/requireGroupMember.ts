import { Request, Response, NextFunction } from "express";
import { isValidObjectId } from "mongoose";
import { GroupModel } from "../modules/group/group.model";
import { AppError } from "../utils/AppError";

type Options = { admin?: boolean };

export const requireGroupMember =
  ({ admin = false }: Options = {}) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    const { groupId } = req.params;
    if (typeof groupId !== "string" || !isValidObjectId(groupId)) {
      throw new AppError(404, "Group not found");
    }

    const group = await GroupModel.findOne({
      _id: groupId,
      "members.userId": req.user!.id,
    });
    if (!group) throw new AppError(404, "Group not found");

    const me = group.members.find((m) => String(m.userId) === req.user!.id)!;
    if (admin && me.role !== "admin") {
      throw new AppError(403, "Only group admins can do this");
    }

    req.group = group;
    req.memberRole = me.role;
    next();
  };
