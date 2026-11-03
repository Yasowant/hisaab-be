import { createHash } from "node:crypto";
import { env } from "../config/env";
import { AppError } from "./AppError";

/**
 * A small Cloudinary client over its REST API (no SDK).
 * Every call is signed: SHA-1 of the sorted parameters followed by the API secret.
 * Docs: https://cloudinary.com/documentation/image_upload_api_reference
 */
export const cloudinaryEnabled = () =>
  Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

type Params = Record<string, string | number | boolean | undefined>;
export type ResourceType = "image" | "raw";
/** "upload" = public URL (profile photos); "authenticated" = only through a signed link (receipts) */
export type DeliveryType = "upload" | "authenticated";

export function signParams(params: Params): string {
  const toSign = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHash("sha1").update(toSign + env.CLOUDINARY_API_SECRET).digest("hex");
}

const base = (resourceType: ResourceType) => `${env.CLOUDINARY_API_BASE}/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}`;
const now = () => Math.floor(Date.now() / 1000);

function ensureEnabled() {
  if (!cloudinaryEnabled()) throw new AppError(503, "Photo uploads aren’t set up on this server");
}

export type Uploaded = {
  public_id: string;
  secure_url: string;
  format: string;
  resource_type: ResourceType;
  type: DeliveryType;
  bytes: number;
  version: number;
};

export const cloudinary = {
  async upload(
    file: Buffer,
    mime: string,
    opts: { folder: string; publicId?: string; resourceType?: ResourceType; type?: DeliveryType; overwrite?: boolean },
  ): Promise<Uploaded> {
    ensureEnabled();
    const params: Params = {
      folder: opts.folder,
      public_id: opts.publicId,
      type: opts.type ?? "upload",
      overwrite: opts.overwrite,
      invalidate: opts.overwrite ? true : undefined, // refresh cached copies of a replaced photo
      timestamp: now(),
    };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) form.append(k, String(v));
    form.append("api_key", env.CLOUDINARY_API_KEY!);
    form.append("signature", signParams(params));
    form.append("file", new Blob([new Uint8Array(file)], { type: mime }), "upload");

    const res = await fetch(`${base(opts.resourceType ?? "image")}/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as Uploaded & { error?: { message?: string } };
    if (!res.ok) throw new AppError(502, `Couldn’t save the file: ${data.error?.message ?? `Cloudinary error ${res.status}`}`);
    return data;
  },

  async destroy(publicId: string, resourceType: ResourceType = "image", type: DeliveryType = "upload") {
    if (!cloudinaryEnabled()) return;
    const params: Params = { public_id: publicId, type, invalidate: true, timestamp: now() };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) form.append(k, String(v));
    form.append("api_key", env.CLOUDINARY_API_KEY!);
    form.append("signature", signParams(params));
    await fetch(`${base(resourceType)}/destroy`, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
  },

  /** A short-lived signed link to a private ("authenticated") file, fetched by our server only. */
  privateDownloadUrl(publicId: string, format: string, resourceType: ResourceType = "image", type: DeliveryType = "authenticated") {
    ensureEnabled();
    const params: Params = {
      public_id: publicId,
      format,
      type,
      attachment: false,
      expires_at: now() + 300,
      timestamp: now(),
    };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    qs.set("api_key", env.CLOUDINARY_API_KEY!);
    qs.set("signature", signParams(params));
    return `${base(resourceType)}/download?${qs.toString()}`;
  },

  /** Square, face-centred, small and in the best format for the browser */
  avatarUrl(secureUrl: string) {
    return secureUrl.replace("/upload/", "/upload/c_fill,g_face,w_256,h_256,f_auto,q_auto/");
  },
};
