const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const ExcelJS = require('exceljs');
const { assertPostgresDatabaseUrl } = require('./lib/database-url');
const {
  formatMonthlyReportMessage,
  getUtcMonthPeriod,
  summarizeRequests
} = require('./lib/monthly-report');
require('dotenv').config();
const prisma = require('./lib/prisma');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured before the server can start.');
}
const app = express();
const hasStrongJwtSecret = typeof process.env.JWT_SECRET === 'string' &&
  Buffer.byteLength(process.env.JWT_SECRET, 'utf8') >= 32;
const jwtSecret = hasStrongJwtSecret
  ? process.env.JWT_SECRET
  : crypto.randomBytes(48).toString('base64');
if (!hasStrongJwtSecret) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes in production.');
  }
  console.warn('A persistent JWT_SECRET of at least 32 bytes is not configured. Approval sessions will expire when the server restarts.');
}

app.use(express.json());
app.use(cors());
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      const error = res.locals.systemError ||
        new Error(`HTTP ${res.statusCode} returned for ${req.method} ${req.originalUrl}`);
      void notifySuperAdmin(formatServerError(error, `${req.method} ${req.originalUrl}`));
    }
  });
  next();
});
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ telegramBotUsername: TELEGRAM_BOT_USERNAME });
});
app.use(express.static(path.join(__dirname, 'public')));

const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Map([
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/png', new Set(['.png'])],
  ['image/webp', new Set(['.webp'])],
  ['application/pdf', new Set(['.pdf'])],
  ['application/msword', new Set(['.doc'])],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Set(['.docx'])]
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES, files: 1 }
});

function uploadRequestAttachment(req, res, next) {
  upload.single('attachment')(req, res, error => {
    if (!error) return next();
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({
      error: status === 413
        ? 'Attachments must be 20 MB or smaller.'
        : 'Unable to receive the uploaded attachment.'
    });
  });
}

function isAllowedAttachment(file) {
  if (!file) return true;
  const extensions = ALLOWED_ATTACHMENT_TYPES.get(file.mimetype);
  return Boolean(
    extensions &&
    extensions.has(path.extname(file.originalname).toLowerCase()) &&
    hasValidAttachmentSignature(file)
  );
}

function hasValidAttachmentSignature(file) {
  const buffer = file.buffer;
  if (!Buffer.isBuffer(buffer)) return false;
  switch (file.mimetype) {
    case 'image/jpeg':
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png':
      return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp':
      return buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP';
    case 'application/pdf':
      return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    case 'application/msword':
      return buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
        [0x03, 0x05, 0x07].includes(buffer[2]) && [0x04, 0x06, 0x08].includes(buffer[3]);
    default:
      return false;
  }
}

function safeAttachmentFileName(fileName) {
  return path.basename(String(fileName || 'attachment').replace(/\\/g, '/'))
    .replace(/[\r\n"\\]/g, '_')
    .slice(0, 180) || 'attachment';
}

function getAttachmentContentDisposition(fileName) {
  const safeName = safeAttachmentFileName(fileName);
  const fallbackName = safeName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedName = encodeURIComponent(safeName)
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}

async function uploadAttachmentToTelegram(file) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }
  const chatId = await resolveSuperAdminChatId();
  if (!chatId) {
    throw new Error('Set SUPER_ADMIN_TELEGRAM_CHAT_ID or link a Telegram account to the SUPER_ADMIN user before uploading attachments.');
  }
  const isJpeg = file.mimetype === 'image/jpeg' && file.size <= 10 * 1024 * 1024;
  const method = isJpeg ? 'sendPhoto' : 'sendDocument';
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append(isJpeg ? 'photo' : 'document', new Blob([file.buffer], { type: file.mimetype }), safeAttachmentFileName(file.originalname));

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || response.statusText}`);
  }

  const uploadedFile = isJpeg
    ? result.result?.photo?.at(-1)
    : result.result?.document;
  if (!uploadedFile?.file_id) {
    throw new Error(`Telegram ${method} response did not include a file ID.`);
  }
  return uploadedFile;
}

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '') || 'Telegbg_Bot';
const SUPER_ADMIN_TELEGRAM_CHAT_ID = process.env.SUPER_ADMIN_TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const TELEGRAM_LINK_TOKEN_TTL_MS = 10 * 60 * 1000;
let cachedSuperAdminChatId = null;
let monthlyReportCronTask = null;
let monthlyReportJobRunning = false;
const USER_DEPARTMENTS = [
  'HR', 'Finance', 'IT', 'Cashier', 'Sales & Marketing',
  'Warehouse', 'Production', 'Admin', 'Executive Management'
];
const SELF_ASSIGNABLE_ROLES = ['STAFF', 'ASSISTANT', 'SUPERVISOR', 'IT_SPECIALIST'];
const ADMIN_ASSIGNABLE_ROLES = [
  ...SELF_ASSIGNABLE_ROLES, 'MANAGER', 'DGM', 'GM', 'ADMIN'
];
const DEPARTMENT_APPROVER_ROLES = ['MANAGER', 'SUPERVISOR'];

function isValidOnboardingProfile(department, role) {
  return USER_DEPARTMENTS.includes(department) && SELF_ASSIGNABLE_ROLES.includes(role);
}

async function sendTelegramOTP(chatId, otpCode) {
  try {
    await sendTelegramMessage(chatId, `🔐 *Security Verification*\n\nYour Login 2FA Code is: \`${otpCode}\`\nThis code expires in 5 minutes.`, 'Markdown');
    return true;
  } catch (error) {
    console.error("Telegram API Error:", error.message);
    void notifySuperAdmin(formatServerError(error, 'Telegram OTP delivery'));
    return false;
  }
}

async function sendTelegramMessage(chatId, text, parseMode) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {})
    })
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${data.description || response.statusText}`);
  }
}

function createTelegramLinkToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex')
  };
}

function createTelegramDeepLink(token, botUsername = TELEGRAM_BOT_USERNAME) {
  if (typeof botUsername !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) {
    throw new Error('TELEGRAM_BOT_USERNAME must be a valid Telegram bot username.');
  }
  return `https://t.me/${botUsername}?start=${encodeURIComponent(token)}`;
}

function parseTelegramStartPayload(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{43}))?$/);
  return match?.[1] || null;
}

async function createUserTelegramLink(userId) {
  const { token, tokenHash } = createTelegramLinkToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TOKEN_TTL_MS);
  await prisma.$transaction(async transaction => {
    await transaction.telegramLinkToken.deleteMany({ where: { userId } });
    await transaction.telegramLinkToken.create({
      data: { tokenHash, userId, expiresAt }
    });
  });
  return { deepLink: createTelegramDeepLink(token), expiresAt };
}

async function getTelegramApiResult(method, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: options.body ? 'POST' : 'GET',
    ...(options.body ? {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.body)
    } : {}),
    signal: AbortSignal.timeout(options.timeoutMs || 10000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || response.statusText}`);
  }
  return data.result;
}

async function configureTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !TELEGRAM_WEBHOOK_URL) {
    console.warn('Telegram webhook auto-setup skipped: configure TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and TELEGRAM_WEBHOOK_URL.');
    return false;
  }
  let webhookUrl;
  try {
    webhookUrl = new URL(TELEGRAM_WEBHOOK_URL);
  } catch {
    throw new Error('TELEGRAM_WEBHOOK_URL must be an absolute HTTPS URL.');
  }
  if (webhookUrl.protocol !== 'https:' || webhookUrl.pathname !== '/api/telegram/webhook' ||
      webhookUrl.username || webhookUrl.password || webhookUrl.search || webhookUrl.hash) {
    throw new Error('TELEGRAM_WEBHOOK_URL must be HTTPS and end exactly with /api/telegram/webhook.');
  }

  const bot = await getTelegramApiResult('getMe');
  if (!bot?.is_bot || bot.username?.toLowerCase() !== TELEGRAM_BOT_USERNAME.toLowerCase()) {
    throw new Error('Telegram bot token does not match TELEGRAM_BOT_USERNAME.');
  }
  await getTelegramApiResult('setWebhook', {
    body: {
      url: webhookUrl.toString(),
      secret_token: TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message']
    },
    timeoutMs: 20000
  });
  console.log('Telegram webhook configured successfully.');
  return true;
}

function safeEqualStrings(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length &&
    crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

app.post('/api/telegram/link', requireApprovalAuthentication, async (req, res) => {
  try {
    const link = await createUserTelegramLink(req.approverId);
    return res.json({ ...link, expiresAt: link.expiresAt.toISOString() });
  } catch (error) {
    console.error('Unable to create Telegram account link:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to create a Telegram connection link.' });
  }
});

app.post('/api/telegram/webhook', async (req, res) => {
  if (!TELEGRAM_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Telegram webhook is not configured.' });
  }
  if (!safeEqualStrings(req.get('x-telegram-bot-api-secret-token'), TELEGRAM_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized Telegram webhook request.' });
  }

  const message = req.body?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const linkToken = parseTelegramStartPayload(text);
  if (!linkToken) {
    return res.sendStatus(200);
  }
  if (message.chat?.type !== 'private' ||
      String(message.chat.id) !== String(message.from?.id) ||
      !/^[1-9]\d{0,19}$/.test(String(message.chat.id))) {
    return res.sendStatus(200);
  }

  const tokenHash = crypto.createHash('sha256').update(linkToken).digest('hex');
  const now = new Date();
  try {
    const tokenRecord = await prisma.telegramLinkToken.findUnique({
      where: { tokenHash },
      select: { userId: true }
    });
    if (!tokenRecord) {
      await sendTelegramMessage(String(message.chat.id), 'This account link is invalid or expired. Please generate a new link from the Request Management System.');
      return res.sendStatus(200);
    }

    await prisma.$transaction(async transaction => {
      const claimed = await transaction.telegramLinkToken.updateMany({
        where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now }
      });
      if (claimed.count !== 1) {
        throw new Error('Telegram account link is invalid, expired, or already used.');
      }
      await transaction.user.update({
        where: { id: tokenRecord.userId },
        data: {
          telegramId: String(message.chat.id),
          telegramUsername: typeof message.from.username === 'string'
            ? message.from.username.replace(/^@+/, '').toLowerCase()
            : null,
          telegramFirstName: typeof message.from.first_name === 'string'
            ? message.from.first_name.trim().slice(0, 256)
            : null
        }
      });
    });

  } catch (error) {
    if (error.code === 'P2002') {
      await sendTelegramMessage(
        String(message.chat.id),
        'This Telegram account is already connected to another user. Contact an administrator if you need help.'
      );
      return res.sendStatus(200);
    }
    if (error.message === 'Telegram account link is invalid, expired, or already used.') {
      await sendTelegramMessage(
        String(message.chat.id),
        'This account link is invalid, expired, or already used. Please generate a new link from the Request Management System.'
      );
      return res.sendStatus(200);
    }
    console.error('Telegram account-link webhook failed:', error);
    res.locals.systemError = error;
    return res.sendStatus(500);
  }

  try {
    await sendTelegramMessage(
      String(message.chat.id),
      '✅ Account linked successfully! You will now receive system notifications here.'
    );
  } catch (error) {
    console.error('Telegram account linked but confirmation message could not be delivered:', error);
    void notifySuperAdmin(formatServerError(error, 'Telegram link confirmation delivery'));
  }
  return res.sendStatus(200);
});

function redactSensitiveErrorText(text, botToken = TELEGRAM_BOT_TOKEN) {
  let safeText = String(text || 'Unknown error');
  const secrets = [
    botToken,
    process.env.JWT_SECRET,
    process.env.DATABASE_URL,
    process.env.SUPER_ADMIN_TELEGRAM_CHAT_ID
  ].filter(secret => typeof secret === 'string' && secret.length > 0);
  for (const secret of secrets) {
    safeText = safeText.split(secret).join('[REDACTED_SECRET]');
  }
  return safeText
    .replace(/((?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/((?:JWT_SECRET|DATABASE_URL|TELEGRAM_BOT_TOKEN)\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
}

function splitTelegramMessage(text, maxLength = 3500) {
  const chunks = [];
  let remaining = String(text);
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength / 2)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function formatServerError(error, context = 'Unhandled server error') {
  const detail = error instanceof Error
    ? (error.stack || `${error.name}: ${error.message}`)
    : String(error);
  return [
    '🚨 [SERVER ERROR]',
    `Context: ${context}`,
    `Timestamp: ${new Date().toISOString()}`,
    redactSensitiveErrorText(detail)
  ].join('\n');
}

async function notifySuperAdmin(message) {
  if (!TELEGRAM_BOT_TOKEN) {
    const error = 'TELEGRAM_BOT_TOKEN is not configured.';
    console.error(`Centralized Telegram notification skipped: ${error}`);
    return { ok: false, error };
  }

  try {
    const chatId = await resolveSuperAdminChatId();
    if (!chatId) {
      const error = 'Set SUPER_ADMIN_TELEGRAM_CHAT_ID or link a Telegram account to the SUPER_ADMIN user.';
      console.error(`Centralized Telegram notification skipped: ${error}`);
      return { ok: false, error };
    }
    const chunks = splitTelegramMessage(redactSensitiveErrorText(message));
    for (let index = 0; index < chunks.length; index += 1) {
      const partLabel = chunks.length > 1 ? ` (part ${index + 1}/${chunks.length})` : '';
      await sendTelegramMessage(chatId, `${chunks[index]}${partLabel}`);
    }
    return { ok: true };
  } catch (error) {
    const safeError = redactSensitiveErrorText(error.stack || error.message);
    console.error('Centralized Telegram notification failed:', safeError);
    return { ok: false, error: redactSensitiveErrorText(error.message) };
  }
}

async function resolveSuperAdminChatId() {
  if (SUPER_ADMIN_TELEGRAM_CHAT_ID) {
    if (!/^-?\d+$/.test(SUPER_ADMIN_TELEGRAM_CHAT_ID)) {
      throw new Error('SUPER_ADMIN_TELEGRAM_CHAT_ID must be a numeric Telegram chat ID.');
    }
    return SUPER_ADMIN_TELEGRAM_CHAT_ID;
  }
  if (cachedSuperAdminChatId) return cachedSuperAdminChatId;

  const superAdmin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', telegramId: { not: null } },
    select: { telegramId: true }
  });
  if (!superAdmin?.telegramId || !/^-?\d+$/.test(superAdmin.telegramId)) return null;
  cachedSuperAdminChatId = superAdmin.telegramId;
  return cachedSuperAdminChatId;
}

async function notifyRequestActivity(tag, request) {
  try {
    const requester = request.user || await prisma.user.findUnique({
      where: { id: request.userId },
      select: { name: true, telegramFirstName: true, department: true }
    });
    const message = [
      formatTelegramField(tag, 100),
      `Request ID: ${formatTelegramField(request.id, 40)}`,
      `Title: ${formatTelegramField(request.title, 512)}`,
      `Status: ${formatTelegramField(request.status, 40)}`,
      `Requester: ${formatTelegramField(
        requester?.name || requester?.telegramFirstName || 'Unknown',
        160
      )}`,
      `Department: ${formatTelegramField(requester?.department, 120)}`,
      `Amount: ${getRequestAmount(request.extraFields)}`,
      `Timestamp: ${new Date().toISOString()}`
    ].join('\n');
    await notifySuperAdmin(message);
  } catch (error) {
    console.error(`Unable to prepare centralized notification for request ${request.id}:`, error);
  }
}

function notifyUserActivity(tag, user, activity) {
  const message = [
    formatTelegramField(tag, 100),
    `User: ${formatTelegramField(user.name || user.telegramFirstName || 'Unknown', 160)}`,
    `Email: ${formatTelegramField(user.email || 'Telegram account', 256)}`,
    `Department: ${formatTelegramField(user.department, 120)}`,
    `Role: ${formatTelegramField(user.role, 40)}`,
    `Activity: ${formatTelegramField(activity, 512)}`,
    `Timestamp: ${new Date().toISOString()}`
  ].join('\n');
  void notifySuperAdmin(message);
}

process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection:', reason);
  const shutdownTimeout = setTimeout(() => process.exit(1), 12000);
  void notifySuperAdmin(formatServerError(reason, 'Unhandled promise rejection'))
    .finally(() => {
      clearTimeout(shutdownTimeout);
      process.exit(1);
    });
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  const shutdownTimeout = setTimeout(() => process.exit(1), 12000);
  void notifySuperAdmin(formatServerError(error, 'Uncaught exception'))
    .finally(() => {
      clearTimeout(shutdownTimeout);
      process.exitCode = 1;
      process.exit(1);
    });
});

function verifyTelegramLogin(payload, botToken, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof botToken !== 'string' || !botToken) {
    return null;
  }
  const hash = payload.hash;
  const authDate = Number(payload.auth_date);
  const telegramId = String(payload.id ?? '');
  const firstName = payload.first_name;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash) ||
      !Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 ||
      nowSeconds - authDate > 86400 ||
      !/^[1-9]\d{0,15}$/.test(telegramId) ||
      !Number.isSafeInteger(Number(telegramId)) ||
      typeof firstName !== 'string' || !firstName.trim() || firstName.length > 256 ||
      (payload.username != null &&
        (typeof payload.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(payload.username)))) {
    return null;
  }

  const checkString = Object.entries(payload)
    .filter(([key, value]) => key !== 'hash' && (typeof value === 'string' || typeof value === 'number'))
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest();
  const receivedHash = Buffer.from(hash, 'hex');
  if (receivedHash.length !== expectedHash.length || !crypto.timingSafeEqual(receivedHash, expectedHash)) {
    return null;
  }

  return {
    id: telegramId,
    username: typeof payload.username === 'string' ? payload.username : null,
    firstName: firstName.trim()
  };
}

function getRequestAmount(extraFields) {
  if (!extraFields) return 'Not specified';
  try {
    const fields = typeof extraFields === 'string' ? JSON.parse(extraFields) : extraFields;
    if (fields?.amount == null || String(fields.amount).trim() === '') return 'Not specified';
    const amount = Number(fields?.amount);
    return Number.isFinite(amount) && amount >= 0
      ? `${new Intl.NumberFormat('en-US').format(amount)} MMK`
      : 'Not specified';
  } catch (error) {
    console.error('Unable to read request amount for Telegram notification:', error.message);
    return 'Not specified';
  }
}

function formatRequestNotification(request, status) {
  return [
    `Request #${formatTelegramField(request.id, 40)}`,
    `Title: ${formatTelegramField(request.title, 512)}`,
    `Status: ${formatTelegramField(status, 40)}`,
    `Amount: ${getRequestAmount(request.extraFields)}`,
    `Requester: ${formatTelegramField(
      request.user?.name || request.user?.telegramFirstName || 'Unknown',
      160
    )}`
  ].join('\n');
}

function formatTelegramField(value, maxLength = 256) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return normalized || 'Not specified';
}

async function notifyTelegramChats(chatIds, message) {
  if (!Array.isArray(chatIds)) {
    throw new TypeError('Telegram notification recipients must be an array of chat IDs.');
  }
  const uniqueChatIds = [...new Set(chatIds.filter(chatId => {
    if (/^\d+$/.test(String(chatId))) return true;
    console.warn('Telegram notification skipped for an account without a numeric Telegram chat ID.');
    return false;
  }).map(String))];
  const chunks = splitTelegramMessage(message);
  const results = await Promise.allSettled(
    uniqueChatIds.map(async chatId => {
      for (const chunk of chunks) {
        await sendTelegramMessage(chatId, chunk);
      }
    })
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `Telegram notification failed for one recipient:`,
        redactSensitiveErrorText(result.reason?.message || result.reason)
      );
    }
  });
}

async function notifyRequestManagers(request) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('Telegram notification skipped: TELEGRAM_BOT_TOKEN is not configured.');
    return;
  }
  const managers = await prisma.user.findMany({
    where: {
      role: { in: ['ADMIN', 'SUPER_ADMIN', 'MANAGER', 'GM', 'DGM'] },
      telegramId: { not: null }
    },
    select: { telegramId: true }
  });
  await notifyTelegramChats(
    managers.map(manager => manager.telegramId),
    formatRequestNotification(request, request.status)
  );
}

async function notifyRequestOwner(request, status) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('Telegram notification skipped: TELEGRAM_BOT_TOKEN is not configured.');
    return;
  }
  const requester = await prisma.user.findUnique({
    where: { id: request.userId },
    select: { telegramId: true, telegramFirstName: true, name: true }
  });
  if (!requester?.telegramId) {
    console.warn(`Telegram notification skipped for request ${request.id}: requester has no linked Telegram account.`);
    return;
  }
  await notifyTelegramChats(
    [requester.telegramId],
    formatRequestNotification({ ...request, user: requester }, status)
  );
}

async function generateMonthlyReport(period) {
  const requests = await prisma.request.findMany({
    where: {
      status: { in: ['PENDING', 'APPROVED', 'REJECTED'] },
      createdAt: {
        gte: period.start,
        lt: period.end
      }
    },
    select: {
      id: true,
      title: true,
      category: true,
      targetDepartment: true,
      status: true,
      extraFields: true,
      createdAt: true,
      user: { select: { name: true } }
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });
  const summary = summarizeRequests(requests);
  const report = await prisma.monthlyReport.upsert({
    where: { monthKey: period.monthKey },
    create: {
      monthKey: period.monthKey,
      periodStart: period.start,
      periodEnd: period.end,
      ...summary
    },
    update: {
      periodStart: period.start,
      periodEnd: period.end,
      ...summary,
      generatedAt: new Date()
    }
  });
  return { report, requests };
}

async function sendMonthlyReportToSuperAdmin(report) {
  const claimTime = new Date();
  const claimExpiredBefore = new Date(claimTime.getTime() - 10 * 60 * 1000);
  const claim = await prisma.monthlyReport.updateMany({
    where: {
      monthKey: report.monthKey,
      telegramSentAt: null,
      OR: [
        { telegramClaimedAt: null },
        { telegramClaimedAt: { lt: claimExpiredBefore } }
      ]
    },
    data: { telegramClaimedAt: claimTime }
  });
  if (claim.count !== 1) return false;

  try {
    const result = await notifySuperAdmin(formatMonthlyReportMessage(report));
    if (!result.ok) {
      throw new Error(result.error || 'Monthly report Telegram delivery failed.');
    }
    await prisma.monthlyReport.update({
      where: { monthKey: report.monthKey },
      data: { telegramSentAt: new Date(), telegramClaimedAt: null }
    });
    return true;
  } catch (error) {
    await prisma.monthlyReport.updateMany({
      where: { monthKey: report.monthKey, telegramClaimedAt: claimTime },
      data: { telegramClaimedAt: null }
    });
    throw error;
  }
}

async function runMonthlyReportJob(now = new Date()) {
  const period = getUtcMonthPeriod(now, -1);
  const { report } = await generateMonthlyReport(period);
  const pendingReports = await prisma.monthlyReport.findMany({
    where: { telegramSentAt: null },
    orderBy: { monthKey: 'asc' }
  });
  const deliveryErrors = [];
  for (const pendingReport of pendingReports) {
    try {
      await sendMonthlyReportToSuperAdmin(pendingReport);
    } catch (error) {
      deliveryErrors.push(error);
      console.error(`Monthly report ${pendingReport.monthKey} Telegram delivery failed:`, error);
    }
  }
  console.log(`Monthly report ${report.monthKey} generated; attempted ${pendingReports.length} pending delivery(ies).`);
  if (deliveryErrors.length) {
    throw new AggregateError(deliveryErrors, 'One or more monthly report notifications could not be delivered.');
  }
  return report;
}

function startMonthlyReportScheduler() {
  if (monthlyReportCronTask) return monthlyReportCronTask;
  monthlyReportCronTask = cron.schedule('0 0 1 * *', async () => {
    if (monthlyReportJobRunning) {
      console.warn('Monthly report job skipped because a prior run is still active.');
      return;
    }
    monthlyReportJobRunning = true;
    try {
      await runMonthlyReportJob();
    } catch (error) {
      console.error('Monthly report generation or delivery failed:', error);
      await notifySuperAdmin(formatServerError(error, 'Monthly report job'));
    } finally {
      monthlyReportJobRunning = false;
    }
  }, { timezone: 'UTC' });
  console.log('Monthly report scheduler started (0 0 1 * * UTC).');
  monthlyReportJobRunning = true;
  void runMonthlyReportJob().catch(error => {
    console.error('Monthly report catch-up or delivery failed:', error);
    void notifySuperAdmin(formatServerError(error, 'Monthly report catch-up'));
  }).finally(() => {
    monthlyReportJobRunning = false;
  });
  return monthlyReportCronTask;
}

// Auto Init Super Admin
async function initSuperAdmin() {
    const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || 'superadmin@company.com')
      .trim()
      .toLowerCase();
    const superAdminTelegram = (
      process.env.SUPER_ADMIN_TELEGRAM_USERNAME || 'okeydokey2'
    ).replace(/^@/, '').trim().toLowerCase();

    if (SUPER_ADMIN_TELEGRAM_CHAT_ID && !/^\d+$/.test(SUPER_ADMIN_TELEGRAM_CHAT_ID)) {
        throw new Error('SUPER_ADMIN_TELEGRAM_CHAT_ID must be a numeric Telegram chat ID.');
    }

    const superAdmin = await prisma.user.findFirst({
        where: { role: 'SUPER_ADMIN' }
    });
    if (superAdmin) {
        await bindSuperAdminTelegramAccount(superAdmin);
        console.log(`Super Admin is configured for ${superAdmin.email}.`);
        return;
    }

    const configuredUsers = await prisma.user.findMany({
        where: {
            OR: [
                { email: superAdminEmail },
                ...(superAdminTelegram ? [{ telegramUsername: superAdminTelegram }] : []),
                ...(SUPER_ADMIN_TELEGRAM_CHAT_ID
                  ? [{ telegramId: SUPER_ADMIN_TELEGRAM_CHAT_ID }]
                  : [])
            ]
        },
        select: { id: true, email: true, role: true, telegramId: true, telegramUsername: true }
    });

    if (configuredUsers.length > 1) {
        throw new Error('Configured Super Admin identifiers resolve to different user accounts.');
    }

    const configuredUser = configuredUsers[0];
    if (configuredUser) {
        if (SUPER_ADMIN_TELEGRAM_CHAT_ID) {
            const existingBinding = await prisma.user.findUnique({
                where: { telegramId: SUPER_ADMIN_TELEGRAM_CHAT_ID },
                select: { id: true }
            });
            if (existingBinding && existingBinding.id !== configuredUser.id) {
                throw new Error('The configured Super Admin Telegram ID is already linked to another user.');
            }
        }

        await prisma.user.update({
            where: { id: configuredUser.id },
            data: {
                role: 'SUPER_ADMIN',
                ...(SUPER_ADMIN_TELEGRAM_CHAT_ID && { telegramId: SUPER_ADMIN_TELEGRAM_CHAT_ID }),
                ...(!configuredUser.telegramUsername && superAdminTelegram && {
                    telegramUsername: superAdminTelegram
                }),
                ...(!configuredUser.department && { department: 'Executive Management' })
            }
        });
        console.log(`Super Admin access restored for ${configuredUser.email}.`);
        return;
    }

    const password = process.env.SUPER_ADMIN_PASSWORD;
    if (!password) {
        console.warn('SUPER_ADMIN_PASSWORD is not configured. Skipping initial Super Admin creation.');
        return;
    }

    if (SUPER_ADMIN_TELEGRAM_CHAT_ID) {
        const existingBinding = await prisma.user.findUnique({
            where: { telegramId: SUPER_ADMIN_TELEGRAM_CHAT_ID },
            select: { id: true }
        });
        if (existingBinding) {
            throw new Error('The configured Super Admin Telegram ID is already linked to another user.');
        }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({
        data: {
            name: 'Super Admin',
            email: superAdminEmail,
            telegramUsername: superAdminTelegram,
            ...(SUPER_ADMIN_TELEGRAM_CHAT_ID && { telegramId: SUPER_ADMIN_TELEGRAM_CHAT_ID }),
            password: hashedPassword,
            role: 'SUPER_ADMIN',
            department: 'Executive Management'
        }
    });
    console.log(`Initial Super Admin created for ${superAdminEmail}.`);
}

async function bindSuperAdminTelegramAccount(superAdmin) {
    if (!SUPER_ADMIN_TELEGRAM_CHAT_ID) return;
    if (!/^\d+$/.test(SUPER_ADMIN_TELEGRAM_CHAT_ID)) {
        throw new Error('SUPER_ADMIN_TELEGRAM_CHAT_ID must be a numeric Telegram chat ID.');
    }
    if (superAdmin.telegramId === SUPER_ADMIN_TELEGRAM_CHAT_ID) return;

    const existingBinding = await prisma.user.findUnique({
        where: { telegramId: SUPER_ADMIN_TELEGRAM_CHAT_ID },
        select: { id: true }
    });
    if (existingBinding && existingBinding.id !== superAdmin.id) {
        throw new Error('The configured Super Admin Telegram ID is already linked to another user.');
    }

    await prisma.user.update({
        where: { id: superAdmin.id },
        data: { telegramId: SUPER_ADMIN_TELEGRAM_CHAT_ID }
    });
    console.log('Super Admin Telegram account binding configured.');
}

function buildApprovalChain(originDepartment, targetDepartment, requiresExecutiveApproval = false) {
  const departments = [];
  for (const [index, department] of [originDepartment, targetDepartment].entries()) {
    if (typeof department !== 'string' || !department.trim()) continue;
    const normalizedDepartment = department.trim();
    if (index === 1 && normalizedDepartment.toLowerCase() === 'general') continue;
    if (!departments.some(existing => existing.toLowerCase() === normalizedDepartment.toLowerCase())) {
      departments.push(normalizedDepartment);
    }
  }

  const steps = [
    ...departments.map(department => ({
      stepType: 'DEPARTMENT',
      department,
      approverRole: 'MANAGER',
      stage: `PENDING_${department.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MANAGER`
    }))
  ];
  if (requiresExecutiveApproval || steps.length === 0) {
    steps.push({
      stepType: 'EXECUTIVE',
      department: null,
      approverRole: 'EXECUTIVE',
      stage: 'PENDING_EXECUTIVE'
    });
  }
  return steps.map((step, sequence) => ({ ...step, sequence }));
}

function getApprovalTransition(status, currentStep, nextStep) {
  if (status === 'REJECTED') {
    return {
      status: 'REJECTED',
      approvalStage: 'REJECTED',
      currentApprovalStep: currentStep.sequence
    };
  }
  if (!nextStep) {
    return {
      status: 'APPROVED',
      approvalStage: 'COMPLETED',
      currentApprovalStep: currentStep.sequence + 1
    };
  }
  return {
    status: 'PENDING',
    approvalStage: nextStep.stepType === 'EXECUTIVE'
      ? 'PENDING_EXECUTIVE'
      : `PENDING_${nextStep.department.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MANAGER`,
    currentApprovalStep: nextStep.sequence
  };
}

async function initializeApprovalChains() {
  const uninitializedRequests = await prisma.request.findMany({
    where: {
      status: { in: ['PENDING', 'PENDING_ADMIN_MANAGER', 'PENDING_FINANCE_MANAGER'] },
      approvalSteps: { none: {} }
    },
    include: { user: true }
  });

  for (const request of uninitializedRequests) {
    const chain = buildApprovalChain(
      request.user.department,
      request.targetDepartment,
      request.requiresExecutiveApproval
    );
    await prisma.request.update({
      where: { id: request.id },
      data: {
        status: 'PENDING',
        currentApprovalStep: 0,
        approvalStage: chain[0].stage,
        approvalSteps: {
          create: chain.map(({ stage, ...step }) => step)
        }
      }
    });
  }

  if (uninitializedRequests.length > 0) {
    console.log(`Initialized approval chains for ${uninitializedRequests.length} pending request(s).`);
  }
}

// Login Endpoint (Fixed Prisma mode error)
app.post('/api/login', async (req, res) => {
  try {
    const loginKey = req.body?.loginKey ?? req.body?.username ?? req.body?.email;
    const password = req.body?.password;

    if (typeof loginKey !== 'string' || !loginKey.trim() || typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const cleanKey = loginKey.trim().replace(/^@+/, '').toLowerCase();

    const matchingEmail = await prisma.user.findUnique({
      where: { email: cleanKey }
    });
    const matchingTelegram = matchingEmail || await prisma.user.findFirst({
      where: {
        OR: [
          { telegramId: cleanKey },
          { telegramUsername: { equals: cleanKey, mode: 'insensitive' } }
        ]
      }
    });
    const user = matchingTelegram || await prisma.user.findFirst({
      where: { name: { equals: loginKey.trim(), mode: 'insensitive' } }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const hasBcryptPassword = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.password);
    const passwordMatches = hasBcryptPassword
      ? await bcrypt.compare(password, user.password)
      : password === user.password;
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (!hasBcryptPassword) {
      await prisma.user.update({
        where: { id: user.id },
        data: { password: await bcrypt.hash(password, 10) }
      });
    }

    res.json({
      requiresMfa: false,
      token: jwt.sign({ sub: String(user.id) }, jwtSecret, { expiresIn: '8h' }),
      user: {
        id: user.id,
        name: user.name,
        telegramId: user.telegramId,
        telegramUsername: user.telegramUsername,
        role: user.role,
        department: user.department
      }
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.locals.systemError = error;
    res.status(500).json({ error: 'Unable to sign in.' });
  }
});

app.post('/api/auth/telegram', async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(503).json({ error: 'Telegram login is not configured on this server.' });
  }
  const identity = verifyTelegramLogin(req.body, TELEGRAM_BOT_TOKEN);
  if (!identity) {
    return res.status(401).json({ error: 'Telegram authentication failed or has expired. Please try again.' });
  }

  try {
    let user = await prisma.user.findUnique({ where: { telegramId: identity.id } });
    const isNewUser = !user;
    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          telegramUsername: identity.username,
          telegramFirstName: identity.firstName
        }
      });
    } else {
      const randomPassword = crypto.randomBytes(32).toString('hex');
      user = await prisma.user.create({
        data: {
          name: identity.firstName,
          email: `telegram-${identity.id}@telegram.local`,
          password: await bcrypt.hash(randomPassword, 10),
          telegramId: identity.id,
          telegramUsername: identity.username,
          telegramFirstName: identity.firstName,
          department: null,
          role: null
        }
      });
    }

    const requiresOnboarding = !user.department || !user.role;
    if (isNewUser) {
      notifyUserActivity('👤 [NEW USER]', user, 'Created account through Telegram login.');
    }
    return res.json({
      token: jwt.sign({ sub: String(user.id) }, jwtSecret, { expiresIn: '8h' }),
      requiresOnboarding,
      user: {
        id: user.id,
        name: user.name,
        telegramId: user.telegramId,
        telegramUsername: user.telegramUsername,
        role: user.role,
        department: user.department
      }
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'This Telegram account could not be linked to a user. Contact an administrator.' });
    }
    console.error('Telegram Login Error:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to sign in with Telegram.' });
  }
});

app.post('/api/user/complete-profile', requireApprovalAuthentication, async (req, res) => {
  const department = typeof req.body?.department === 'string' ? req.body.department.trim() : '';
  const role = typeof req.body?.role === 'string' ? req.body.role.trim().toUpperCase() : '';

  if (!isValidOnboardingProfile(department, role)) {
    return res.status(400).json({
      error: 'Choose a valid department and a permitted role. Manager and administrator roles must be assigned by an administrator.'
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.approverId },
      select: { id: true, name: true, role: true, department: true, telegramId: true, telegramUsername: true }
    });
    if (!user) {
      return res.status(401).json({ error: 'The account for this session no longer exists.' });
    }
    if (user.role && user.department) {
      return res.status(409).json({ error: 'Your profile has already been completed.' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { department, role },
      select: { id: true, name: true, role: true, department: true, telegramId: true, telegramUsername: true }
    });
    notifyUserActivity('👤 [PROFILE COMPLETED]', updatedUser, 'Completed department and role onboarding.');
    return res.json({ user: updatedUser });
  } catch (error) {
    console.error('Complete Profile Error:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to complete your profile.' });
  }
});

app.post('/api/auth/telegram/link', requireApprovalAuthentication, async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(503).json({ error: 'Telegram login is not configured on this server.' });
  }
  const identity = verifyTelegramLogin(req.body, TELEGRAM_BOT_TOKEN);
  if (!identity) {
    return res.status(401).json({ error: 'Telegram authentication failed or has expired. Please try again.' });
  }

  try {
    const existingOwner = await prisma.user.findUnique({ where: { telegramId: identity.id } });
    if (existingOwner && existingOwner.id !== req.approverId) {
      return res.status(409).json({ error: 'This Telegram account is already linked to another user.' });
    }
    const user = await prisma.user.update({
      where: { id: req.approverId },
      data: {
        telegramId: identity.id,
        telegramUsername: identity.username,
        telegramFirstName: identity.firstName
      }
    });
    return res.json({
      message: 'Telegram account linked successfully.',
      user: {
        id: user.id,
        name: user.name,
        telegramId: user.telegramId,
        telegramUsername: user.telegramUsername,
        role: user.role,
        department: user.department
      }
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'This Telegram account is already linked to another user.' });
    }
    console.error('Telegram Account Link Error:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to link the Telegram account.' });
  }
});

// Verify Telegram OTP
app.post('/api/verify-mfa', async (req, res) => {
  try {
    const { userId, email } = req.body || {};
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    const numericUserId = Number(userId);
    const where = Number.isSafeInteger(numericUserId) && numericUserId > 0
      ? { id: numericUserId }
      : typeof email === 'string' && email.trim()
        ? { email: email.trim().toLowerCase() }
        : null;

    if (!where || !code) {
      return res.status(400).json({ error: 'A valid account and verification code are required.' });
    }

    const user = await prisma.user.findUnique({
      where,
      select: { id: true, otp: true, otpExpiry: true }
    });
    const now = new Date();
    if (!user || !user.otp || user.otp !== code || !user.otpExpiry || user.otpExpiry <= now) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }

    const consumed = await prisma.user.updateMany({
      where: { id: user.id, otp: code, otpExpiry: { gt: now } },
      data: { otp: null, otpExpiry: null }
    });
    if (consumed.count !== 1) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }

    const authenticatedUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        name: true,
        email: true,
        telegramId: true,
        telegramUsername: true,
        role: true,
        department: true
      }
    });
    if (!authenticatedUser) {
      return res.status(401).json({ error: 'The account for this session no longer exists.' });
    }

    res.json({
      message: 'Authentication successful',
      token: jwt.sign({ sub: String(authenticatedUser.id) }, jwtSecret, { expiresIn: '8h' }),
      user: authenticatedUser
    });
  } catch (error) {
    res.locals.systemError = error;
    res.status(500).json({ error: 'Unable to verify authentication.' });
  }
});

// Create User API
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password, department, role, telegramId, telegramUsername } = req.body || {};

    if (typeof name !== 'string' || !name.trim() ||
        typeof email !== 'string' || !email.trim() ||
        typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    const normalizedDepartment = typeof department === 'string' ? department.trim() : '';
    const normalizedRole = typeof role === 'string' ? role.trim().toUpperCase() : '';
    if (!isValidOnboardingProfile(normalizedDepartment, normalizedRole)) {
      return res.status(400).json({
        error: 'Choose a valid department and a permitted role. Manager and administrator roles must be assigned by an administrator.'
      });
    }

    const normalizedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          { name: { equals: normalizedName, mode: 'insensitive' } }
        ]
      },
      select: { name: true, email: true }
    });

    if (existingUser) {
      const existingEmail = existingUser.email.toLowerCase() === normalizedEmail;
      return res.status(400).json({
        error: existingEmail
          ? 'A user with this email already exists.'
          : 'A user with this username already exists.'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const linkToken = createTelegramLinkToken();
    const linkExpiresAt = new Date(Date.now() + TELEGRAM_LINK_TOKEN_TTL_MS);
    const telegramLinkUrl = createTelegramDeepLink(linkToken.token);
    const newUser = await prisma.$transaction(async transaction => {
      const user = await transaction.user.create({
        data: {
          name: normalizedName,
          email: normalizedEmail,
          password: hashedPassword,
          department: normalizedDepartment,
          role: normalizedRole,
          telegramUsername: typeof (telegramUsername ?? telegramId) === 'string' &&
            (telegramUsername ?? telegramId).trim()
            ? (telegramUsername ?? telegramId).replace(/^@+/, '').trim().toLowerCase()
            : null
        }
      });
      await transaction.telegramLinkToken.create({
        data: {
          tokenHash: linkToken.tokenHash,
          userId: user.id,
          expiresAt: linkExpiresAt
        }
      });
      return user;
    });

    notifyUserActivity('👤 [NEW USER]', newUser, 'Registered with email and password.');
    res.status(201).json({
      message: 'User registered successfully',
      telegramLinkUrl,
      telegramLinkExpiresAt: linkExpiresAt.toISOString(),
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        department: newUser.department,
        role: newUser.role
      }
    });
  } catch (error) {
    console.error('Create User Error:', error);
    res.locals.systemError = error;
    if (error.code === 'P2002') {
      const conflictingFields = Array.isArray(error.meta?.target)
        ? error.meta.target
        : [error.meta?.target].filter(Boolean);
      const duplicateField = conflictingFields.includes('name') ? 'username' : 'email';
      return res.status(400).json({
        error: `A user with this ${duplicateField} already exists.`
      });
    }
    const databaseConnectionErrorCodes = ['P1000', 'P1001', 'P1002', 'P1003', 'P1010', 'P1011', 'P1017', 'P2024'];
    if (error.name === 'PrismaClientInitializationError' ||
        databaseConnectionErrorCodes.includes(error.errorCode || error.code)) {
      return res.status(503).json({
        error: 'Registration is temporarily unavailable because the database cannot be reached. Verify DATABASE_URL and database network access.'
      });
    }
    res.status(500).json({ error: 'Unable to create user.' });
  }
});

// Get All Users API
app.get('/api/telegram/status', requireAdminAuthentication, async (req, res) => {
  let botActive = false;
  let botUsername = null;
  let webhookInfo = null;
  let superAdminConnected = false;
  let superAdminConnectionError = null;

  if (TELEGRAM_BOT_TOKEN) {
    try {
      const bot = await getTelegramApiResult('getMe');
      botActive = Boolean(bot?.is_bot);
      botUsername = bot?.username || null;
      if (botActive) {
        try {
          webhookInfo = await getTelegramApiResult('getWebhookInfo');
        } catch (error) {
          console.error('Unable to check Telegram webhook configuration:', error.message);
        }
      }
    } catch (error) {
      console.error('Telegram bot health check failed:', error.message);
    }
  }

  try {
    superAdminConnected = Boolean(await resolveSuperAdminChatId());
  } catch (error) {
    superAdminConnectionError = error.message;
    console.error('Unable to resolve Super Admin Telegram chat:', error.message);
  }

  try {
    const userLinkedCount = await prisma.user.count({
      where: { telegramId: { not: null } }
    });
    return res.json({
      botActive,
      superAdminConnected,
      superAdminConnectionSource: SUPER_ADMIN_TELEGRAM_CHAT_ID
        ? 'environment'
        : (superAdminConnected ? 'database' : null),
      ...(superAdminConnectionError && { superAdminConnectionError }),
      userLinkedCount,
      botUsername,
      webhookConfigured: Boolean(webhookInfo?.url && TELEGRAM_WEBHOOK_SECRET),
      webhookActive: Boolean(webhookInfo?.url?.endsWith('/api/telegram/webhook'))
    });
  } catch (error) {
    console.error('Telegram connection status check failed:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to check Telegram connection status.' });
  }
});

app.post('/api/admin/telegram/test', requireAdminAuthentication, async (req, res) => {
  const result = await notifySuperAdmin([
    '✅ [TELEGRAM TEST]',
    'Centralized Telegram notifications are reachable.',
    `Triggered by admin user #${req.approverId}`,
    `Timestamp: ${new Date().toISOString()}`
  ].join('\n'));

  if (!result.ok) {
    return res.status(result.error?.startsWith('Set SUPER_ADMIN_TELEGRAM_CHAT_ID') ||
      result.error?.includes('is not configured') ? 503 : 502)
      .json({ error: result.error || 'Telegram test notification could not be delivered.' });
  }
  return res.json({ message: 'Telegram test notification sent successfully.' });
});

app.get('/api/users', requireAdminAuthentication, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            where: req.adminRole === 'SUPER_ADMIN' ? {} : { role: { not: 'SUPER_ADMIN' } },
            select: {
                id: true,
                name: true,
                email: true,
                telegramId: true,
                telegramUsername: true,
                department: true,
                role: true,
                createdAt: true
            },
            orderBy: { id: 'desc' }
        });
        res.json(users);
    } catch (err) {
        console.error('Get Users Error:', err);
        res.locals.systemError = err;
        res.status(500).json({ error: 'Unable to fetch users.' });
    }
});

// Update User
app.patch('/api/users/:id', requireAdminAuthentication, async (req, res) => {
  try {
    const { id } = req.params;
    const { role, department, telegramId, telegramUsername } = req.body;

    if (role === 'SUPER_ADMIN' && req.adminRole !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only a Super Admin can assign the Super Admin role.' });
    }
    const assignableRoles = req.adminRole === 'SUPER_ADMIN'
      ? [...ADMIN_ASSIGNABLE_ROLES, 'SUPER_ADMIN']
      : ADMIN_ASSIGNABLE_ROLES;
    if (role != null && !assignableRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }

    const userId = Number(id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'A valid user ID is required.' });
    }
    const previousUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, department: true, role: true, email: true }
    });
    if (!previousUser) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (previousUser.role === 'SUPER_ADMIN' && req.adminRole !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only a Super Admin can manage Super Admin accounts.' });
    }
    if (userId === req.approverId && previousUser.role === 'SUPER_ADMIN' &&
        role != null && role !== 'SUPER_ADMIN') {
      return res.status(400).json({ error: 'You cannot remove your own Super Admin access.' });
    }
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(role && { role }),
        ...(department && { department }),
        ...((telegramUsername || telegramId) && {
          telegramUsername: String(telegramUsername || telegramId).replace(/^@+/, '').trim().toLowerCase()
        })
      }
    });

    if (previousUser.role !== updatedUser.role || previousUser.department !== updatedUser.department) {
      notifyUserActivity('👤 [PROFILE UPDATED]', updatedUser, 'An administrator changed this user profile.');
    }
    res.json({ message: "User updated successfully", user: updatedUser });
  } catch (error) {
    res.locals.systemError = error;
    res.status(500).json({ error: 'Unable to update user.' });
  }
});

// Delete User
app.delete('/api/users/:id', requireAdminAuthentication, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'A valid user ID is required.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true }
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (userId === req.approverId) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    if (user.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'The Super Admin account cannot be deleted.' });
    }

    await prisma.$transaction(async (transaction) => {
      const requests = await transaction.request.findMany({
        where: { userId },
        select: { id: true }
      });
      const requestIds = requests.map(request => request.id);
      await transaction.auditLog.deleteMany({
        where: {
          OR: [
            { userId },
            ...(requestIds.length ? [{ requestId: { in: requestIds } }] : [])
          ]
        }
      });
      await transaction.request.deleteMany({ where: { userId } });
      await transaction.user.delete({ where: { id: userId } });
    });

    return res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    console.error('Delete User Error:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// Create Request API
app.post('/api/requests', requireCompletedProfile, uploadRequestAttachment, async (req, res) => {
  try {
    const { title, description, category, targetDepartment, extraFields } = req.body;
    const requiresExecutiveApproval = req.body.requiresExecutiveApproval === true ||
      req.body.requiresExecutiveApproval === 'true';
    if (!isAllowedAttachment(req.file)) {
      return res.status(415).json({
        error: 'Only JPEG, PNG, WebP, PDF, DOC, and DOCX attachments are supported.'
      });
    }
    const categoryName = String(category || 'General').trim();
    const requestUserId = req.approverId;
    const originUser = await prisma.user.findUnique({
      where: { id: requestUserId },
      select: { id: true, department: true, name: true }
    });
    if (!originUser) {
      return res.status(401).json({ error: 'The account for this session no longer exists.' });
    }
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'A request title is required.' });
    }

    const originDepartment = originUser.department || targetDepartment || 'General';
    const requestTargetDepartment = typeof targetDepartment === 'string' && targetDepartment.trim()
      ? targetDepartment.trim()
      : originUser.department || 'General';
    const chain = buildApprovalChain(
      originDepartment,
      requestTargetDepartment,
      requiresExecutiveApproval
    );
    const telegramFile = req.file
      ? await uploadAttachmentToTelegram(req.file)
      : null;
    const attachmentFileName = req.file
      ? safeAttachmentFileName(req.file.originalname)
      : null;

    const newRequest = await prisma.request.create({
      data: {
        title: title.trim(),
        description,
        category: categoryName,
        targetDepartment: requestTargetDepartment,
        requiresExecutiveApproval,
        approvalStage: chain[0].stage,
        currentApprovalStep: 0,
        userId: requestUserId,
        extraFields: extraFields || null,
        ...(telegramFile && {
          attachmentFile: {
            create: {
              telegramFileId: telegramFile.file_id,
              fileName: attachmentFileName,
              mimeType: req.file.mimetype,
              fileSize: req.file.size,
              publicUrl: `/api/files/${encodeURIComponent(telegramFile.file_id)}`,
              uploadedById: requestUserId
            }
          }
        }),
        approvalSteps: {
          create: chain.map(({ stage, ...step }) => step)
        }
      },
      include: {
        user: { select: { id: true, name: true, telegramFirstName: true, department: true } },
        attachmentFile: true,
        approvalSteps: { orderBy: { sequence: 'asc' } }
      }
    });
    void notifyRequestManagers(newRequest).catch(error => {
      console.error(`Unable to send new-request Telegram notifications for request ${newRequest.id}:`, error);
    });
    void notifyRequestActivity('📝 [NEW REQUEST]', newRequest);
    return res.status(201).json(newRequest);
  } catch (error) {
    console.error('Create Request Error:', error);
    res.locals.systemError = error;
    res.status(500).json({ error: 'Unable to create request.' });
  }
});

app.get('/api/requests', requireCompletedProfile, async (req, res) => {
  try {
    const actor = await prisma.user.findUnique({
      where: { id: req.approverId },
      select: { id: true, role: true, department: true }
    });
    if (!actor) {
      return res.status(401).json({ error: 'The account for this session no longer exists.' });
    }

    const visibilityWhere = {};
    if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) {
      const approvalStage = DEPARTMENT_APPROVER_ROLES.includes(actor.role) && actor.department
        ? `PENDING_${actor.department.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MANAGER`
        : 'PENDING_EXECUTIVE';
      const assignedStepWhere = {
        status: 'PENDING',
        approverRole: ['GM', 'DGM'].includes(actor.role) ? 'EXECUTIVE' : 'MANAGER',
        request: { is: { status: 'PENDING', approvalStage } }
      };
      if (DEPARTMENT_APPROVER_ROLES.includes(actor.role)) {
        assignedStepWhere.department = actor.department;
      }
      const assignedSteps = [...DEPARTMENT_APPROVER_ROLES, 'GM', 'DGM'].includes(actor.role)
        ? await prisma.requestApprovalStep.findMany({
          where: assignedStepWhere,
          select: { requestId: true }
        })
        : [];
      const assignedRequestIds = [...new Set(assignedSteps.map(step => step.requestId))];
      visibilityWhere.OR = [
        { userId: actor.id },
        {
          approvalSteps: {
            some: {
              approvedById: actor.id,
              status: { in: ['APPROVED', 'REJECTED'] }
            }
          }
        },
        ...(assignedRequestIds.length ? [{ id: { in: assignedRequestIds } }] : [])
      ];
    }

    const filters = [];
    const status = String(req.query.status || '').trim().toUpperCase();
    if (status) {
      if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
        return res.status(400).json({ error: 'Invalid request status filter.' });
      }
      filters.push({ status });
    }
    const category = String(req.query.category || '').trim();
    if (category) {
      filters.push({ category });
    }
    const search = String(req.query.search || '').trim().slice(0, 200);
    if (search) {
      filters.push({
        OR: [
          { title: { contains: search } },
          { description: { contains: search } },
          { extraFields: { contains: search } }
        ]
      });
    }
    const where = { AND: [visibilityWhere, ...filters] };
    const [requests, statusCounts] = await Promise.all([
      prisma.request.findMany({
        where,
        include: {
          attachmentFile: true,
          user: { select: { id: true, name: true, department: true, role: true } },
          auditLogs: {
            include: { user: { select: { id: true, name: true, role: true } } },
            orderBy: { createdAt: 'desc' }
          },
          approvalSteps: {
            include: { approvedBy: { select: { id: true, name: true, role: true } } },
            orderBy: { sequence: 'asc' }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.request.groupBy({
        by: ['status'],
        where: visibilityWhere,
        _count: { _all: true }
      })
    ]);
    const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const item of statusCounts) {
      if (Object.prototype.hasOwnProperty.call(counts, item.status)) {
        counts[item.status] = item._count._all;
      }
    }
    return res.json({ requests, counts });
  } catch (error) {
    console.error('Get Requests Error:', error);
    res.locals.systemError = error;
    res.status(500).json({ error: 'Unable to fetch requests.' });
  }
});

app.patch('/api/requests/:id', requireCompletedProfile, async (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'A valid request ID is required.' });
  }

  const data = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'title')) {
    if (typeof req.body.title !== 'string' || !req.body.title.trim()) {
      return res.status(400).json({ error: 'A request title is required.' });
    }
    data.title = req.body.title.trim();
  }
  for (const field of ['description', 'category', 'extraFields']) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      data[field] = req.body[field] == null ? null : String(req.body[field]);
    }
  }
  if (!Object.keys(data).length) {
    return res.status(400).json({ error: 'Provide at least one request field to update.' });
  }

  try {
    const request = await prisma.request.findUnique({
      where: { id: requestId },
      select: { id: true, userId: true, status: true }
    });
    if (!request) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    if (request.userId !== req.approverId) {
      return res.status(403).json({ error: 'Only the requester can edit this request.' });
    }
    if (request.status !== 'PENDING') {
      return res.status(409).json({ error: 'Only pending requests can be edited.' });
    }

    const updatedRequest = await prisma.$transaction(async transaction => {
      const updateResult = await transaction.request.updateMany({
        where: { id: requestId, userId: req.approverId, status: 'PENDING' },
        data
      });
      if (updateResult.count !== 1) {
        throw new Error('This request can no longer be edited.');
      }
      await transaction.auditLog.create({
        data: {
          action: 'REQUEST_UPDATED',
          remarks: `Updated request fields: ${Object.keys(data).join(', ')}.`,
          userId: req.approverId,
          requestId
        }
      });
      return transaction.request.findUnique({
        where: { id: requestId },
        include: {
          user: { select: { name: true, telegramFirstName: true, department: true } }
        }
      });
    });
    void notifyRequestActivity('📝 [REQUEST UPDATED]', updatedRequest);
    return res.json({ message: 'Request updated successfully.', request: updatedRequest });
  } catch (error) {
    if (error.message === 'This request can no longer be edited.') {
      return res.status(409).json({ error: error.message });
    }
    console.error('Update Request Error:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to update request.' });
  }
});

function canUserSeeRequest(request, actor) {
  if (['ADMIN', 'SUPER_ADMIN'].includes(actor.role) || request.userId === actor.id) {
    return true;
  }
  if (request.approvalSteps.some(step =>
    step.approvedById === actor.id && ['APPROVED', 'REJECTED'].includes(step.status)
  )) {
    return true;
  }
  if (request.status !== 'PENDING') return false;
  const currentStep = request.approvalSteps.find(
    step => step.sequence === request.currentApprovalStep && step.status === 'PENDING'
  );
  if (!currentStep) return false;
  if (currentStep.approverRole === 'EXECUTIVE') {
    return ['GM', 'DGM'].includes(actor.role);
  }
  return DEPARTMENT_APPROVER_ROLES.includes(actor.role) &&
    String(actor.department || '').trim().toLowerCase() ===
      String(currentStep.department || '').trim().toLowerCase();
}

app.get('/api/legacy-files/:fileName', requireCompletedProfile, async (req, res) => {
  const fileName = path.basename(String(req.params.fileName || '').replace(/\\/g, '/'));
  if (!fileName || fileName === '.' || fileName === '..') {
    return res.status(400).json({ error: 'A valid attachment name is required.' });
  }

  try {
    const legacyPaths = [`uploads/${fileName}`, `./uploads/${fileName}`];
    const request = await prisma.request.findFirst({
      where: { attachment: { in: legacyPaths } },
      include: { approvalSteps: true }
    });
    if (!request) {
      return res.status(404).json({ error: 'Legacy attachment not found.' });
    }

    const actor = await prisma.user.findUnique({
      where: { id: req.approverId },
      select: { id: true, role: true, department: true }
    });
    if (!actor || !canUserSeeRequest(request, actor)) {
      return res.status(403).json({ error: 'You are not allowed to access this attachment.' });
    }

    const uploadDirectory = await fs.realpath(path.resolve(__dirname, 'uploads'));
    const filePath = await fs.realpath(path.join(uploadDirectory, fileName));
    const relativePath = path.relative(uploadDirectory, filePath);
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      return res.status(400).json({ error: 'Invalid attachment path.' });
    }
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return res.status(404).json({ error: 'Legacy attachment is unavailable.' });
    }

    const extension = path.extname(fileName).toLowerCase();
    const mimeType = [...ALLOWED_ATTACHMENT_TYPES].find(([, extensions]) => extensions.has(extension))?.[0] ||
      'application/octet-stream';
    const content = await fs.readFile(filePath);
    res.set({
      'Content-Type': mimeType,
      'Content-Length': String(content.length),
      'Content-Disposition': getAttachmentContentDisposition(fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.send(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Legacy attachment is unavailable.' });
    }
    console.error('Unable to retrieve legacy attachment:', error.message);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to retrieve the attachment.' });
  }
});

app.get('/api/files/:fileId', requireCompletedProfile, async (req, res) => {
  const fileId = String(req.params.fileId || '');
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(fileId)) {
    return res.status(400).json({ error: 'A valid Telegram file ID is required.' });
  }

  try {
    const attachment = await prisma.attachment.findFirst({
      where: { telegramFileId: fileId },
      include: {
        request: { include: { approvalSteps: true } }
      }
    });
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found.' });
    }

    const actor = await prisma.user.findUnique({
      where: { id: req.approverId },
      select: { id: true, role: true, department: true }
    });
    if (!actor || !canUserSeeRequest(attachment.request, actor)) {
      return res.status(403).json({ error: 'You are not allowed to access this attachment.' });
    }
    if (!TELEGRAM_BOT_TOKEN) {
      return res.status(503).json({ error: 'Telegram file storage is not configured.' });
    }

    const metadataResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const metadata = await metadataResponse.json();
    if (!metadataResponse.ok || !metadata.ok || !metadata.result?.file_path) {
      throw new Error(`Telegram getFile failed: ${metadata.description || metadataResponse.statusText}`);
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${metadata.result.file_path}`,
      { signal: AbortSignal.timeout(30000) }
    );
    if (!telegramResponse.ok) {
      throw new Error(`Telegram file download failed: ${telegramResponse.statusText}`);
    }
    const content = Buffer.from(await telegramResponse.arrayBuffer());
    if (content.length > MAX_ATTACHMENT_SIZE_BYTES) {
      return res.status(413).json({ error: 'The stored attachment exceeds the supported download size.' });
    }

    res.set({
      'Content-Type': attachment.mimeType,
      'Content-Length': String(content.length),
      'Content-Disposition': getAttachmentContentDisposition(attachment.fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.send(content);
  } catch (error) {
    console.error(`Unable to retrieve Telegram attachment for request ${req.params.fileId}:`, error.message);
    res.locals.systemError = error;
    return res.status(502).json({ error: 'Unable to retrieve the attachment from Telegram.' });
  }
});

function requireApprovalAuthentication(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'A valid login session is required.' });
  }
  try {
    const payload = jwt.verify(match[1], jwtSecret);
    const approverId = Number(payload.sub);
    if (!Number.isSafeInteger(approverId) || approverId <= 0) {
      return res.status(401).json({ error: 'A valid login session is required.' });
    }
    req.approverId = approverId;
    return next();
  } catch {
    return res.status(401).json({ error: 'Your login session is invalid or expired.' });
  }
}

async function requireCompletedProfile(req, res, next) {
  return requireApprovalAuthentication(req, res, async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.approverId },
        select: { role: true, department: true }
      });
      if (!user) {
        return res.status(401).json({ error: 'The account for this session no longer exists.' });
      }
      if (!user.role || !user.department) {
        return res.status(403).json({ error: 'Complete your profile before accessing requests.' });
      }
      return next();
    } catch (error) {
      console.error('Profile Access Check Error:', error);
      res.locals.systemError = error;
      return res.status(500).json({ error: 'Unable to verify profile status.' });
    }
  });
}

async function requireAdminAuthentication(req, res, next) {
  return requireApprovalAuthentication(req, res, async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.approverId },
        select: { role: true }
      });
      if (!user) {
        return res.status(401).json({ error: 'The account for this session no longer exists.' });
      }
      if (!['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
        return res.status(403).json({ error: 'Administrator access is required.' });
      }
      req.adminRole = user.role;
      return next();
    } catch (error) {
      console.error('Administrator Access Check Error:', error);
      res.locals.systemError = error;
      return res.status(500).json({ error: 'Unable to verify administrator access.' });
    }
  });
}

async function requireSuperAdminAuthentication(req, res, next) {
  return requireAdminAuthentication(req, res, () => {
    if (req.adminRole !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Super Admin access is required.' });
    }
    return next();
  });
}

async function handleRequestApproval(req, res) {
  try {
    const requestId = Number(req.params.id);
    const approverId = req.approverId;
    const { status, remarks } = req.body || {};
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: 'A valid request ID is required.' });
    }
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be APPROVED or REJECTED.' });
    }

    const request = await prisma.request.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        userId: true,
        status: true,
        currentApprovalStep: true,
        approvalSteps: {
          orderBy: { sequence: 'asc' }
        }
      }
    });
    if (!request) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    if (request.status !== 'PENDING') {
      return res.status(409).json({ error: 'This request is no longer awaiting approval.' });
    }

    const approver = await prisma.user.findUnique({
      where: { id: approverId },
      select: { id: true, role: true, department: true }
    });
    if (!approver || ![...DEPARTMENT_APPROVER_ROLES, 'GM', 'DGM'].includes(approver.role)) {
      return res.status(403).json({ error: 'Your account is not assigned to an approval role.' });
    }
    if (request.userId === approver.id) {
      return res.status(403).json({ error: 'You cannot approve or reject your own request.' });
    }

    const currentStep = request.approvalSteps.find(step => step.sequence === request.currentApprovalStep);
    if (!currentStep || currentStep.status !== 'PENDING') {
      return res.status(409).json({ error: 'The current approval step is unavailable. Refresh and try again.' });
    }

    const isAssignedApprover = currentStep.approverRole === 'EXECUTIVE'
      ? ['GM', 'DGM'].includes(approver.role)
      : DEPARTMENT_APPROVER_ROLES.includes(approver.role) &&
        String(approver.department || '').trim().toLowerCase() ===
          String(currentStep.department || '').trim().toLowerCase();
    if (!isAssignedApprover) {
      return res.status(403).json({ error: 'Your role or department does not match the current approval step.' });
    }

    const previousSteps = request.approvalSteps.filter(step => step.sequence < currentStep.sequence);
    if (previousSteps.some(step => step.approvedById === approver.id)) {
      return res.status(403).json({ error: 'You cannot approve the same request at multiple steps.' });
    }

    const nextStep = request.approvalSteps.find(step => step.sequence === currentStep.sequence + 1);
    const transition = getApprovalTransition(status, currentStep, nextStep);
    const action = `${currentStep.approverRole}_${status}`;

    const updatedRequest = await prisma.$transaction(async transaction => {
      const updatedStep = await transaction.requestApprovalStep.updateMany({
        where: { id: currentStep.id, status: 'PENDING' },
        data: {
          status,
          approvedById: approver.id,
          remarks: typeof remarks === 'string' && remarks.trim() ? remarks.trim() : null,
          actedAt: new Date()
        }
      });
      if (updatedStep.count !== 1) {
        throw new Error('This request has already been updated. Refresh and try again.');
      }
      if (status === 'REJECTED') {
        await transaction.requestApprovalStep.updateMany({
          where: { requestId, sequence: { gt: currentStep.sequence }, status: 'PENDING' },
          data: { status: 'SKIPPED' }
        });
      }
      const updated = await transaction.request.updateMany({
        where: {
          id: requestId,
          status: 'PENDING',
          currentApprovalStep: currentStep.sequence
        },
        data: {
          ...transition
        }
      });
      if (updated.count !== 1) {
        throw new Error('This request has already been updated. Refresh and try again.');
      }
      await transaction.auditLog.create({
        data: {
          action,
          remarks: typeof remarks === 'string' && remarks.trim()
            ? remarks.trim()
            : `${status === 'APPROVED' ? 'Approved' : 'Rejected'} at ${currentStep.department || 'Final Executive'} approval step.`,
          userId: approver.id,
          requestId
        }
      });
      return transaction.request.findUnique({
        where: { id: requestId },
        include: {
          user: { select: { name: true, telegramFirstName: true, department: true } },
          approvalSteps: { orderBy: { sequence: 'asc' } }
        }
      });
    });

    void notifyRequestActivity('🔄 [STATUS CHANGE]', updatedRequest);
    if (updatedRequest.status !== request.status &&
        ['APPROVED', 'REJECTED'].includes(updatedRequest.status)) {
      void notifyRequestOwner(updatedRequest, updatedRequest.status).catch(error => {
        console.error(`Unable to send status Telegram notification for request ${requestId}:`, error);
      });
    }
    return res.json({ message: 'Request approval updated.', request: updatedRequest });
  } catch (error) {
    if (error.message === 'This request has already been updated. Refresh and try again.') {
      return res.status(409).json({ error: error.message });
    }
    console.error('Request Approval Error:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to update request approval.' });
  }
}

app.patch('/api/requests/:id/approval', requireCompletedProfile, handleRequestApproval);

app.patch('/api/requests/:id/status', requireCompletedProfile, handleRequestApproval);

function escapeCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

app.get('/api/reports/monthly', requireSuperAdminAuthentication, async (req, res) => {
  try {
    const period = getUtcMonthPeriod();
    const { report, requests } = await generateMonthlyReport(period);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Request Management System';
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.addRows([
      ['Monthly Request Report', report.monthKey],
      ['Total Requests', report.totalRequests],
      ['✅ Approved', report.approvedCount],
      ['❌ Rejected', report.rejectedCount],
      ['⏳ Pending', report.pendingCount],
      ['Generated At (UTC)', report.generatedAt.toISOString()]
    ]);
    summarySheet.getColumn(1).width = 28;
    summarySheet.getColumn(2).width = 32;
    summarySheet.getRow(1).font = { bold: true, size: 14 };
    summarySheet.getColumn(2).alignment = { vertical: 'top' };

    const requestsSheet = workbook.addWorksheet('Requests');
    requestsSheet.columns = [
      { width: 14 },
      { width: 40 },
      { width: 22 },
      { width: 24 },
      { width: 16 },
      { width: 22 },
      { width: 28 },
      { width: 28 }
    ];
    requestsSheet.addRow([
      'Request ID', 'Title', 'Category', 'Target Department', 'Status',
      'Amount (MMK)', 'Requester', 'Created At (UTC)'
    ]);
    requests.forEach(request => {
      requestsSheet.addRow([
        request.id,
        request.title,
        request.category,
        request.targetDepartment || 'General',
        request.status,
        getRequestAmount(request.extraFields),
        request.user?.name || 'Unknown',
        request.createdAt.toISOString()
      ]);
    });
    requestsSheet.getRow(1).font = { bold: true };
    requestsSheet.views = [{ state: 'frozen', ySplit: 1 }];

    const file = Buffer.from(await workbook.xlsx.writeBuffer());
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="monthly-request-report-${report.monthKey}.xlsx"`,
      'Cache-Control': 'private, no-store'
    });
    return res.send(file);
  } catch (error) {
    console.error('Monthly report export failed:', error);
    res.locals.systemError = error;
    return res.status(500).json({ error: 'Unable to generate the monthly report.' });
  }
});

app.get('/api/export/requests', requireCompletedProfile, async (req, res) => {
  try {
    const actor = await prisma.user.findUnique({
      where: { id: req.approverId },
      select: { id: true, role: true, department: true }
    });
    if (!actor) {
      return res.status(401).json({ error: 'The account for this session no longer exists.' });
    }
    const requests = await prisma.request.findMany({
      include: {
        approvalSteps: true
      },
      orderBy: { createdAt: 'desc' }
    });
    const rows = [
      ['ID', 'Title', 'Category', 'Target Dept', 'Stage', 'Status', 'Description', 'Date'],
      ...requests.filter(request => canUserSeeRequest(request, actor)).map(request => [
        request.id,
        request.title,
        request.category,
        request.targetDepartment || 'General',
        request.approvalStage,
        request.status,
        request.description || '',
        request.createdAt.toISOString()
      ])
    ];
    const csv = rows.map(row => row.map(escapeCsvCell).join(',')).join('\r\n');
    res.header('Content-Type', 'text/csv');
    res.attachment('security_audit_request_report.csv');
    res.send(csv);
  } catch (error) {
    res.locals.systemError = error;
    res.status(500).json({ error: 'Unable to export requests.' });
  }
});

app.use((error, req, res, next) => {
  const statusCode = Number(error.statusCode || error.status) || 500;
  if (statusCode >= 500) {
    res.locals.systemError = error;
    console.error('Unhandled HTTP request error:', error);
  }
  if (res.headersSent) {
    return next(error);
  }
  return res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal server error.' : error.message
  });
});

const PORT = process.env.PORT || 5000;

async function start() {
  assertPostgresDatabaseUrl(process.env.DATABASE_URL);
  if (!hasStrongJwtSecret) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes before the server can start.');
  }

  await initializeApprovalChains();
  await initSuperAdmin();
  startMonthlyReportScheduler();

  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    void configureTelegramWebhook().catch(error => {
    console.error('Telegram webhook auto-setup failed:', error.message);
    });
    resolve(server);
    });
    server.once('error', reject);
  });
}

if (require.main === module) {
  start().catch(async error => {
    console.error('Unable to prepare the database; server was not started:', error);
    await notifySuperAdmin(formatServerError(error, 'Server startup failure'));
    await prisma.$disconnect();
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  start,
  buildApprovalChain,
  getApprovalTransition,
  canUserSeeRequest,
  verifyTelegramLogin,
  createTelegramLinkToken,
  createTelegramDeepLink,
  parseTelegramStartPayload,
  getRequestAmount,
  formatRequestNotification,
  formatTelegramField,
  escapeCsvCell,
  formatServerError,
  redactSensitiveErrorText,
  splitTelegramMessage,
  isAllowedAttachment,
  safeAttachmentFileName,
  getAttachmentContentDisposition,
  configureTelegramWebhook,
  isValidOnboardingProfile,
  SELF_ASSIGNABLE_ROLES,
  ADMIN_ASSIGNABLE_ROLES
};