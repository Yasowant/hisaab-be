import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60, 
    algorithm: "HS256",
  });
}

/** Throws if the token is missing, tampered with or expired. */
export function verifyAccessToken(token: string): { sub: string } {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ["HS256"],
  });
  if (typeof payload === "string" || !payload.sub)
    throw new Error("Invalid token payload");
  return { sub: payload.sub };
}

/** 64 random bytes: impossible to guess. Only its hash is saved. */
export const newRefreshToken = () => randomBytes(64).toString("base64url");

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
