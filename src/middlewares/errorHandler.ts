import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../utils/AppError";
import { logger } from "../utils/logger";
import { isProd } from "../config/env";

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: err.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
  }

  // Body parser errors: too large, bad JSON (they carry their own 4xx status)
  const bodyErr = err as { type?: string; status?: number; expose?: boolean };
  if (bodyErr?.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "That upload is too large" });
  }
  if (bodyErr?.expose && typeof bodyErr.status === "number" && bodyErr.status < 500) {
    return res.status(bodyErr.status).json({ success: false, message: "The request body couldn’t be read" });
  }

  if (err instanceof AppError) {
    return res
      .status(err.statusCode)
      .json({ success: false, message: err.message });
  }

  // Duplicate key (e.g. two register requests at the same time)
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === 11000
  ) {
    return res
      .status(409)
      // Registration checks the email itself; anything else is a duplicate we didn't expect
      .json({ success: false, message: "That already exists. Refresh and try again." });
  }

  logger.error({ err }, "Unhandled error");
  return res.status(500).json({
    success: false,
    message: "Internal server error",
    ...(isProd ? {} : { stack: (err as Error)?.stack }),
  });
};
