/** A unique index said no (Prisma error P2002, or PostgreSQL 23505 from raw SQL). */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string }; meta?: { driverAdapterError?: { cause?: { kind?: string } } } };
  return (
    e.code === "P2002" ||
    e.code === "23505" ||
    e.cause?.code === "23505" ||
    e.meta?.driverAdapterError?.cause?.kind === "UniqueConstraintViolation"
  );
}
