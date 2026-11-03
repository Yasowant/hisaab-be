import { Router } from "express";
import { groupController } from "./group.controller";
import { requireAuth } from "../../middlewares/auth";
import { requireGroupMember } from "../../middlewares/requireGroupMember";
import { requireOpenGroup } from "../../middlewares/requireOpenGroup";
import { validate } from "../../middlewares/validate";
import {
  changeRoleSchema,
  createGroupSchema,
  joinGroupSchema,
  updateGroupSchema,
  addPlaceholderSchema,
} from "./group.schema";
import { claimSchema } from "../placeholder/placeholder.schema";
import recurringRoutes, { runDueRepeats } from "../recurring/recurring.routes";
import { notifyGroupOnChange, streamGroupEvents } from "../events/events";
import { extrasController } from "./extras.controller";
import { reminderService } from "../reminder/reminder.service";
import { groupPaymentRoutes } from "../payment/payment.routes";
import expenseRoutes from "../expense/expense.routes";
import settlementRoutes from "../settlement/settlement.routes";
import { balanceController } from "../balance/balance.controller";

const router = Router();

// Every group route needs a signed-in user
router.use(requireAuth);
// Any successful change in a group tells everyone who has it open (live updates)
router.use(notifyGroupOnChange);

router.post("/", validate(createGroupSchema), groupController.create);
router.get("/", groupController.listMine);
router.post("/join", validate(joinGroupSchema), groupController.join);

router.get("/:groupId", requireGroupMember(), groupController.getOne);
router.patch(
  "/:groupId",
  requireGroupMember({ admin: true }),
  validate(updateGroupSchema),
  groupController.update,
);
router.patch(
  "/:groupId/members/:userId",
  requireGroupMember({ admin: true }),
  validate(changeRoleSchema),
  groupController.changeRole,
);
router.delete(
  "/:groupId/members/:userId",
  requireGroupMember(),
  groupController.removeMember,
);

router.use("/:groupId/expenses", requireGroupMember(), requireOpenGroup, runDueRepeats, expenseRoutes);
router.use("/:groupId/settlements", requireGroupMember(), requireOpenGroup, settlementRoutes);
router.use("/:groupId/payments", requireGroupMember(), requireOpenGroup, groupPaymentRoutes);
router.use("/:groupId/recurring", requireGroupMember(), requireOpenGroup, runDueRepeats, recurringRoutes);
router.post("/:groupId/remind/:userId", requireGroupMember(), requireOpenGroup, async (req, res) => {
  await reminderService.remindOne(req.group!, req.user!.id, req.memberRole!, String(req.params.userId));
  res.json({ success: true, message: "Reminder sent" });
});
router.post("/:groupId/close", requireGroupMember({ admin: true }), groupController.close);
router.post("/:groupId/reopen", requireGroupMember({ admin: true }), groupController.reopen);
router.get("/:groupId/balances", requireGroupMember(), runDueRepeats, balanceController.forGroup);
router.get("/:groupId/stats", requireGroupMember(), runDueRepeats, extrasController.stats);
router.get("/:groupId/export.csv", requireGroupMember(), runDueRepeats, extrasController.exportCsv);
router.get("/:groupId/events", requireGroupMember(), streamGroupEvents);
router.post(
  "/:groupId/placeholders",
  requireGroupMember(),
  requireOpenGroup,
  validate(addPlaceholderSchema),
  extrasController.addPlaceholder,
);
router.post(
  "/:groupId/placeholders/:placeholderId/claim",
  requireGroupMember(),
  requireOpenGroup,
  validate(claimSchema),
  extrasController.claimPlaceholder,
);
router.get("/:groupId/activity", requireGroupMember(), balanceController.activity);

export default router;
