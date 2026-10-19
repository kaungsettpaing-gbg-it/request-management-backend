require('dotenv').config();

const { assertPostgresDatabaseUrl } = require('../lib/database-url');

try {
  assertPostgresDatabaseUrl(process.env.DATABASE_URL);
  if (typeof process.env.JWT_SECRET !== 'string' ||
      Buffer.byteLength(process.env.JWT_SECRET, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
