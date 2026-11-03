import express, { Router, Request, Response } from "express";
import { paymentService } from "./payment.service";
import { requireAuth } from "../../middlewares/auth";
import { webhookSignatureValid } from "../../utils/razorpay";
import { logger } from "../../utils/logger";
import { validate } from "../../middlewares/validate";
import { createOrderSchema, verifySchema } from "./payment.schema";

/** Group routes: mounted under /groups/:groupId/payments after requireGroupMember */
export const groupPaymentRoutes = Router({ mergeParams: true });

groupPaymentRoutes.post("/order", validate(createOrderSchema), async (req: Request, res: Response) => {
  const order = await paymentService.createOrder(req.group!, req.user!.id, req.body);
  res.status(201).json({ success: true, data: { order } });
});

groupPaymentRoutes.post("/verify", validate(verifySchema), async (req: Request, res: Response) => {
  const payment = await paymentService.verify(req.group!, req.user!.id, req.body);
  res.json({ success: true, message: "Payment successful", data: { payment } });
});

/** App routes: mounted at /api/v1/payments */
export const paymentRoutes = Router();

// Does this server take online payments? The browser asks before showing "Pay online".
paymentRoutes.get("/config", requireAuth, (_req, res) => {
  res.json({ success: true, data: paymentService.config() });
});

// Razorpay → us. Needs the raw body to check the signature, so it parses its own body.
paymentRoutes.post("/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req: Request, res: Response) => {
  const signature = req.get("x-razorpay-signature") ?? "";
  if (!Buffer.isBuffer(req.body) || !webhookSignatureValid(req.body, signature)) {
    res.status(400).json({ success: false, message: "Invalid signature" });
    return;
  }
  try {
    await paymentService.handleWebhook(JSON.parse(req.body.toString("utf8")));
  } catch (err) {
    logger.error({ err }, "Razorpay webhook failed");
    res.status(500).json({ success: false }); // Razorpay retries later
    return;
  }
  res.json({ success: true });
});
