import { Readable } from "node:stream";
import { prisma } from "../../config/db";
import { GroupDoc } from "../group/group.model";
import { AppError } from "../../utils/AppError";
import { logger } from "../../utils/logger";
import { isId } from "../../utils/id";
import { cloudinary, cloudinaryEnabled } from "../../utils/cloudinary";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the app shrinks photos well below this
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const extension: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

/** Trust the file's first bytes, not the Content-Type header someone sent. */
function fileType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/** The receipt's details, without the file bytes. */
const receiptMeta = {
  provider: true,
  publicId: true,
  format: true,
  contentType: true,
  size: true,
  byId: true,
  at: true,
} as const;

async function loadExpense(group: GroupDoc, expenseId: string) {
  if (!isId(expenseId)) throw new AppError(404, "Expense not found");
  const e = await prisma.expense.findFirst({
    where: { id: expenseId, groupId: group.id, deletedAt: null },
    select: {
      paidById: true,
      createdById: true,
      splits: { select: { userId: true } },
      receipt: { select: receiptMeta },
    },
  });
  if (!e) throw new AppError(404, "Expense not found");
  return e;
}

type Loaded = Awaited<ReturnType<typeof loadExpense>>;
type Stored = { provider: "database" | "cloudinary"; publicId: string | null };

/** Anyone in the expense (payer, creator, a share), the person who added the file, or an admin. */
function ensureCanEdit(e: Loaded, userId: string, role: string) {
  const involved =
    e.paidById === userId ||
    e.createdById === userId ||
    e.splits.some((s) => s.userId === userId) ||
    e.receipt?.byId === userId;
  if (role !== "admin" && !involved) {
    throw new AppError(403, "Only people in this expense, or a group admin, can change its receipt");
  }
}

/** Remove a replaced file from Cloudinary; a failure is logged, never shown to the user. */
async function removeStored(r: Stored) {
  if (r.provider !== "cloudinary" || !r.publicId) return; // database copies go with their row
  try {
    await cloudinary.destroy(r.publicId, "image", "authenticated");
  } catch (err) {
    logger.warn({ err }, "Couldn't delete old receipt file");
  }
}

export const receiptService = {
  /** Store the photo or PDF, point the expense at it, then remove any older one. */
  async upload(group: GroupDoc, userId: string, role: string, expenseId: string, body: unknown) {
    const e = await loadExpense(group, expenseId);
    ensureCanEdit(e, userId, role);
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError(400, "Send the photo or PDF as the request body");
    const contentType = fileType(body);
    if (!contentType) throw new AppError(415, "Use a JPG, PNG or WebP photo, or a PDF");
    const limit = contentType === "application/pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
    if (body.length > limit) throw new AppError(413, `That file is over ${limit / 1024 / 1024} MB`);

    const stored = cloudinaryEnabled()
      ? await (async () => {
          // "authenticated": no public link; only our server can fetch it, for group members
          const up = await cloudinary.upload(body, contentType, {
            folder: `hisaab/receipts/${group.id}`,
            type: "authenticated",
          });
          return { provider: "cloudinary" as const, data: null, publicId: up.public_id, format: up.format || extension[contentType]! };
        })()
      : { provider: "database" as const, data: new Uint8Array(body), publicId: null, format: extension[contentType]! };

    const receipt = { ...stored, contentType, size: body.length, byId: userId, at: new Date() };

    // The expense may have been deleted meanwhile; check and save together
    const before = await prisma.$transaction(async (tx) => {
      const live = await tx.expense.findFirst({ where: { id: expenseId, groupId: group.id, deletedAt: null }, select: { id: true } });
      if (!live) return null;
      const old = await tx.expenseReceipt.findUnique({ where: { expenseId }, select: { provider: true, publicId: true } });
      await tx.expenseReceipt.upsert({ where: { expenseId }, create: { expenseId, ...receipt }, update: receipt });
      return { old };
    });
    if (!before) {
      await removeStored(receipt);
      throw new AppError(404, "Expense not found");
    }
    if (before.old && before.old.publicId !== receipt.publicId) await removeStored(before.old);
    return { size: body.length, contentType };
  },

  /** The file as a stream, wherever it's stored. */
  async open(group: GroupDoc, expenseId: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number }> {
    const e = await loadExpense(group, expenseId);
    const r = e.receipt;
    if (!r) throw new AppError(404, "This expense has no receipt");
    if (r.provider === "cloudinary" && r.publicId) {
      const res = await fetch(cloudinary.privateDownloadUrl(r.publicId, r.format ?? "jpg"), { signal: AbortSignal.timeout(30_000) });
      if (!res.ok || !res.body) {
        logger.error({ status: res.status, publicId: r.publicId }, "Couldn't fetch receipt from Cloudinary");
        throw new AppError(502, "Couldn’t load the receipt right now. Try again.");
      }
      return { stream: Readable.fromWeb(res.body as never), contentType: r.contentType, size: r.size };
    }
    const file = await prisma.expenseReceipt.findUnique({ where: { expenseId }, select: { data: true } });
    if (!file?.data) throw new AppError(404, "This expense has no receipt");
    return { stream: Readable.from([Buffer.from(file.data)]), contentType: r.contentType, size: r.size };
  },

  async remove(group: GroupDoc, userId: string, role: string, expenseId: string) {
    const e = await loadExpense(group, expenseId);
    ensureCanEdit(e, userId, role);
    if (!e.receipt) throw new AppError(404, "This expense has no receipt");
    // Only if it's still the same file (nobody replaced it meanwhile)
    const res = await prisma.expenseReceipt.deleteMany({ where: { expenseId, at: e.receipt.at } });
    if (res.count > 0) await removeStored(e.receipt);
  },
};
