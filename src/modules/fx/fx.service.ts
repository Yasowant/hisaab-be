import { FxRateModel } from "./fx.model";
import { AppError } from "../../utils/AppError";
import { logger } from "../../utils/logger";
import { env } from "../../config/env";

const today = () => new Date().toISOString().slice(0, 10);
const FRESH_FOR = 6 * 60 * 60 * 1000; // today's rate is looked up again after 6 hours

type Found = { rate: number; rateDate: string; source: string };

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Frankfurter (European Central Bank rates): has history, about 30 currencies. */
async function frankfurter(from: string, date: string): Promise<Found> {
  const day = date === today() ? "latest" : date;
  const body = await getJson(`${env.FX_API_BASE}/${day}?from=${from}&to=INR`);
  const rate = (body.rates as Record<string, number> | undefined)?.INR;
  if (!rate) throw new Error("No INR rate");
  return { rate, rateDate: String(body.date ?? date), source: "European Central Bank" };
}

/** open.er-api.com: today's rate only, but covers nearly every currency (AED, LKR, NPR…). */
async function fallback(from: string): Promise<Found> {
  const body = await getJson(`${env.FX_FALLBACK_BASE}/latest/${from}`);
  const rate = (body.rates as Record<string, number> | undefined)?.INR;
  if (body.result !== "success" || !rate) throw new Error("No INR rate");
  return { rate, rateDate: today(), source: "ExchangeRate-API" };
}

export const fxService = {
  /** Rupees for one unit of `from` on `date` (YYYY-MM-DD, today by default). */
  async rate(from: string, date = today()) {
    if (date > today()) date = today();
    const key = `${from}:${date}`;
    const cached = await FxRateModel.findOne({ key }).lean();
    const stale = cached && date === today() && Date.now() - cached.fetchedAt.getTime() > FRESH_FOR;
    if (cached && !stale) return shape(from, cached);

    let found: Found | null = null;
    for (const source of [() => frankfurter(from, date), () => fallback(from)]) {
      try {
        found = await source();
        break;
      } catch (err) {
        logger.warn({ err: String(err), from, date }, "Exchange rate lookup failed");
      }
    }
    if (!found) {
      if (cached) return shape(from, cached); // an older rate beats none
      throw new AppError(503, "Couldn't get the exchange rate. Type the rate in yourself.");
    }
    const rate = Math.round(found.rate * 1e6) / 1e6;
    await FxRateModel.updateOne(
      { key },
      { $set: { rate, rateDate: found.rateDate, source: found.source, fetchedAt: new Date() } },
      { upsert: true },
    );
    return shape(from, { rate, rateDate: found.rateDate, source: found.source });
  },
};

const shape = (from: string, r: { rate: number; rateDate: string; source: string }) => ({
  from,
  to: "INR",
  rate: r.rate,
  date: r.rateDate,
  source: r.source,
});
