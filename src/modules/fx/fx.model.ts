import { Schema, model } from "mongoose";

/** Exchange rates we've already looked up: "THB:2026-11-02" → rupees per baht. */
const fxRateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    rate: { type: Number, required: true },
    rateDate: { type: String, required: true }, // the day the rate is for (weekends use Friday's)
    source: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
  },
  { versionKey: false },
);

export const FxRateModel = model("FxRate", fxRateSchema);
