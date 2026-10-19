# Archived PostgreSQL migration history

These migration files are retained for reference only and are not active Prisma
migrations. The production database already contains a schema, so replaying the
initial baseline migration without a migration baseline causes Prisma P3005.

Railway synchronizes the schema from `prisma/schema.prisma` using
`prisma db push` in its configured pre-deploy command (`npm run db:prepare`).
The active `prisma/migrations` directory
intentionally contains no migrations, preventing a stale `prisma migrate deploy`
command from attempting to replay this history.

Use `npm run build` for Build, `npm run db:prepare` for Pre-deploy, and
`npm start` for Start in Railway. Clear any custom command that invokes
`prisma migrate deploy`.
