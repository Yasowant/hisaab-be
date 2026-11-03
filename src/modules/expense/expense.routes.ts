import express, { Router, Request, Response } from "express";
import { expenseController } from "./expense.controller";
import { validate } from "../../middlewares/validate";
import { createExpenseSchema, disputeSchema, resolveDisputeSchema, updateExpenseSchema } from "./expense.schema";
import { expenseService } from "./expense.service";
import { MAX_PDF_BYTES, RECEIPT_TYPES, receiptService } from "./receipt.service";
import commentRoutes from "../comment/comment.routes";

const router = Router({ mergeParams: true });

router.get("/", expenseController.list);
router.post("/", validate(createExpenseSchema), expenseController.create);
router.get("/:expenseId", expenseController.getOne);
router.put(
  "/:expenseId",
  validate(updateExpenseSchema),
  expenseController.update,
);
router.delete("/:expenseId", expenseController.remove);
router.use("/:expenseId/comments", commentRoutes);

type P = { expenseId: string };

// "Something's wrong" with an expense
router.post("/:expenseId/dispute", validate(disputeSchema), async (req: Request<P>, res: Response) => {
  const expense = await expenseService.dispute(req.group!, req.user!.id, req.params.expenseId, req.body.reason);
  res.status(201).json({ success: true, message: "Flagged. Everyone in it has been told.", data: { expense } });
});
router.delete("/:expenseId/dispute", validate(resolveDisputeSchema), async (req: Request<P>, res: Response) => {
  const expense = await expenseService.resolveDispute(
    req.group!,
    req.user!.id,
    req.memberRole!,
    req.params.expenseId,
    req.body?.note,
  );
  res.json({ success: true, message: "Marked as sorted", data: { expense } });
});

// Receipt photo or PDF: the file itself is the request body (no multipart library needed)
router.put(
  "/:expenseId/receipt",
  express.raw({ type: RECEIPT_TYPES, limit: MAX_PDF_BYTES }),
  async (req: Request<P>, res: Response) => {
    const receipt = await receiptService.upload(req.group!, req.user!.id, req.memberRole!, req.params.expenseId, req.body);
    res.json({ success: true, message: "Receipt saved", data: { receipt } });
  },
);
router.get("/:expenseId/receipt", async (req: Request<P>, res: Response) => {
  const { stream, contentType, size } = await receiptService.open(req.group!, req.params.expenseId);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Disposition", "inline");
  stream.on("error", () => res.destroy()).pipe(res);
});
router.delete("/:expenseId/receipt", async (req: Request<P>, res: Response) => {
  await receiptService.remove(req.group!, req.user!.id, req.memberRole!, req.params.expenseId);
  res.status(204).send();
});

export default router;
