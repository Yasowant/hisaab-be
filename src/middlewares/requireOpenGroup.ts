import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/AppError";

/** Reads are fine; adding or changing anything in a closed group is not. Use after requireGroupMember. */
export const requireOpenGroup = (req: Request, _res: Response, next: NextFunction) => {
  if (req.method !== "GET" && req.group?.closedAt) {
    throw new AppError(409, "This group is closed. An admin can reopen it to make changes.");
  }
  next();
};
