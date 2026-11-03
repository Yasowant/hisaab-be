import { Schema, model, Types, InferSchemaType } from "mongoose";

export const SPLIT_TYPES = ["equal", "exact", "percent", "itemized"] as const;
export const CATEGORIES = [
  "food",
  "travel",
  "stay",
  "rent",
  "utilities",
  "shopping",
  "other",
] as const;
export const MAX_AMOUNT = 10_00_00_000;

const splitSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true },
    amount: { type: Number, required: true, min: 0 },
    percent: { type: Number, min: 0, max: 100 }, 
  },
  { _id: false },
);

// One line of an itemized bill, e.g. "Butter chicken ₹450, shared by Aarav and Meera"
const itemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    amount: { type: Number, required: true, min: 0 }, // paise
    sharedBy: { type: [Types.ObjectId], ref: "User", required: true },
  },
  { _id: false },
);

const expenseSchema = new Schema(
  {
    groupId: { type: Types.ObjectId, ref: "Group", required: true },
    description: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_AMOUNT,
      validate: {
        validator: Number.isInteger,
        message: "Amount must be whole paise",
      },
    },
    paidBy: { type: Types.ObjectId, ref: "User", required: true },
    splitType: { type: String, enum: SPLIT_TYPES, required: true },
    splits: { type: [splitSchema], required: true },
    category: { type: String, enum: CATEGORIES, default: "other" },
    date: { type: Date, required: true },
    createdBy: { type: Types.ObjectId, ref: "User", required: true },
    deletedAt: { type: Date, default: null },
    // Itemized bills keep their lines, plus tax/service/tip shared in proportion
    items: { type: [itemSchema], default: undefined },
    extras: { type: Number, min: 0, default: undefined }, // paise
    // Paid out of the trip kitty (paidBy is then the kitty holder)
    fromKitty: { type: Boolean, default: false },
    // Paid in another currency (amount above is the rupee value used for balances)
    original: {
      type: new Schema(
        {
          currency: { type: String, required: true },
          amount: { type: Number, required: true }, // hundredths of the currency
          rate: { type: Number, required: true }, // rupees per unit
        },
        { _id: false },
      ),
      default: null,
    },
    // Created automatically by a repeating expense
    recurringId: { type: Types.ObjectId, ref: "RecurringExpense", default: null },
    // "Something's wrong": a member flagged it; cleared when it's fixed or explained
    dispute: {
      type: new Schema(
        {
          by: { type: Types.ObjectId, ref: "User", required: true },
          reason: { type: String, required: true, trim: true, maxlength: 300 },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    // Photo or PDF of the bill: on Cloudinary (private), or in MongoDB GridFS when Cloudinary isn't set up
    receipt: {
      type: new Schema(
        {
          provider: { type: String, enum: ["gridfs", "cloudinary"], default: "gridfs" },
          fileId: { type: Types.ObjectId, default: null }, // GridFS
          publicId: { type: String, default: null }, // Cloudinary
          format: { type: String, default: null }, // Cloudinary: jpg, png, pdf…
          contentType: { type: String, required: true },
          size: { type: Number, required: true },
          by: { type: Types.ObjectId, ref: "User", required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

expenseSchema.index({ groupId: 1, deletedAt: 1, date: -1, _id: -1 });
expenseSchema.index({ "splits.userId": 1 });
// Text search on descriptions is done with a case-insensitive regex inside one group,
// so the groupId index above already narrows it down.

export type Expense = InferSchemaType<typeof expenseSchema>;
export const ExpenseModel = model("Expense", expenseSchema);
