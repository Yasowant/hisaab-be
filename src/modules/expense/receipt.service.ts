import mongoose, { isValidObjectId, Types } from "mongoose";
import { Readable } from "node:stream";
import { ExpenseModel } from "./expense.model";
import { GroupDoc } from "../group/group.model";
import { AppError } from "../../utils/AppError";
import { logger } from "../../utils/logger";
import { cloudinary, cloudinaryEnabled } from "../../utils/cloudinary";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the app shrinks photos well below this
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db!, { bucketName: "receipts" });
const extension: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

/** Trust the file's first bytes, not the Content-Type header someone sent. */
function fileType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

async function loadExpense(group: GroupDoc, expenseId: string) {
  if (!isValidObjectId(expenseId)) throw new AppError(404, "Expense not found");
  const e = await ExpenseModel.findOne({ _id: expenseId, groupId: group._id, deletedAt: null }, "paidBy createdBy splits receipt").lean();
  if (!e) throw new AppError(404, "Expense not found");
  return e;
}

type Loaded = Awaited<ReturnType<typeof loadExpense>>;
type Stored = NonNullable<Loaded["receipt"]>;

/** Anyone in the expense (payer, creator, a share), the person who added the file, or an admin. */
function ensureCanEdit(e: Loaded, userId: string, role: string) {
  const involved =
    String(e.paidBy) === userId ||
    String(e.createdBy) === userId ||
    e.splits.some((s) => String(s.userId) === userId) ||
    (e.receipt && String(e.receipt.by) === userId);
  if (role !== "admin" && !involved) {
    throw new AppError(403, "Only people in this expense, or a group admin, can change its receipt");
  }
}

/** Remove a stored file (old or replaced); a failure is logged, never shown to the user. */
async function removeStored(r: Stored) {
  try {
    if (r.provider === "cloudinary" && r.publicId) await cloudinary.destroy(r.publicId, "image", "authenticated");
    else if (r.fileId) await bucket().delete(r.fileId);
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

    let stored: Omit<Stored, "by" | "at">;
    if (cloudinaryEnabled()) {
      // "authenticated": no public link; only our server can fetch it, for group members
      const up = await cloudinary.upload(body, contentType, {
        folder: `hisaab/receipts/${group._id}`,
        type: "authenticated",
      });
      stored = { provider: "cloudinary", fileId: null, publicId: up.public_id, format: up.format || extension[contentType]!, contentType, size: body.length };
    } else {
      const fileId = new Types.ObjectId();
      await new Promise<void>((resolve, reject) => {
        Readable.from(body)
          .pipe(bucket().openUploadStreamWithId(fileId, `receipt-${expenseId}`, { metadata: { contentType, groupId: group._id, expenseId } }))
          .on("finish", () => resolve())
          .on("error", reject);
      });
      stored = { provider: "gridfs", fileId, publicId: null, format: extension[contentType]!, contentType, size: body.length };
    }

    const receipt = { ...stored, by: new Types.ObjectId(userId), at: new Date() };
    const before = await ExpenseModel.findOneAndUpdate(
      { _id: expenseId, groupId: group._id, deletedAt: null },
      { $set: { receipt } },
      { returnDocument: "before", projection: { receipt: 1 } },
    ).lean();
    if (!before) {
      await removeStored(receipt as Stored);
      throw new AppError(404, "Expense not found");
    }
    if (before.receipt) await removeStored(before.receipt);
    return { size: body.length, contentType };
  },

  /** The file as a stream, whichever place it's stored in. */
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
    return { stream: bucket().openDownloadStream(r.fileId!), contentType: r.contentType, size: r.size };
  },

  async remove(group: GroupDoc, userId: string, role: string, expenseId: string) {
    const e = await loadExpense(group, expenseId);
    ensureCanEdit(e, userId, role);
    if (!e.receipt) throw new AppError(404, "This expense has no receipt");
    const res = await ExpenseModel.updateOne({ _id: expenseId, receipt: { $ne: null }, "receipt.at": e.receipt.at }, { $set: { receipt: null } });
    if (res.modifiedCount > 0) await removeStored(e.receipt);
  },
};
