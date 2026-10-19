# Archived PostgreSQL migration history

These migration files are retained for reference only and are not active Prisma
migrations. The production database already contains a schema, so replaying the
initial baseline migration without a migration baseline causes Prisma P3005.

Railway synchronizes the schema from `prisma/schema.prisma` using
`prisma db push` during `npm start`. The active `prisma/migrations` directory
intentionally contains no migrations, preventing a stale `prisma migrate deploy`
command from attempting to replay this history.

Use `npm run build` for Build and `npm start` for Start in Railway. Clear any
custom Build, Pre-deploy, or Start command that invokes `prisma migrate deploy`.
The Start command runs `db:prepare` before starting the server, so a custom
Start command can bypass schema synchronization.
