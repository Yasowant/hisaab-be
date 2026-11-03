import { Types } from "mongoose";
import { ReminderModel } from "./reminder.model";
import { GroupDoc, GroupModel } from "../group/group.model";
import { balanceService, simplifyDebts } from "../balance/balance.service";
import { notificationService } from "../notification/notification.service";
import { AppError } from "../../utils/AppError";
import { logger } from "../../utils/logger";
import { env } from "../../config/env";

const DAY = 24 * 60 * 60 * 1000;
const AUTO_EVERY = 2 * DAY; // scheduled reminders: at most every 2 days per person and group
const MANUAL_EVERY = 20 * 60 * 60 * 1000; // a friend's "Remind" button: once a day
const START_BEFORE = 3 * DAY; // start reminding 3 days before the settle-by date

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;
const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Claim the right to remind this person now. One atomic write: if someone (or
 * another server) reminded them recently, this returns false and nothing is sent.
 */
async function claim(groupId: Types.ObjectId, userId: string, every: number) {
  const now = new Date();
  try {
    const doc = await ReminderModel.findOneAndUpdate(
      { groupId, userId, lastSentAt: { $lte: new Date(now.getTime() - every) } },
      { $set: { lastSentAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    return Boolean(doc);
  } catch (err) {
    if (isDuplicateKey(err)) return false; // a recent reminder already exists
    throw err;
  }
}

/** Who each person owes, from the group's suggested payments. */
async function debts(group: GroupDoc) {
  return simplifyDebts(await balanceService.netBalances(group._id));
}

export const reminderService = {
  /** The scheduled check: groups with a settle-by date that's near or past. */
  async sweep() {
    const now = Date.now();
    const groups = await GroupModel.find({ closedAt: null, settleBy: { $ne: null, $lte: new Date(now + START_BEFORE) } });
    let sent = 0;
    for (const g of groups) {
      const by = g.settleBy!;
      const overdue = by.getTime() < now - DAY;
      for (const p of await debts(g)) {
        if (!(await claim(g._id, p.from, AUTO_EVERY))) continue;
        await notificationService.notify({
          recipients: [p.from],
          groupId: g._id,
          actor: p.to, // shown as "you owe <them>"
          type: "payment_reminder",
          data: {
            amount: p.amount,
            text: overdue
              ? `The group asked everyone to settle by ${dayFmt.format(by)}, and that’s passed.`
              : `The group asked everyone to settle by ${dayFmt.format(by)}.`,
          },
        });
        sent++;
      }
    }
    if (sent) logger.info({ sent }, "Payment reminders sent");
    return sent;
  },

  /** "Remind" button: someone who's owed (or an admin) nudges a person who owes them. */
  async remindOne(group: GroupDoc, actorId: string, role: string, debtorId: string) {
    const owed = (await debts(group)).filter((p) => p.from === debtorId);
    if (owed.length === 0) throw new AppError(400, "They don’t owe anything here");
    const mine = owed.find((p) => p.to === actorId);
    if (!mine && role !== "admin") throw new AppError(403, "You can remind people who owe you");
    const target = mine ?? owed[0]!;
    if (!(await claim(group._id, debtorId, MANUAL_EVERY))) {
      throw new AppError(429, "They were reminded recently. Try again tomorrow.");
    }
    await notificationService.notify({
      recipients: [debtorId],
      groupId: group._id,
      actor: target.to,
      type: "payment_reminder",
      data: { amount: target.amount, text: `${mine ? "They" : "An admin"} sent you a reminder.` },
    });
  },

  /** Run the check on a timer (one server; see note in events.ts for running several). */
  start() {
    const run = () => this.sweep().catch((err) => logger.error({ err }, "Reminder check failed"));
    const ms = env.REMINDER_INTERVAL_MIN * 60 * 1000;
    const first = setTimeout(run, Math.min(ms, 60_000));
    const timer = setInterval(run, ms);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  },
};
