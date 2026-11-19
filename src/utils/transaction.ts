import { prisma } from "../config/db";
import type { Prisma } from "../generated/prisma/client";

/** The database handle inside a transaction. */
export type Tx = Prisma.TransactionClient;
/** Either the normal client or a transaction: functions that can run in both take this. */
export type Db = Tx | typeof prisma;

const afterCommitQueue = new WeakMap<object, (() => void)[]>();

/**
 * Runs `fn` in a PostgreSQL transaction: every write inside either all saves
 * or none does. If `fn` throws, everything is rolled back.
 */
export async function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const callbacks: (() => void)[] = [];
  const result = await prisma.$transaction(
    async (tx) => {
      afterCommitQueue.set(tx, callbacks);
      return fn(tx);
    },
    { maxWait: 5_000, timeout: 15_000 },
  );
  // Only reached when the transaction committed
  for (const cb of callbacks) cb();
  return result;
}

/**
 * Run `fn` once the transaction has saved (right away when not in one).
 * For side effects outside the database: live pings, emails.
 */
export function afterCommit(db: Db, fn: () => void) {
  const queue = afterCommitQueue.get(db);
  if (queue) queue.push(fn);
  else fn();
}
