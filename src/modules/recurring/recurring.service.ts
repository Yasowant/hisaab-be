import { prisma } from "../../config/db";
import { FREQUENCIES } from "./recurring.model";
import { GroupDoc } from "../group/group.model";
import { ExpenseInput } from "../expense/expense.schema";
import { insertExpense, toFields } from "../expense/expense.service";
import { AppError } from "../../utils/AppError";
import { inTransaction, type Tx } from "../../utils/transaction";
import { isId } from "../../utils/id";
import { logger } from "../../utils/logger";

type Frequency = (typeof FREQUENCIES)[number];

// Never create more than this many missed repeats in one go
const MAX_CATCH_UP = 24;

/** The next date after `from`. Monthly keeps the same day, or the month's last day if shorter. */
export function nextDate(from: Date, frequency: Frequency, anchorDay: number): Date {
  if (frequency === "weekly") return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(anchorDay, lastDay), from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()),
  );
}

export const recurringService = {
  /** Called when an expense is created with "repeat"; the first copy is that expense itself. */
  async createFrom(tx: Tx, group: GroupDoc, userId: string, input: ExpenseInput, frequency: Frequency) {
    const { date, ...template } = input;
    const first = date ?? new Date();
    const doc = await tx.recurringExpense.create({
      data: {
        groupId: group.id,
        createdById: userId,
        template: JSON.parse(JSON.stringify(template)),
        frequency,
        anchorDay: first.getUTCDate(),
        nextRun: nextDate(first, frequency, first.getUTCDate()),
      },
      select: { id: true },
    });
    return doc.id;
  },

  /**
   * Adds any repeats that are due. Runs when the group's expenses, balances or
   * insights are loaded, so no background worker is needed. Each run is claimed
   * by moving nextRun forward atomically, so two requests at once can't add it twice.
   */
  async runDue(group: GroupDoc) {
    const now = new Date();
    const due = await prisma.recurringExpense.findMany({ where: { groupId: group.id, active: true, nextRun: { lte: now } } });

    for (const r of due) {
      let runAt = r.nextRun;
      for (let i = 0; i < MAX_CATCH_UP && runAt <= now; i++) {
        const after = nextDate(runAt, r.frequency, r.anchorDay);
        try {
          const done = await inTransaction(async (tx) => {
            const claimed = await tx.recurringExpense.updateMany({
              where: { id: r.id, active: true, nextRun: runAt },
              data: { nextRun: after },
            });
            if (claimed.count === 0) return false; // another request got it
            const fields = toFields({ ...(r.template as unknown as ExpenseInput), date: runAt }, group);
            await insertExpense(tx, group, r.createdById, fields, { recurringId: r.id });
            return true;
          });
          if (!done) break;
        } catch (err) {
          // Someone in it left the group, or similar: stop repeating instead of failing the page
          if (err instanceof AppError) {
            await prisma.recurringExpense.update({ where: { id: r.id }, data: { active: false } });
            logger.warn({ recurringId: r.id, reason: err.message }, "Repeat stopped");
            break;
          }
          throw err;
        }
        runAt = after;
      }
    }
  },

  async list(group: GroupDoc) {
    const docs = await prisma.recurringExpense.findMany({
      where: { groupId: group.id, active: true },
      orderBy: { nextRun: "asc" },
      include: { createdBy: { select: { id: true, name: true } } },
    });
    return docs.map((r) => {
      const t = r.template as unknown as ExpenseInput;
      return {
        id: r.id,
        description: t.description,
        amount: t.amount,
        category: t.category,
        frequency: r.frequency,
        nextRun: r.nextRun,
        createdBy: { id: r.createdBy.id, name: r.createdBy.name },
      };
    });
  },

  /** Stop repeating. Past copies stay. The person who set it up, or an admin. */
  async stop(group: GroupDoc, userId: string, role: string, id: string) {
    if (!isId(id)) throw new AppError(404, "Repeat not found");
    const r = await prisma.recurringExpense.findFirst({ where: { id, groupId: group.id, active: true } });
    if (!r) throw new AppError(404, "Repeat not found");
    if (role !== "admin" && r.createdById !== userId) {
      throw new AppError(403, "Only the person who set this up, or a group admin, can stop it");
    }
    await prisma.recurringExpense.update({ where: { id: r.id }, data: { active: false } });
  },
};
