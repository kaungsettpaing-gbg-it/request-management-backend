# Request Management Backend

The application stores users, requests, and audit logs in MongoDB through Mongoose. Set `MONGODB_URI` and a random `JWT_SECRET` of at least 32 bytes in the environment before starting the server. Generate a key with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`. Copy `.env.example` to `.env` for local development. Set a unique `SUPER_ADMIN_PASSWORD` (at least 12 characters) when bootstrapping a new database or migrating an existing administrator.

```sh
npm install
npm start
```

New registrations receive the `STAFF` role. The login endpoint returns an eight-hour bearer token; protected API requests must send it as `Authorization: Bearer <token>`. User management is restricted to administrators, and approval actions are checked against the request workflow on the server.

## Moving existing SQLite data

Before switching the application to MongoDB, back up `prisma/dev.db`, configure `MONGODB_URI`, and set `SUPER_ADMIN_PASSWORD` to rotate the imported Super Admin password. The migration reads users, requests, and audit logs from the existing Prisma SQLite database, hashes any legacy plaintext passwords, preserves numeric IDs and relationships, and can be safely rerun after an interrupted import.

```sh
npm run db:migrate:mongodb
npm start
```

Keep the SQLite backup until the imported data has been checked. After cutover, the running application reads and writes only MongoDB.
