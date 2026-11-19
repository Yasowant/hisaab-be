import { Request, Response, NextFunction } from "express";
import { loadGroup } from "../modules/group/group.model";
import { AppError } from "../utils/AppError";
import { isId } from "../utils/id";

type Options = { admin?: boolean };

export const requireGroupMember =
  ({ admin = false }: Options = {}) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    const { groupId } = req.params;
    if (!isId(groupId)) {
      throw new AppError(404, "Group not found");
    }

    const group = await loadGroup(groupId);
    const me = group?.members.find((m) => m.userId === req.user!.id);
    if (!group || !me) throw new AppError(404, "Group not found");

    if (admin && me.role !== "admin") {
      throw new AppError(403, "Only group admins can do this");
    }

    req.group = group;
    req.memberRole = me.role;
    next();
  };
