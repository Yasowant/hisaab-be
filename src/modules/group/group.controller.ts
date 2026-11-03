import { Request, Response } from "express";
import { groupService } from "./group.service";
import { publish } from "../events/events";

export const groupController = {
  async create(req: Request, res: Response) {
    const group = await groupService.create(req.user!.id, req.body);
    res
      .status(201)
      .json({ success: true, message: "Group created", data: { group } });
  },

  async listMine(req: Request, res: Response) {
    const groups = await groupService.listMine(req.user!.id);
    res.json({ success: true, data: { groups } });
  },

  async join(req: Request, res: Response) {
    const { group, alreadyMember } = await groupService.join(
      req.user!.id,
      req.body.inviteCode,
    );
    if (!alreadyMember) publish(group.id, req.user!.id);
    res.status(alreadyMember ? 200 : 201).json({
      success: true,
      message: alreadyMember
        ? "You are already in this group"
        : "Joined the group",
      data: { group },
    });
  },

  async getOne(req: Request, res: Response) {
    const group = await groupService.getDetails(req.group!, req.user!.id);
    res.json({ success: true, data: { group } });
  },

  async update(req: Request, res: Response) {
    const group = await groupService.update(req.group!, req.user!.id, req.body);
    res.json({ success: true, message: "Group updated", data: { group } });
  },

  async changeRole(
    req: Request<{ groupId: string; userId: string }>,
    res: Response,
  ) {
    await groupService.changeRole(req.group!, req.params.userId, req.body);
    res.json({ success: true, message: "Role updated" });
  },

  async removeMember(
    req: Request<{ groupId: string; userId: string }>,
    res: Response,
  ) {
    const result = await groupService.removeMember(
      req.group!,
      req.user!.id,
      req.memberRole!,
      req.params.userId,
    );
    res.json({
      success: true,
      message: result.groupDeleted
        ? "You left and the empty group was deleted"
        : "Member removed",
      data: result,
    });
  },

  async close(req: Request, res: Response) {
    const group = await groupService.close(req.group!, req.user!.id);
    res.json({ success: true, message: "Group closed. It’s kept as a past group.", data: { group } });
  },

  async reopen(req: Request, res: Response) {
    const group = await groupService.reopen(req.group!, req.user!.id);
    res.json({ success: true, message: "Group reopened", data: { group } });
  },
};
