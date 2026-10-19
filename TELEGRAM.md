# Telegram account linking and notifications

Configure these Railway variables:

- `TELEGRAM_BOT_TOKEN`: the bot token from BotFather.
- `TELEGRAM_BOT_USERNAME`: the bot username without `@` (defaults to
  `Telegbg_Bot`).
- `RAILWAY_PUBLIC_DOMAIN`: Railway normally provides this automatically for a
  public service. The app uses it to construct the webhook URL.
- `TELEGRAM_WEBHOOK_SECRET`: optional; when omitted, the app derives a stable
  secret from `JWT_SECRET`.
- `TELEGRAM_WEBHOOK_URL`: optional override for
  `https://<your-railway-domain>/api/telegram/webhook`.
- `SUPER_ADMIN_TELEGRAM_CHAT_ID`: optional when a Super Admin has linked their
  Telegram account in the database.

On app startup, the server validates the bot with `getMe` and configures the
webhook using Telegram's `setWebhook`. The app's `/api/telegram/webhook` route
accepts updates only when the `X-Telegram-Bot-Api-Secret-Token` header matches
the configured or derived webhook secret. Only the bot token is mandatory when
Railway provides `RAILWAY_PUBLIC_DOMAIN`; a custom deployment must set
`TELEGRAM_WEBHOOK_URL`. Never expose the bot token in a URL, source control,
shell history, or shared logs. The Telegram status endpoint reports whether the
bot is reachable and whether its webhook is configured.

Registration creates a one-time link token that expires after 10 minutes. The
token is stored as a SHA-256 hash, and Telegram `/start` links the private chat
that redeems it. Signed-in users can generate a fresh link from the account
panel. The admin Telegram status and test alert are available to Admin and
Super Admin roles.

New request alerts go to linked `ADMIN`, `SUPER_ADMIN`, `MANAGER`, `GM`, and
`DGM` accounts. A separate activity alert goes to the Super Admin chat.
Terminal `APPROVED` or `REJECTED` status notifications go to the requester if
their Telegram account is linked. Intermediate approval steps remain pending
and do not send a requester status notification. Notification text is bounded
and chunked to fit Telegram message limits.

A monthly summary is generated at `0 0 1 * *` in UTC for the preceding
calendar month. It stores a unique monthly record, then sends one summary to
the Super Admin chat. Startup also catches up the preceding month and retries
any saved monthly reports whose Telegram notification has not yet succeeded.
Telegram delivery requires `TELEGRAM_BOT_TOKEN` and a configured or linked
Super Admin chat. Super Admins can download the in-progress current-month
summary and request details as an Excel workbook from the dashboard export
menu or `GET /api/reports/monthly`. Admins can manually regenerate the current
UTC month and dispatch its summary with `POST /api/reports/trigger-monthly`;
the JSON response includes report counts, Telegram delivery count, and a
download link for the CSV at `GET /api/reports/monthly.csv`. The request sheet
contains Request ID,
Title, Requested By, Department, Status, Approved/Rejected By, Created Date,
and Resolved Date. Telegram details use requester/department, decision maker,
status, and both dates when the request has been resolved.

## Super Admin access recovery

`SUPER_ADMIN_EMAIL` identifies the account that startup will promote to
`SUPER_ADMIN` when no Super Admin account exists. It defaults to
`superadmin@company.com`. If the account already exists, startup restores the
role; it does not change the account password. `SUPER_ADMIN_TELEGRAM_USERNAME`
can be set to the matching Telegram username (without `@`) when needed.

Passwords are stored as hashes and cannot be retrieved. To reset one, deploy
the role-restoration code first, then run `npm run superadmin:reset-password`
once in an environment with the production `DATABASE_URL` and set both
`SUPER_ADMIN_RESET_CONFIRM_EMAIL` (the exact target email) and
`SUPER_ADMIN_RESET_PASSWORD` (a new password of at least 12 characters).
Unset those two variables immediately afterward. Do not add the reset command
to a build, start, or recurring deployment script.
