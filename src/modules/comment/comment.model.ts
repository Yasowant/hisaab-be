import { Schema, model, Types, InferSchemaType } from "mongoose";

// A short note on an expense: "this included Rohan's drinks", "receipt in the group chat"
const commentSchema = new Schema(
  {
    groupId: { type: Types.ObjectId, ref: "Group", required: true },
    expenseId: { type: Types.ObjectId, ref: "Expense", required: true },
    userId: { type: Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true, minlength: 1, maxlength: 500 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

commentSchema.index({ expenseId: 1, deletedAt: 1, createdAt: 1 });

export type Comment = InferSchemaType<typeof commentSchema>;
export const CommentModel = model("Comment", commentSchema);
