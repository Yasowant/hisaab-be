import type { GroupDoc } from "../modules/group/group.model";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string };
      group?: GroupDoc; // set by requireGroupMember
      memberRole?: "admin" | "member"; // set by requireGroupMember
    }
  }
}

export {};
