require('dotenv').config();

const { assertPostgresDatabaseUrl } = require('../lib/database-url');

try {
  assertPostgresDatabaseUrl(process.env.DATABASE_URL);
  if (typeof process.env.JWT_SECRET !== 'string' ||
      Buffer.byteLength(process.env.JWT_SECRET, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes.');
  }
  if (process.env.TELEGRAM_BOT_USERNAME &&
      !/^[A-Za-z0-9_]{5,32}$/.test(process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, ''))) {
    throw new Error('TELEGRAM_BOT_USERNAME must be a valid bot username, optionally prefixed with @.');
  }
  if (process.env.TELEGRAM_WEBHOOK_SECRET &&
      !/^[A-Za-z0-9_-]{1,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must contain 1-256 letters, digits, underscores, or hyphens.');
  }
  if (process.env.TELEGRAM_WEBHOOK_SECRET && !process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required when TELEGRAM_WEBHOOK_SECRET is configured.');
  }
  if (process.env.TELEGRAM_WEBHOOK_URL) {
    const webhookUrl = new URL(process.env.TELEGRAM_WEBHOOK_URL);
    if (webhookUrl.protocol !== 'https:' ||
        webhookUrl.pathname !== '/api/telegram/webhook' ||
        webhookUrl.username || webhookUrl.password || webhookUrl.search || webhookUrl.hash) {
      throw new Error('TELEGRAM_WEBHOOK_URL must be HTTPS and end exactly with /api/telegram/webhook.');
    }
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_WEBHOOK_SECRET) {
      throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are required when TELEGRAM_WEBHOOK_URL is configured.');
    }
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
