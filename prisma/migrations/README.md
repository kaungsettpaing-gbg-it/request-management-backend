This directory intentionally contains no active migrations. Railway deploys
this application with `prisma db push` from its pre-deploy command, not
`prisma migrate deploy`. Historical SQL files are archived under
`prisma/legacy-postgresql-migrations/`.
