# Legacy SQLite migration history

These migration files are retained for reference only. They target SQLite and
must not be run against the PostgreSQL database configured by
`prisma/schema.prisma`.

The active PostgreSQL migration directory is retained for reference, but this
project's Railway deployment synchronizes the schema with `prisma db push`;
it does not use migration deployment. The deployment sequence is configured
in `package.json`, `railway.json`, and `nixpacks.toml`.

Do not run a migration deployment command for this application. On Railway,
clear any custom Build, Pre-deploy, or Start command that invokes migration
deployment and use `npm run build` for Build and `npm start` for Start.
