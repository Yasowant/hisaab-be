import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { env } from "./env";
import { logger } from "../utils/logger";

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
});

export const prisma = new PrismaClient({ adapter });

let connected = false;

export async function connectDB(): Promise<void> {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`; // fail fast if the database can't be reached
  connected = true;
  logger.info("✅ PostgreSQL connected");
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect();
  connected = false;
}

/** For /health: can we still run a query? */
export async function dbIsUp(): Promise<boolean> {
  if (!connected) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
