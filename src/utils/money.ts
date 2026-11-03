export type Share = { userId: string; amount: number };

export function splitEqual(amount: number, userIds: string[]): Share[] {
  const base = Math.floor(amount / userIds.length);
  let leftover = amount - base * userIds.length;
  return userIds.map((userId) => ({
    userId,
    amount: base + (leftover-- > 0 ? 1 : 0),
  }));
}

export function splitByPercent(
  amount: number,
  parts: { userId: string; percent: number }[],
): Share[] {
  const raw = parts.map((p) => {
    const bp = Math.round(p.percent * 100);
    const exact = (amount * bp) / 10_000;
    return {
      userId: p.userId,
      floor: Math.floor(exact),
      fraction: exact - Math.floor(exact),
    };
  });

  let leftover = amount - raw.reduce((sum, r) => sum + r.floor, 0);
  const order = raw
    .map((r, i) => ({ i, fraction: r.fraction }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);

  const shares = raw.map((r) => ({ userId: r.userId, amount: r.floor }));
  for (const { i } of order) {
    if (leftover <= 0) break;
    shares[i]!.amount += 1;
    leftover -= 1;
  }
  return shares;
}

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function formatPaise(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100);
}

/**
 * Share `amount` in proportion to each person's weight (e.g. what they ate),
 * rounding down and handing leftover paise to the largest remainders.
 * Used to spread tax, service charge and tip over an itemized bill.
 */
export function splitByWeights(amount: number, parts: { userId: string; weight: number }[]): Share[] {
  const total = parts.reduce((a, p) => a + p.weight, 0);
  if (total === 0) return splitEqual(amount, parts.map((p) => p.userId));
  const raw = parts.map((p) => {
    const exact = (amount * p.weight) / total;
    return { userId: p.userId, floor: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let leftover = amount - raw.reduce((a, r) => a + r.floor, 0);
  const shares = raw.map((r) => ({ userId: r.userId, amount: r.floor }));
  const order = raw.map((r, i) => ({ i, f: r.fraction })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of order) {
    if (leftover <= 0) break;
    shares[i]!.amount += 1;
    leftover -= 1;
  }
  return shares;
}
