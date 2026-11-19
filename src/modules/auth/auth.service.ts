import { prisma } from "../../config/db";
import { AppError } from "../../utils/AppError";
import { LoginInput, RegisterInput, UpdateProfileInput } from "./auth.schema";
import { loadGroup } from "../group/group.model";
import { groupService } from "../group/group.service";
import { balanceService } from "../balance/balance.service";
import { emailLayout, sendMail } from "../../utils/mailer";
import { cloudinary } from "../../utils/cloudinary";
import { formatPaise } from "../../utils/money";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  hashToken,
  newRefreshToken,
  signAccessToken,
} from "../../utils/tokens";
import { randomUUID } from "crypto";
import { env } from "../../config/env";
import type { User } from "../../generated/prisma/client";

export type Meta = { userAgent: string; ip: string };
type PublicUser = {
  id: string;
  name: string;
  email: string;
  upiId: string | null;
  avatarUrl: string | null;
  emailNotifications: boolean;
};
const DAY_MS = 24 * 60 * 60 * 1000;
const DUMMY_HASH = bcrypt.hashSync("timing-safe-placeholder", 12);

// Two tabs can refresh at the same moment; only a reuse after this is treated as theft
const REUSE_GRACE_MS = 10_000;

const toPublicUser = (u: User): PublicUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  upiId: u.upiId ?? null,
  avatarUrl: u.avatarUrl ?? null,
  emailNotifications: u.emailNotifications !== false,
});

const hashPassword = (password: string) => bcrypt.hash(password, 12);

/** Allowed profile photo types, checked from the file's first bytes */
function photoType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const RESET_TTL_MS = 15 * 60 * 1000;
// Real, signed-in-able accounts only (not deleted, not "not on Hisaab yet")
const activeUser = { deletedAt: null, placeholder: false };

const findActive = (id: string) => prisma.user.findFirst({ where: { id, ...activeUser } });

async function revokeAllSessions(userId: string) {
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

async function startSession(
  userId: string,
  meta: Meta,
  familyId: string = randomUUID(),
) {
  const refreshToken = newRefreshToken();
  await prisma.session.create({
    data: {
      userId,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * DAY_MS),
      userAgent: meta.userAgent,
      ip: meta.ip,
    },
  });
  return refreshToken;
}

export const authService = {
  async register(data: RegisterInput, meta: Meta) {
    const existes = await prisma.user.findUnique({ where: { email: data.email }, select: { id: true } });
    if (existes) {
      throw new AppError(409, "Email already registered");
    }

    const user = await prisma.user.create({
      data: { name: data.name, email: data.email, password: await hashPassword(data.password) },
    });

    // Sign the new user in straight away
    const refreshToken = await startSession(user.id, meta);

    // Welcome email (doesn't hold up sign-up; failures are only logged)
    const welcome = emailLayout({
      heading: `Welcome to Hisaab, ${user.name.split(" ")[0]}!`,
      lines: [
        "Make a group for your trip, flat or office lunches, add what everyone paid, and Hisaab works out who owes whom.",
        "Tip: add your UPI ID in Settings so friends can pay you in one tap.",
      ],
      button: { label: "Open Hisaab", url: `${env.APP_URL}/dashboard` },
      footer: "You get this because you just made a Hisaab account.",
    });
    void sendMail({ to: user.email, subject: "Welcome to Hisaab", ...welcome });

    return {
      accessToken: signAccessToken(user.id),
      refreshToken,
      user: toPublicUser(user),
    };
  },

  async login({ email, password }: LoginInput, meta: Meta) {
    const user = await prisma.user.findFirst({ where: { email, ...activeUser } });
    const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
    if (!user || !ok) {
      throw new AppError(401, "Email or password is incorrect");
    }

    const refreshToken = await startSession(user.id, meta);

    return {
      accessToken: signAccessToken(user.id),
      refreshToken,
      user: toPublicUser(user),
    };
  },

  /**
   * Swap a refresh token for a new access token + a new refresh token.
   * The old session is claimed in one atomic update, so the same token
   * can never be used twice.
   */
  async refresh(token: string | undefined, meta: Meta) {
    if (!token) {
      throw new AppError(401, "Not signed in");
    }

    const tokenHash = hashToken(token);
    const now = new Date();

    // UPDATE … RETURNING claims the session in one statement
    const [session] = await prisma.$queryRaw<{ userId: string; familyId: string }[]>`
      UPDATE "Session" SET "revokedAt" = ${now}, "updatedAt" = ${now}
      WHERE "tokenHash" = ${tokenHash} AND "revokedAt" IS NULL AND "expiresAt" > ${now}
      RETURNING "userId", "familyId"`;

    if (!session) {
      const old = await prisma.session.findUnique({ where: { tokenHash } });
      if (
        old?.revokedAt &&
        now.getTime() - old.revokedAt.getTime() > REUSE_GRACE_MS
      ) {
        // A rotated token came back: probably stolen. End the whole family.
        await prisma.session.updateMany({
          where: { familyId: old.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      throw new AppError(401, "Your session has ended. Log in again.");
    }

    const user = await findActive(session.userId);
    if (!user) {
      throw new AppError(401, "Your session has ended. Log in again.");
    }

    const refreshToken = await startSession(user.id, meta, session.familyId);

    return {
      accessToken: signAccessToken(user.id),
      refreshToken,
      user: toPublicUser(user),
    };
  },

  async logout(token: string | undefined) {
    if (!token) return;
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async getMe(userId: string) {
    const user = await findActive(userId);
    if (!user) {
      throw new AppError(401, "Not Signed in");
    }

    return toPublicUser(user);
  },

  async updateProfile(userId: string, input: UpdateProfileInput) {
    const res = await prisma.user.updateMany({ where: { id: userId, ...activeUser }, data: input });
    if (res.count === 0) throw new AppError(401, "Not signed in");
    return toPublicUser((await findActive(userId))!);
  },

  /** Signs out every other device too, then starts a fresh session here. */
  async changePassword(userId: string, currentPassword: string, newPassword: string, meta: Meta) {
    const user = await findActive(userId);
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      throw new AppError(400, "Your current password is incorrect");
    }
    await prisma.user.update({ where: { id: userId }, data: { password: await hashPassword(newPassword) } });
    await revokeAllSessions(userId);
    const refreshToken = await startSession(user.id, meta);
    return { accessToken: signAccessToken(user.id), refreshToken, user: toPublicUser(user) };
  },

  /**
   * Always answers the same way, so nobody can use this to find out which
   * emails have accounts. If the account exists, a 15-minute link is emailed.
   */
  async forgotPassword(email: string) {
    const user = await prisma.user.findFirst({ where: { email, ...activeUser } });
    if (!user) return;

    const token = randomBytes(32).toString("base64url");
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });

    const link = `${env.APP_URL}/reset-password?token=${token}`;
    await sendMail({
      to: user.email,
      subject: "Reset your Hisaab password",
      ...emailLayout({
        heading: "Reset your password",
        lines: [`Hi ${user.name.split(" ")[0]}, someone (hopefully you) asked to reset your Hisaab password.`, "The link works for 15 minutes."],
        button: { label: "Set a new password", url: link },
        footer: "If you didn’t ask for this, ignore this email. Your password stays the same.",
      }),
    });
  },

  async resetPassword(token: string, newPassword: string) {
    // Claim the token atomically so it can only ever be used once
    const now = new Date();
    const [reset] = await prisma.$queryRaw<{ userId: string }[]>`
      UPDATE "PasswordReset" SET "usedAt" = ${now}, "updatedAt" = ${now}
      WHERE "tokenHash" = ${hashToken(token)} AND "usedAt" IS NULL AND "expiresAt" > ${now}
      RETURNING "userId"`;
    if (!reset) throw new AppError(400, "This reset link has expired or was already used. Ask for a new one.");

    const user = await findActive(reset.userId);
    if (!user) throw new AppError(400, "This reset link has expired or was already used. Ask for a new one.");
    await prisma.user.update({ where: { id: user.id }, data: { password: await hashPassword(newPassword) } });
    await revokeAllSessions(user.id); // anyone signed in with the old password is signed out
  },

  /**
   * Deleting is only allowed when every balance is ₹0. The account leaves all
   * groups and is anonymised; old expenses keep showing "Deleted user".
   */
  async deleteAccount(userId: string, password: string) {
    const user = await findActive(userId);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new AppError(400, "Your password is incorrect");
    }

    const summary = await balanceService.summaryFor(userId);
    const unsettled = summary.groups.find((g) => g.net !== 0);
    if (unsettled) {
      throw new AppError(
        409,
        `Settle up first: you still have a ${formatPaise(Math.abs(unsettled.net))} balance in one of your groups.`,
      );
    }

    const memberships = await prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } });
    for (const { groupId } of memberships) {
      const g = await loadGroup(groupId);
      if (g) await groupService.removeMember(g, userId, "member", userId);
    }

    if (user.avatarPublicId) {
      await cloudinary.destroy(user.avatarPublicId).catch(() => {});
    }
    await prisma.user.update({
      where: { id: userId },
      data: {
        name: "Deleted user",
        email: `deleted+${user.id}@hisaab.invalid`,
        password: randomBytes(32).toString("hex"),
        upiId: null,
        avatarUrl: null,
        avatarPublicId: null,
        deletedAt: new Date(),
      },
    });
    await revokeAllSessions(userId);
  },

  /** Upload or replace the profile photo (one per person, same Cloudinary id each time). */
  async setAvatar(userId: string, body: unknown) {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError(400, "Send the photo as the request body");
    if (body.length > 5 * 1024 * 1024) throw new AppError(413, "That photo is over 5 MB");
    const mime = photoType(body);
    if (!mime) throw new AppError(415, "Use a JPG, PNG or WebP photo");
    const user = await findActive(userId);
    if (!user) throw new AppError(404, "Account not found");

    const up = await cloudinary.upload(body, mime, { folder: "hisaab/avatars", publicId: user.id, overwrite: true });
    // A version in the URL means browsers fetch the new photo instead of a cached old one
    const saved = await prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: cloudinary.avatarUrl(up.secure_url), avatarPublicId: up.public_id },
    });
    return toPublicUser(saved);
  },

  async removeAvatar(userId: string) {
    const user = await findActive(userId);
    if (!user) throw new AppError(404, "Account not found");
    if (user.avatarPublicId) {
      await cloudinary.destroy(user.avatarPublicId);
      return toPublicUser(await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: null, avatarPublicId: null } }));
    }
    return toPublicUser(user);
  },
};
