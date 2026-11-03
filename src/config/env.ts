import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5001),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).max(60).default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  // Where the frontend lives, used to build links in emails (password reset)
  APP_URL: z.string().default('http://localhost:5173'),
  // Optional: with a Resend key, emails are really sent; without one they're logged
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Hisaab <onboarding@resend.dev>'),
  // Optional: Razorpay keys turn on "Pay online". Test keys start with rzp_test_
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  // Optional: only needed for the webhook (Razorpay Dashboard → Webhooks)
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_API_BASE: z.string().default('https://api.razorpay.com/v1'),
  // Optional: Cloudinary stores profile photos and receipts (without it, receipts go in MongoDB)
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_API_BASE: z.string().default('https://api.cloudinary.com/v1_1'),
  RESEND_API_BASE: z.string().default('https://api.resend.com'),
  // How often to check for people to remind about a group's settle-by date (minutes)
  REMINDER_INTERVAL_MIN: z.coerce.number().min(0.05).default(60),
  // Exchange rates for foreign-currency expenses (free, no key)
  FX_API_BASE: z.string().default('https://api.frankfurter.app'),
  FX_FALLBACK_BASE: z.string().default('https://open.er-api.com/v6'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.issues);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';