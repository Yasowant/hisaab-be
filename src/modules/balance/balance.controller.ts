import { Request, Response } from "express";
import { balanceService } from "./balance.service";
import { activityService } from "../activity/activity.service";
import { pageQuery } from "../settlement/settlement.schema";

export const balanceController = {
  /** GET /groups/:groupId/balances: each member's balance + suggested payments */
  async forGroup(req: Request, res: Response) {
    const data = await balanceService.forGroup(req.group!, req.user!.id);
    res.json({ success: true, data });
  },

  /** GET /me/summary: totals across all my groups, for the dashboard */
  async mySummary(req: Request, res: Response) {
    const data = await balanceService.summaryFor(req.user!.id);
    res.json({ success: true, data });
  },

  /** GET /groups/:groupId/activity: who did what, newest first */
  async activity(req: Request, res: Response) {
    const { page, limit } = pageQuery.parse(req.query);
    const { items, meta } = await activityService.list(req.group!, page, limit);
    res.json({ success: true, data: { activity: items }, meta });
  },
};
