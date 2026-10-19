# Telegram account linking and notifications

Configure these Railway variables:

- `TELEGRAM_BOT_TOKEN`: the bot token from BotFather.
- `TELEGRAM_BOT_USERNAME`: the bot username without `@`.
- `TELEGRAM_WEBHOOK_SECRET`: a random 1-256 character value containing only
  letters, digits, `_`, or `-`.
- `TELEGRAM_WEBHOOK_URL`: `https://<your-railway-domain>/api/telegram/webhook`.
- `SUPER_ADMIN_TELEGRAM_CHAT_ID`: optional when a Super Admin has linked their
  Telegram account in the database.

On app startup, the server validates the bot with `getMe` and configures the
webhook using Telegram's `setWebhook`. The app's `/api/telegram/webhook` route
accepts updates only when the `X-Telegram-Bot-Api-Secret-Token` header matches
`TELEGRAM_WEBHOOK_SECRET`. Never expose the bot token in a URL, source control,
shell history, or shared logs. The Telegram status endpoint reports whether the
bot is reachable and whether its webhook is configured.

Registration creates a one-time link token that expires after 10 minutes. The
token is stored as a SHA-256 hash, and Telegram `/start` links the private chat
that redeems it. Signed-in users can generate a fresh link from the account
panel. The admin Telegram status and test alert are available to Admin and
Super Admin roles.
