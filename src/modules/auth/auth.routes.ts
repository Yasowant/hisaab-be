import express, { Router, Request, Response } from "express";
import { authService } from "./auth.service";
import { authController } from "./auth.controller";
import { validate } from "../../middlewares/validate";
import {
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from "./auth.schema";
import { loginLimiter, refreshLimiter, sensitiveLimiter } from "../../middlewares/rateLimit";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

router.post("/register", validate(registerSchema), authController.register);
router.post(
  "/login",
  loginLimiter,
  validate(loginSchema),
  authController.login,
);
router.post("/refresh", refreshLimiter, authController.refresh);
router.post("/logout", authController.logout);
router.get("/me", requireAuth, authController.me);
router.patch("/me", requireAuth, validate(updateProfileSchema), authController.updateProfile);
// Profile photo: the image itself is the request body
router.put(
  "/me/avatar",
  requireAuth,
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: 5 * 1024 * 1024 }),
  async (req: Request, res: Response) => {
    const user = await authService.setAvatar(req.user!.id, req.body);
    res.json({ success: true, message: "Profile photo saved", data: { user } });
  },
);
router.delete("/me/avatar", requireAuth, async (req: Request, res: Response) => {
  const user = await authService.removeAvatar(req.user!.id);
  res.json({ success: true, message: "Profile photo removed", data: { user } });
});
router.delete("/me", requireAuth, sensitiveLimiter, validate(deleteAccountSchema), authController.deleteAccount);
router.post("/change-password", requireAuth, sensitiveLimiter, validate(changePasswordSchema), authController.changePassword);
router.post("/forgot-password", sensitiveLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post("/reset-password", sensitiveLimiter, validate(resetPasswordSchema), authController.resetPassword);

export default router;
