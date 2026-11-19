# Hisaab backend (TypeScript + PostgreSQL)

Express 5 API for Hisaab, using PostgreSQL through Prisma 7.

## Run locally
```bash
npm install                  # also runs `prisma generate`
cp .env.example .env         # set DATABASE_URL and JWT_ACCESS_SECRET
npx prisma migrate dev       # creates the tables (first time, and after schema changes)
npm run dev                  # development (auto reload)
npm run build && npm start   # production (start applies any new migrations first)
```

Check: GET http://localhost:5001/health

A local PostgreSQL is easiest with Docker:
```bash
docker run -d --name hisaab-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hisaab -p 5432:5432 postgres:16
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hisaab
```

## Database
- Schema: `prisma/schema.prisma`. Migrations: `prisma/migrations/`.
- Changed the schema? `npx prisma migrate dev --name what-changed`, then commit the new migration folder.
- Browse the data: `npm run db:studio`.
- Ids are 24-character hex strings (same shape as the old MongoDB ids), made by `hisaab_id()` in the database or `newId()` in `src/utils/id.ts`.
- Money is whole paise in `Int` columns.
- Without Cloudinary, receipt files are stored in the `ExpenseReceipt` table.
- Expired sessions, used reset links and 90-day-old notifications are removed by the reminder sweep (MongoDB used to do this with TTL indexes).

## Deploying (Render)
- Add a PostgreSQL database (Render, Neon or Supabase) and set `DATABASE_URL` on the web service. Use the pooled/internal URL if your provider gives one.
- Build command: `npm install && npm run build`. Start command: `npm start` (runs `prisma migrate deploy` first).
