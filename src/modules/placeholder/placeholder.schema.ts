import { z } from "zod";

// An admin can link a placeholder to any real member; anyone else claims it for themselves
export const claimSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id").optional(),
});
