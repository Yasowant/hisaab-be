import pino from "pino";
import { env, isProd } from "../config/env";

export const logger = pino({
  level: isProd ? "info" : "debug",
  transport:
    env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
});
