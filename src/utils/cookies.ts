import { Response } from "express";
import { env, isProd } from "../config/env";

export const REFRESH_COOKIE = "rt";
const DAY_MS = 24 * 60 * 60 * 1000;

const baseOptions = {
  httpOnly: true,
  secure: isProd || env.COOKIE_SAMESITE === "none",
  sameSite: env.COOKIE_SAMESITE,
  path: "/api/v1/auth", 
} as const;

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    ...baseOptions,
    maxAge: env.REFRESH_TOKEN_DAYS * DAY_MS,
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, baseOptions);
}
