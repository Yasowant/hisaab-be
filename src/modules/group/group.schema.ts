import { z } from "zod";
import { GROUP_TYPES } from "./group.model";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const createGroupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the group a name")
    .max(60, "Keep it under 60 characters"),
  type: z.enum(GROUP_TYPES).default("other"),
});

export const updateGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    type: z.enum(GROUP_TYPES).optional(),
    regenerateInviteCode: z.literal(true).optional(),
    // Paise; null removes the budget
    budget: z.number().int().min(100, "Set a budget of at least ₹1").max(100_00_00_000).nullable().optional(),
    // A member's id to start a trip kitty with them holding it; null turns the kitty off
    kittyHolderId: objectId.nullable().optional(),
    // A day like "2026-11-15"; null removes it
    settleBy: z.coerce.date().nullable().optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    "Send at least one field to change",
  );

export const joinGroupSchema = z.object({
  inviteCode: z.string().trim().length(10, "Invite codes are 10 characters"),
});

export const changeRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

export const addPlaceholderSchema = z.object({
  name: z.string().trim().min(2, "Enter at least 2 characters").max(50),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type JoinGroupInput = z.infer<typeof joinGroupSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
