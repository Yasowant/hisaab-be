import { Request, Response } from "express";
import { authService, Meta } from "./auth.service";
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  setRefreshCookie,
} from "../../utils/cookies";

const meta = (req: Request): Meta => ({
  userAgent: req.get("user-agent") ?? "",
  ip: req.ip ?? "",
});

const readRefreshCookie = (req: Request): string | undefined =>
  req.cookies?.[REFRESH_COOKIE];

export const authController = {
  async register(req: Request, res: Response) {
    const { refreshToken, accessToken, user } = await authService.register(
      req.body,
      meta(req),
    );
    setRefreshCookie(res, refreshToken);
    res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: { accessToken, user },
    });
  },

  async login(req: Request, res: Response) {
    const { refreshToken, accessToken, user } = await authService.login(
      req.body,
      meta(req),
    );
    setRefreshCookie(res, refreshToken);
    res.json({
      success: true,
      message: "Logged in",
      data: { accessToken, user },
    });
  },

  async refresh(req: Request, res: Response) {
    try {
      const { refreshToken, accessToken, user } = await authService.refresh(
        readRefreshCookie(req),
        meta(req),
      );
      setRefreshCookie(res, refreshToken);
      res.json({ success: true, data: { accessToken, user } });
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  },

  async logout(req: Request, res: Response) {
    await authService.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
    res.status(204).send();
  },

  async me(req: Request, res: Response) {
    const user = await authService.getMe(req.user!.id);
    res.json({
      success: true,
      data: {
        user,
      },
    });
  },

  async updateProfile(req: Request, res: Response) {
    const user = await authService.updateProfile(req.user!.id, req.body);
    res.json({ success: true, message: "Profile updated", data: { user } });
  },

  async changePassword(req: Request, res: Response) {
    const { refreshToken, accessToken, user } = await authService.changePassword(
      req.user!.id,
      req.body.currentPassword,
      req.body.newPassword,
      meta(req),
    );
    setRefreshCookie(res, refreshToken);
    res.json({ success: true, message: "Password changed. Other devices were signed out.", data: { accessToken, user } });
  },

  async forgotPassword(req: Request, res: Response) {
    await authService.forgotPassword(req.body.email);
    res.json({ success: true, message: "If that email has an account, we've sent a reset link." });
  },

  async resetPassword(req: Request, res: Response) {
    await authService.resetPassword(req.body.token, req.body.password);
    res.json({ success: true, message: "Password reset. Log in with your new password." });
  },

  async deleteAccount(req: Request, res: Response) {
    await authService.deleteAccount(req.user!.id, req.body.password);
    clearRefreshCookie(res);
    res.status(204).send();
  },
};
