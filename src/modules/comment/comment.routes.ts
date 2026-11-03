import { Router, Request, Response } from "express";
import { commentService } from "./comment.service";
import { validate } from "../../middlewares/validate";
import { commentInputSchema } from "./comment.schema";

type Params = { expenseId: string; commentId: string };

// Mounted under /groups/:groupId/expenses/:expenseId/comments
const router = Router({ mergeParams: true });

router.get("/", async (req: Request<Params>, res: Response) => {
  const comments = await commentService.list(req.group!, req.params.expenseId);
  res.json({ success: true, data: { comments } });
});

router.post("/", validate(commentInputSchema), async (req: Request<Params>, res: Response) => {
  const comment = await commentService.add(req.group!, req.user!.id, req.params.expenseId, req.body.text);
  res.status(201).json({ success: true, data: { comment } });
});

router.delete("/:commentId", async (req: Request<Params>, res: Response) => {
  await commentService.remove(req.group!, req.user!.id, req.memberRole!, req.params.expenseId, req.params.commentId);
  res.status(204).send();
});

export default router;
