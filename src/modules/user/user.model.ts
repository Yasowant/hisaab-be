import bcrypt from "bcryptjs";
import { Schema, InferSchemaType, model } from "mongoose";

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxLength: 50,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    // UPI ID like "name@okaxis", shown to group members so they can pay you
    upiId: {
      type: String,
      trim: true,
      maxLength: 100,
      default: null,
    },
    // Profile photo on Cloudinary (url is already cropped to a small square)
    avatar: {
      type: new Schema({ url: { type: String, required: true }, publicId: { type: String, required: true } }, { _id: false }),
      default: null,
    },
    // Emails about payments and flagged expenses (password emails always go out)
    emailNotifications: {
      type: Boolean,
      default: true,
    },
    // A "member not on Hisaab yet": added by name, claimed later by a real account
    placeholder: {
      type: Boolean,
      default: false,
    },
    // Set when the account is deleted; the row stays so old expenses keep a name
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema);
