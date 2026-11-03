import { isValidObjectId, Types, type ClientSession } from "mongoose";
import { RecurringModel, FREQUENCIES } from "./recurring.model";
import { GroupDoc } from "../group/group.model";
import { ExpenseInput } from "../expense/expense.schema";
import { insertExpense, toFields } from "../expense/expense.service";
import { AppError } from "../../utils/AppError";
import { inTransaction } from "../../utils/transaction";
import { logger } from "../../utils/logger";

type Frequency = (typeof FREQUENCIES)[number];
type Named = { _id: Types.ObjectId; name: string };

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
  async createFrom(session: ClientSession, group: GroupDoc, userId: string, input: ExpenseInput, frequency: Frequency) {
    const { date, ...template } = input;
    const first = date ?? new Date();
    const [doc] = await RecurringModel.create(
      [
        {
          groupId: group._id,
          createdBy: userId,
          template,
          frequency,
          anchorDay: first.getUTCDate(),
          nextRun: nextDate(first, frequency, first.getUTCDate()),
        },
      ],
      { session },
    );
    return doc!._id;
  },

  /**
   * Adds any repeats that are due. Runs when the group's expenses, balances or
   * insights are loaded, so no background worker is needed. Each run is claimed
   * by moving nextRun forward atomically, so two requests at once can't add it twice.
   */
  async runDue(group: GroupDoc) {
    const now = new Date();
    const due = await RecurringModel.find({ groupId: group._id, active: true, nextRun: { $lte: now } }).lean();

    for (const r of due) {
      let runAt = r.nextRun;
      for (let i = 0; i < MAX_CATCH_UP && runAt <= now; i++) {
        const after = nextDate(runAt, r.frequency, r.anchorDay);
        try {
          const done = await inTransaction(async (session) => {
            const claimed = await RecurringModel.findOneAndUpdate(
              { _id: r._id, active: true, nextRun: runAt },
              { $set: { nextRun: after } },
              { session },
            );
            if (!claimed) return false; // another request got it
            const fields = toFields({ ...(r.template as ExpenseInput), date: runAt }, group);
            await insertExpense(session, group, String(r.createdBy), fields, { recurringId: r._id });
            return true;
          });
          if (!done) break;
        } catch (err) {
          // Someone in it left the group, or similar: stop repeating instead of failing the page
          if (err instanceof AppError) {
            await RecurringModel.updateOne({ _id: r._id }, { $set: { active: false } });
            logger.warn({ recurringId: String(r._id), reason: err.message }, "Repeat stopped");
            break;
          }
          throw err;
        }
        runAt = after;
      }
    }
  },

  async list(group: GroupDoc) {
    const docs = await RecurringModel.find({ groupId: group._id, active: true })
      .sort({ nextRun: 1 })
      .populate<{ createdBy: Named }>("createdBy", "name")
      .lean();
    return docs.map((r) => {
      const t = r.template as ExpenseInput;
      return {
        id: String(r._id),
        description: t.description,
        amount: t.amount,
        category: t.category,
        frequency: r.frequency,
        nextRun: r.nextRun,
        createdBy: { id: String(r.createdBy._id), name: r.createdBy.name },
      };
    });
  },

  /** Stop repeating. Past copies stay. The person who set it up, or an admin. */
  async stop(group: GroupDoc, userId: string, role: string, id: string) {
    if (!isValidObjectId(id)) throw new AppError(404, "Repeat not found");
    const r = await RecurringModel.findOne({ _id: id, groupId: group._id, active: true });
    if (!r) throw new AppError(404, "Repeat not found");
    if (role !== "admin" && String(r.createdBy) !== userId) {
      throw new AppError(403, "Only the person who set this up, or a group admin, can stop it");
    }
    r.active = false;
    await r.save();
  },
};
