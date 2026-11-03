import { Schema, model, Types, InferSchemaType } from "mongoose";

export const GROUP_TYPES = ["trip", "home", "other"] as const;
export const MEMBER_ROLES = ["admin", "member"] as const;
export const MAX_MEMBERS = 50;

const memberSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    role: {
      type: String,
      enum: MEMBER_ROLES,
      default: "member",
      required: true,
    },
    joinedAt: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const groupSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 60,
    },
    type: { type: String, enum: GROUP_TYPES, default: "other", required: true },
    members: {
      type: [memberSchema],
      validate: {
        validator: (v: unknown[]) => v.length >= 1 && v.length <= MAX_MEMBERS,
        message: `A group needs 1 to ${MAX_MEMBERS} members`,
      },
    },
    inviteCode: { type: String, required: true, unique: true },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    // Optional spending budget for the whole group, in paise
    budget: { type: Number, min: 0, default: null },
    // Trip kitty: the member holding the shared pot (null = no kitty)
    kittyHolderId: { type: Types.ObjectId, ref: "User", default: null },
    // Everyone should be settled by this day; Hisaab reminds people who still owe
    settleBy: { type: Date, default: null },
    // A finished trip: nothing can be added or changed until an admin reopens it
    closedAt: { type: Date, default: null },
    closedBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, versionKey: false },
);

// "Which groups am I in?" is the most common query
groupSchema.index({ "members.userId": 1 });

export type Group = InferSchemaType<typeof groupSchema>;
export const GroupModel = model("Group", groupSchema);
export type GroupDoc = InstanceType<typeof GroupModel>;
