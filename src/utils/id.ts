import { randomBytes } from "node:crypto";

/**
 * Ids are 24 hex characters, the same shape MongoDB used: 8 for the time in
 * seconds, then 16 random. Rows get one from the database (hisaab_id()), but
 * use this when the id is needed before the row is saved.
 */
export function newId(): string {
  const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  return seconds + randomBytes(8).toString("hex");
}

const ID = /^[a-f\d]{24}$/i;

/** Looks like one of our ids (cheap check before a database lookup). */
export const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
