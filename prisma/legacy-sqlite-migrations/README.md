# Legacy SQLite migration history

These migration files are retained for reference only. They target SQLite and
must not be run against the PostgreSQL database configured by
`prisma/schema.prisma`.

The active PostgreSQL migration history starts at
`prisma/migrations/20261019095600_postgresql_baseline`.

For a fresh PostgreSQL database, run `npx prisma migrate deploy`. For an
existing database whose schema is already managed by `prisma db push`, first
verify that its schema matches `prisma/schema.prisma`, then mark the baseline
as applied with:

```sh
npx prisma migrate resolve --applied 20261019095600_postgresql_baseline
```

Do not mark the baseline as applied on an empty or mismatched database; use
`npx prisma migrate deploy` for an empty database instead.
