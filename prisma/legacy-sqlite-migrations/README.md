# Legacy SQLite migration history

These migration files are retained for reference only. They target SQLite and
must not be run against the PostgreSQL database configured by
`prisma/schema.prisma`.

The former PostgreSQL migration history is archived under
`prisma/legacy-postgresql-migrations/`.

Railway synchronizes the active schema with `prisma db push` instead of
migration deployment. See `prisma/legacy-postgresql-migrations/README.md` for
the PostgreSQL migration and deployment details.
