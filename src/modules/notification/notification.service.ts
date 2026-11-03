import { ClientSession, Types } from "mongoose";
import { NotificationModel, type NotificationType } from "./notification.model";
import { ExpenseModel } from "../expense/expense.model";
import { SettlementModel } from "../settlement/settlement.model";
import { GroupModel } from "../group/group.model";
import { UserModel } from "../user/user.model";
import { publishUser } from "../events/events";
import { emailLayout, sendMail } from "../../utils/mailer";
import { formatPaise } from "../../utils/money";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

type Id = Types.ObjectId | string;
type Named = { _id: Types.ObjectId; name: string };

export type NotifyInput = {
  recipients: Id[];
  groupId: Id;
  actor: Id;
  type: NotificationType;
  data?: { description?: string; amount?: number; text?: string; expenseId?: Id };
};

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Only the moments worth an email; everything else stays in the in-app inbox. */
function emailFor(
  type: NotificationType,
  actor: string,
  d: { groupName?: string; description?: string; amount?: number; text?: string },
): { subject: string; heading: string; lines: string[]; button: string } | null {
  const amt = d.amount !== undefined ? formatPaise(d.amount) : "";
  const group = d.groupName ? ` in ${d.groupName}` : "";
  switch (type) {
    case "payment_to_confirm":
      return {
        subject: `${actor} says they paid you ${amt}`,
        heading: `Did you get ${amt} from ${actor}?`,
        lines: [`${actor} recorded a payment of ${amt} to you${group}.`, "Check your bank or UPI app, then confirm it in Hisaab so everyone’s balance updates."],
        button: "Confirm or reject",
      };
    case "payment_received":
      return {
        subject: `${actor} paid you ${amt}`,
        heading: `You got ${amt} from ${actor}`,
        lines: [`${actor} paid you ${amt}${d.description === "online" ? " online" : ""}${group}. Balances are already updated.`],
        button: "See the group",
      };
    case "payment_rejected":
      return {
        subject: `Your ${amt} payment wasn’t received`,
        heading: `${actor} says your payment didn’t arrive`,
        lines: [`${actor} marked your payment of ${amt}${group} as not received, so it doesn’t count yet.`, "Check with them, or pay again."],
        button: "See the group",
      };
    case "expense_disputed":
      return {
        subject: `${actor} flagged “${d.description ?? "an expense"}”`,
        heading: `Something’s wrong with ${d.description ?? "an expense"}?`,
        lines: [`${actor} flagged it${group}:`, `“${d.text ?? ""}”`, "Fix it or reply in the comments, then mark it as sorted."],
        button: "Open the expense",
      };
    case "payment_reminder":
      return {
        subject: `Reminder: you owe ${actor} ${amt}`,
        heading: `You owe ${actor} ${amt}`,
        lines: [
          `In ${d.groupName ?? "your group"}, Hisaab says you still owe ${actor} ${amt}.`,
          d.text ?? "Settle up when you can: paying by UPI takes a few seconds.",
        ],
        button: "Settle up",
      };
    case "dispute_resolved":
      return {
        subject: `“${d.description ?? "An expense"}” was sorted out`,
        heading: `${actor} sorted out ${d.description ?? "the expense"} you flagged`,
        lines: d.text ? [`Their note: “${d.text}”`] : ["Have a look and check it’s right now."],
        button: "Open the expense",
      };
    default:
      return null;
  }
}

/**
 * Save notifications for these people (never the actor, never placeholders or
 * deleted accounts). Inside a transaction they save with it; each person's open
 * tabs are pinged once the transaction is over.
 */
async function notify(input: NotifyInput, session?: ClientSession) {
  const ids = [...new Set(input.recipients.map(String))].filter((id) => id !== String(input.actor));
  if (ids.length === 0) return;
  const [real, group, actor] = await Promise.all([
    UserModel.find({ _id: { $in: ids }, placeholder: { $ne: true }, deletedAt: null }, "_id name email emailNotifications", { session }).lean(),
    GroupModel.findById(input.groupId, "name", { session }).lean(),
    UserModel.findById(input.actor, "name", { session }).lean(),
  ]);
  if (real.length === 0) return;
  const data = { ...input.data, groupName: group?.name, text: input.data?.text ? short(input.data.text) : undefined };
  const saved = await NotificationModel.insertMany(
    real.map((u) => ({ userId: u._id, groupId: input.groupId, actor: input.actor, type: input.type, data })),
    { session },
  );

  const afterSave = async () => {
    // A transaction that was rolled back (or retried) leaves no notifications: send nothing for those
    const kept = session ? await NotificationModel.find({ _id: { $in: saved.map((n) => n._id) } }, "userId").lean() : saved;
    const keptFor = new Set(kept.map((n) => String(n.userId)));
    real.filter((u) => keptFor.has(String(u._id))).forEach((u) => publishUser(String(u._id)));

    const mail = emailFor(input.type, actor?.name.split(" ")[0] ?? "Someone", data);
    if (!mail) return;
    const link = `${env.APP_URL}/groups/${input.groupId}${input.data?.expenseId ? `?expense=${input.data.expenseId}` : ""}`;
    for (const u of real) {
      if (!keptFor.has(String(u._id)) || u.emailNotifications === false) continue;
      void sendMail({
        to: u.email,
        subject: mail.subject,
        ...emailLayout({ heading: mail.heading, lines: [`Hi ${u.name.split(" ")[0]},`, ...mail.lines], button: { label: mail.button, url: link } }),
      });
    }
  };
  const run = () => afterSave().catch((err) => logger.error({ err }, "Notification follow-up failed"));
  if (session) session.once("ended", run);
  else void run();
}

export const notificationService = {
  notify,

  /**
   * Turn a group activity into notifications for the people it concerns.
   * Called from activityService.record, in the same transaction.
   */
  async fromActivity(
    session: ClientSession,
    entry: { groupId: Id; actor: string; type: string; data: Record<string, unknown> },
  ) {
    const base = { groupId: entry.groupId, actor: entry.actor };
    const d = entry.data as {
      from?: Id;
      to?: Id;
      amount?: number;
      description?: string;
      text?: string;
      expenseId?: Id;
      settlementId?: Id;
    };

    if (entry.type === "dispute_resolved" && d.from) {
      // Tell the person who flagged it
      await notify(
        { ...base, recipients: [d.from], type: "dispute_resolved", data: { description: d.description, text: d.text, expenseId: d.expenseId } },
        session,
      );
      return;
    }

    if (entry.type.startsWith("expense_") && d.expenseId) {
      const e = await ExpenseModel.findById(d.expenseId, "paidBy splits createdBy", { session }).lean();
      if (!e) return;
      const people = [e.paidBy, e.createdBy, ...e.splits.map((s) => s.userId)];
      const type = entry.type as "expense_added" | "expense_updated" | "expense_deleted" | "expense_disputed";
      await notify(
        { ...base, recipients: people, type, data: { description: d.description, amount: d.amount, text: d.text, expenseId: d.expenseId } },
        session,
      );
      return;
    }

    if (entry.type === "payment_recorded" && d.settlementId) {
      const s = await SettlementModel.findById(d.settlementId, "status from to", { session }).lean();
      if (!s) return;
      if (s.status === "pending") {
        await notify({ ...base, recipients: [s.to], type: "payment_to_confirm", data: { amount: d.amount } }, session);
      } else {
        // The receiver recorded it: tell the payer it's been counted
        await notify({ ...base, recipients: [s.from], type: "payment_confirmed", data: { amount: d.amount } }, session);
      }
      return;
    }

    if (entry.type === "payment_confirmed") {
      // Paid online: the receiver hears money arrived. Otherwise the payer hears it was confirmed.
      if (d.description === "Paid online" && d.to) {
        await notify({ ...base, recipients: [d.to], type: "payment_received", data: { amount: d.amount, description: "online" } }, session);
      } else if (d.from) {
        await notify({ ...base, recipients: [d.from], type: "payment_confirmed", data: { amount: d.amount } }, session);
      }
      return;
    }

    if (entry.type === "payment_rejected" && d.from) {
      await notify({ ...base, recipients: [d.from], type: "payment_rejected", data: { amount: d.amount } }, session);
    }
  },

  async list(userId: string, page: number, limit: number) {
    const filter = { userId };
    const [docs, total, unread] = await Promise.all([
      NotificationModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate<{ actor: Named }>("actor", "name")
        .lean(),
      NotificationModel.countDocuments(filter),
      NotificationModel.countDocuments({ userId, readAt: null }),
    ]);
    return {
      items: docs.map((n) => ({
        id: String(n._id),
        type: n.type,
        groupId: String(n.groupId),
        groupName: n.data?.groupName ?? "",
        actor: { id: String(n.actor._id), name: n.actor.name },
        description: n.data?.description ?? null,
        amount: n.data?.amount ?? null,
        text: n.data?.text ?? null,
        expenseId: n.data?.expenseId ? String(n.data.expenseId) : null,
        read: Boolean(n.readAt),
        createdAt: n.createdAt,
      })),
      unread,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  unreadCount: (userId: string) => NotificationModel.countDocuments({ userId, readAt: null }),

  /** Mark some (by id) or all of my notifications as read. */
  async markRead(userId: string, ids?: string[]) {
    const filter = ids?.length ? { userId, _id: { $in: ids }, readAt: null } : { userId, readAt: null };
    const res = await NotificationModel.updateMany(filter, { $set: { readAt: new Date() } });
    return res.modifiedCount;
  },
};
