import { prisma } from "../../config/db";
import { NotificationData, NotificationType } from "./notification.model";
import { publishUser } from "../events/events";
import { emailLayout, sendMail } from "../../utils/mailer";
import { formatPaise } from "../../utils/money";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { afterCommit, type Db, type Tx } from "../../utils/transaction";
import { newId } from "../../utils/id";

export type NotifyInput = {
  recipients: string[];
  groupId: string;
  actor: string;
  type: NotificationType;
  data?: { description?: string; amount?: number; text?: string; expenseId?: string };
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
 * deleted accounts). Inside a transaction they save with it, and each person's
 * open tabs are pinged (and emails sent) only once it has committed.
 */
async function notify(input: NotifyInput, db: Db = prisma) {
  const ids = [...new Set(input.recipients.map(String))].filter((id) => id !== String(input.actor));
  if (ids.length === 0) return;
  const [real, group, actor] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids }, placeholder: false, deletedAt: null },
      select: { id: true, name: true, email: true, emailNotifications: true },
    }),
    db.group.findUnique({ where: { id: input.groupId }, select: { name: true } }),
    db.user.findUnique({ where: { id: input.actor }, select: { name: true } }),
  ]);
  if (real.length === 0) return;
  const data: NotificationData = {
    ...input.data,
    groupName: group?.name,
    text: input.data?.text ? short(input.data.text) : undefined,
  };
  const json = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await db.notification.createMany({
    data: real.map((u) => ({ id: newId(), userId: u.id, groupId: input.groupId, actorId: input.actor, type: input.type, data: json })),
  });

  afterCommit(db, () => {
    try {
      real.forEach((u) => publishUser(u.id));

      const mail = emailFor(input.type, actor?.name.split(" ")[0] ?? "Someone", data);
      if (!mail) return;
      const link = `${env.APP_URL}/groups/${input.groupId}${input.data?.expenseId ? `?expense=${input.data.expenseId}` : ""}`;
      for (const u of real) {
        if (!u.emailNotifications) continue;
        void sendMail({
          to: u.email,
          subject: mail.subject,
          ...emailLayout({ heading: mail.heading, lines: [`Hi ${u.name.split(" ")[0]},`, ...mail.lines], button: { label: mail.button, url: link } }),
        });
      }
    } catch (err) {
      logger.error({ err }, "Notification follow-up failed");
    }
  });
}

export const notificationService = {
  notify,

  /**
   * Turn a group activity into notifications for the people it concerns.
   * Called from activityService.record, in the same transaction.
   */
  async fromActivity(
    tx: Tx,
    entry: { groupId: string; actor: string; type: string; data: Record<string, unknown> },
  ) {
    const base = { groupId: entry.groupId, actor: entry.actor };
    const d = entry.data as {
      from?: string;
      to?: string;
      amount?: number;
      description?: string;
      text?: string;
      expenseId?: string;
      settlementId?: string;
    };

    if (entry.type === "dispute_resolved" && d.from) {
      // Tell the person who flagged it
      await notify(
        { ...base, recipients: [d.from], type: "dispute_resolved", data: { description: d.description, text: d.text, expenseId: d.expenseId } },
        tx,
      );
      return;
    }

    if (entry.type.startsWith("expense_") && d.expenseId) {
      const e = await tx.expense.findUnique({
        where: { id: d.expenseId },
        select: { paidById: true, createdById: true, splits: { select: { userId: true } } },
      });
      if (!e) return;
      const people = [e.paidById, e.createdById, ...e.splits.map((s) => s.userId)];
      const type = entry.type as "expense_added" | "expense_updated" | "expense_deleted" | "expense_disputed";
      await notify(
        { ...base, recipients: people, type, data: { description: d.description, amount: d.amount, text: d.text, expenseId: d.expenseId } },
        tx,
      );
      return;
    }

    if (entry.type === "payment_recorded" && d.settlementId) {
      const s = await tx.settlement.findUnique({ where: { id: d.settlementId }, select: { status: true, fromId: true, toId: true } });
      if (!s) return;
      if (s.status === "pending") {
        await notify({ ...base, recipients: [s.toId], type: "payment_to_confirm", data: { amount: d.amount } }, tx);
      } else {
        // The receiver recorded it: tell the payer it's been counted
        await notify({ ...base, recipients: [s.fromId], type: "payment_confirmed", data: { amount: d.amount } }, tx);
      }
      return;
    }

    if (entry.type === "payment_confirmed") {
      // Paid online: the receiver hears money arrived. Otherwise the payer hears it was confirmed.
      if (d.description === "Paid online" && d.to) {
        await notify({ ...base, recipients: [d.to], type: "payment_received", data: { amount: d.amount, description: "online" } }, tx);
      } else if (d.from) {
        await notify({ ...base, recipients: [d.from], type: "payment_confirmed", data: { amount: d.amount } }, tx);
      }
      return;
    }

    if (entry.type === "payment_rejected" && d.from) {
      await notify({ ...base, recipients: [d.from], type: "payment_rejected", data: { amount: d.amount } }, tx);
    }
  },

  async list(userId: string, page: number, limit: number) {
    const where = { userId };
    const [docs, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: { actor: { select: { id: true, name: true } } },
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      items: docs.map((n) => {
        const d = (n.data ?? {}) as NotificationData;
        return {
          id: n.id,
          type: n.type,
          groupId: n.groupId,
          groupName: d.groupName ?? "",
          actor: { id: n.actor.id, name: n.actor.name },
          description: d.description ?? null,
          amount: d.amount ?? null,
          text: d.text ?? null,
          expenseId: d.expenseId ?? null,
          read: Boolean(n.readAt),
          createdAt: n.createdAt,
        };
      }),
      unread,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  unreadCount: (userId: string) => prisma.notification.count({ where: { userId, readAt: null } }),

  /** Mark some (by id) or all of my notifications as read. */
  async markRead(userId: string, ids?: string[]) {
    const where = ids?.length ? { userId, id: { in: ids }, readAt: null } : { userId, readAt: null };
    const res = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
    return res.count;
  },
};
