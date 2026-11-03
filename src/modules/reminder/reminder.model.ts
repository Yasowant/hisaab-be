import { Schema, model, Types } from "mongoose";

/** When someone was last reminded about a group, so nobody is reminded too often. */
const reminderSchema = new Schema(
  {
    groupId: { type: Types.ObjectId, ref: "Group", required: true },
    userId: { type: Types.ObjectId, ref: "User", required: true }, // the person who owes
    lastSentAt: { type: Date, required: true },
  },
  { versionKey: false },
);
reminderSchema.index({ groupId: 1, userId: 1 }, { unique: true });

export const ReminderModel = model("Reminder", reminderSchema);
