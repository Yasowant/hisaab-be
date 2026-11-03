import { z } from "zod";

export const commentInputSchema = z.object({
  text: z.string().trim().min(1, "Write something").max(500, "Keep it under 500 characters"),
});
export type CommentInput = z.infer<typeof commentInputSchema>;
