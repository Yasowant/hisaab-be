import { Request, Response } from "express";
import { expenseService } from "./expense.service";
import { listExpensesQuery } from "./expense.schema";

type Params = { groupId: string; expenseId: string };

export const expenseController = {
  async create(req: Request, res: Response) {
    const expense = await expenseService.create(
      req.group!,
      req.user!.id,
      req.body,
    );
    res
      .status(201)
      .json({ success: true, message: "Expense added", data: { expense } });
  },

  async list(req: Request, res: Response) {
    const query = listExpensesQuery.parse(req.query);
    const { items, meta } = await expenseService.list(req.group!, query);
    res.json({ success: true, data: { expenses: items }, meta });
  },

  async getOne(req: Request<Params>, res: Response) {
    const expense = await expenseService.getOne(
      req.group!,
      req.params.expenseId,
    );
    res.json({ success: true, data: { expense } });
  },

  async update(req: Request<Params>, res: Response) {
    const expense = await expenseService.update(
      req.group!,
      req.user!.id,
      req.memberRole!,
      req.params.expenseId,
      req.body,
    );
    res.json({ success: true, message: "Expense updated", data: { expense } });
  },

  async remove(req: Request<Params>, res: Response) {
    await expenseService.remove(
      req.group!,
      req.user!.id,
      req.memberRole!,
      req.params.expenseId,
    );
    res.status(204).send();
  },
};
