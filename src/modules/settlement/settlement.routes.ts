import { Router } from "express";
import { settlementController } from "./settlement.controller";
import { validate } from "../../middlewares/validate";
import { settlementInputSchema } from "./settlement.schema";

// Mounted under /groups/:groupId/settlements after requireAuth + requireGroupMember
const router = Router({ mergeParams: true });

router.get("/", settlementController.list);
router.post("/", validate(settlementInputSchema), settlementController.record);
router.post("/:settlementId/confirm", settlementController.confirm);
router.post("/:settlementId/reject", settlementController.reject);
router.delete("/:settlementId", settlementController.remove);

export default router;
