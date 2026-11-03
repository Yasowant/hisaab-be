import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp } from "pino-http";
import mongoose from "mongoose";

import { env } from "./config/env";
import { logger } from "./utils/logger";
import { notFound } from "./middlewares/notFound";
import { errorHandler } from "./middlewares/errorHandler";
import authRoutes from "./modules/auth/auth.routes";
import groupRoutes from "./modules/group/group.routes";
import meRoutes from "./modules/balance/me.routes";
import friendRoutes from "./modules/friend/friend.routes";
import fxRoutes from "./modules/fx/fx.routes";
import { paymentRoutes } from "./modules/payment/payment.routes";
import notificationRoutes from "./modules/notification/notification.routes";
import cookieParser from "cookie-parser";

const app = express();

app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN.split(","), credentials: true }));
// Payment routes come first: the Razorpay webhook needs the raw, unparsed body
app.use("/api/v1/payments", (req, res, next) => (req.path === "/webhook" ? paymentRoutes(req, res, next) : next()));
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));

// Health check: shows server + DB status
app.get("/health", (_req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? "ok" : "degraded",
    db: dbUp ? "connected" : "disconnected",
    uptime: process.uptime(),
  });
});

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/groups", groupRoutes);
app.use("/api/v1/me/friends", friendRoutes);
app.use("/api/v1/fx", fxRoutes);
app.use("/api/v1/me", meRoutes);
app.use("/api/v1/me", notificationRoutes);
app.use("/api/v1/payments", paymentRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
