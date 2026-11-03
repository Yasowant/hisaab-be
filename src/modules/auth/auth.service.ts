import { UserModel } from "../user/user.model";
import { AppError } from "../../utils/AppError";
import { LoginInput, RegisterInput, UpdateProfileInput } from "./auth.schema";
import { PasswordResetModel } from "../passwordReset/passwordReset.model";
import { GroupModel } from "../group/group.model";
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
import { SessionModel } from "../session/session.model";
import { env } from "../../config/env";

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

const toPublicUser = (u: {
  id: string;
  name: string;
  email: string;
  upiId?: string | null;
  avatar?: { url: string } | null;
  emailNotifications?: boolean | null;
}): PublicUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  upiId: u.upiId ?? null,
  avatarUrl: u.avatar?.url ?? null,
  emailNotifications: u.emailNotifications !== false,
});

/** Allowed profile photo types, checked from the file's first bytes */
function photoType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const RESET_TTL_MS = 15 * 60 * 1000;
// Real, signed-in-able accounts only (not deleted, not "not on Hisaab yet")
const activeUser = { deletedAt: null, placeholder: { $ne: true } };

async function revokeAllSessions(userId: string) {
  await SessionModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

async function startSession(
  userId: string,
  meta: Meta,
  familyId: string = randomUUID(),
) {
  const refreshToken = newRefreshToken();
  await SessionModel.create({
    userId,
    familyId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * DAY_MS),
    userAgent: meta.userAgent,
    ip: meta.ip,
  });
  return refreshToken;
}

export const authService = {
  async register(data: RegisterInput, meta: Meta) {
    const existes = await UserModel.exists({ email: data.email });
    if (existes) {
      throw new AppError(409, "Email already registered");
    }

    const user = await UserModel.create(data);

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
    const user = await UserModel.findOne({ email, ...activeUser }).select("+password");
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

    const session = await SessionModel.findOneAndUpdate(
      { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { revokedAt: now } },
    );

    if (!session) {
      const old = await SessionModel.findOne({ tokenHash });
      if (
        old?.revokedAt &&
        now.getTime() - old.revokedAt.getTime() > REUSE_GRACE_MS
      ) {
        // A rotated token came back: probably stolen. End the whole family.
        await SessionModel.updateMany(
          { familyId: old.familyId, revokedAt: null },
          { $set: { revokedAt: now } },
        );
      }
      throw new AppError(401, "Your session has ended. Log in again.");
    }

    const user = await UserModel.findOne({ _id: session.userId, ...activeUser });
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
    await SessionModel.updateOne(
      { tokenHash: hashToken(token), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  },

  async getMe(userId: string) {
    const user = await UserModel.findOne({ _id: userId, ...activeUser });
    if (!user) {
      throw new AppError(401, "Not Signed in");
    }

    return toPublicUser(user);
  },

  async updateProfile(userId: string, input: UpdateProfileInput) {
    const user = await UserModel.findOneAndUpdate(
      { _id: userId, ...activeUser },
      { $set: input },
      { returnDocument: "after", runValidators: true },
    );
    if (!user) throw new AppError(401, "Not signed in");
    return toPublicUser(user);
  },

  /** Signs out every other device too, then starts a fresh session here. */
  async changePassword(userId: string, currentPassword: string, newPassword: string, meta: Meta) {
    const user = await UserModel.findOne({ _id: userId, ...activeUser }).select("+password");
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      throw new AppError(400, "Your current password is incorrect");
    }
    user.password = newPassword; // hashed by the pre-save hook
    await user.save();
    await revokeAllSessions(userId);
    const refreshToken = await startSession(user.id, meta);
    return { accessToken: signAccessToken(user.id), refreshToken, user: toPublicUser(user) };
  },

  /**
   * Always answers the same way, so nobody can use this to find out which
   * emails have accounts. If the account exists, a 15-minute link is emailed.
   */
  async forgotPassword(email: string) {
    const user = await UserModel.findOne({ email, ...activeUser });
    if (!user) return;

    const token = randomBytes(32).toString("base64url");
    await PasswordResetModel.create({
      userId: user._id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
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
    const reset = await PasswordResetModel.findOneAndUpdate(
      { tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
    );
    if (!reset) throw new AppError(400, "This reset link has expired or was already used. Ask for a new one.");

    const user = await UserModel.findOne({ _id: reset.userId, ...activeUser });
    if (!user) throw new AppError(400, "This reset link has expired or was already used. Ask for a new one.");
    user.password = newPassword;
    await user.save();
    await revokeAllSessions(user.id); // anyone signed in with the old password is signed out
  },

  /**
   * Deleting is only allowed when every balance is ₹0. The account leaves all
   * groups and is anonymised; old expenses keep showing "Deleted user".
   */
  async deleteAccount(userId: string, password: string) {
    const user = await UserModel.findOne({ _id: userId, ...activeUser }).select("+password");
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

    const groups = await GroupModel.find({ "members.userId": userId });
    for (const g of groups) {
      await groupService.removeMember(g, userId, "member", userId);
    }

    user.name = "Deleted user";
    user.email = `deleted+${user.id}@hisaab.invalid`;
    user.password = randomBytes(32).toString("hex");
    user.upiId = null;
    if (user.avatar) {
      await cloudinary.destroy(user.avatar.publicId).catch(() => {});
      user.avatar = null;
    }
    user.deletedAt = new Date();
    await user.save();
    await revokeAllSessions(userId);
  },

  /** Upload or replace the profile photo (one per person, same Cloudinary id each time). */
  async setAvatar(userId: string, body: unknown) {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError(400, "Send the photo as the request body");
    if (body.length > 5 * 1024 * 1024) throw new AppError(413, "That photo is over 5 MB");
    const mime = photoType(body);
    if (!mime) throw new AppError(415, "Use a JPG, PNG or WebP photo");
    const user = await UserModel.findOne({ _id: userId, ...activeUser });
    if (!user) throw new AppError(404, "Account not found");

    const up = await cloudinary.upload(body, mime, { folder: "hisaab/avatars", publicId: user.id, overwrite: true });
    // A version in the URL means browsers fetch the new photo instead of a cached old one
    user.avatar = { url: cloudinary.avatarUrl(up.secure_url), publicId: up.public_id };
    await user.save();
    return toPublicUser(user);
  },

  async removeAvatar(userId: string) {
    const user = await UserModel.findOne({ _id: userId, ...activeUser });
    if (!user) throw new AppError(404, "Account not found");
    if (user.avatar) {
      await cloudinary.destroy(user.avatar.publicId);
      user.avatar = null;
      await user.save();
    }
    return toPublicUser(user);
  },
};
