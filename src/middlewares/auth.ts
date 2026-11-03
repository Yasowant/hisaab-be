import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/tokens";
import { AppError } from "../utils/AppError";

export const requireAuth = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const header = req.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) throw new AppError(401, "Not signed in");

  try {
    req.user = { id: verifyAccessToken(token).sub };
  } catch {
    throw new AppError(401, "Your session has expired");
  }
  next();
};
