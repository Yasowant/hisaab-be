import mongoose, { ClientSession } from "mongoose";

/**
 * Runs `fn` in a MongoDB transaction: every write inside either all saves or
 * none does. withTransaction retries on temporary errors, so `fn` may run
 * more than once; keep it free of side effects outside the database.
 * Needs a replica set (MongoDB Atlas always is one).
 */
export async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
