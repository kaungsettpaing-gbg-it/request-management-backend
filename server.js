const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { assertPostgresDatabaseUrl } = require('./lib/database-url');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured before the server can start.');
}
const prisma = new PrismaClient();
const app = express();
const hasStrongJwtSecret = typeof process.env.JWT_SECRET === 'string' &&
  Buffer.byteLength(process.env.JWT_SECRET, 'utf8') >= 32;
const jwtSecret = hasStrongJwtSecret
  ? process.env.JWT_SECRET
  : crypto.randomBytes(48).toString('base64');
if (!hasStrongJwtSecret) {
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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
  return Boolean(extensions && extensions.has(path.extname(file.originalname).toLowerCase()));
}

function safeAttachmentFileName(fileName) {
  return path.basename(String(fileName || 'attachment'))
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
let cachedSuperAdminChatId = null;
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
      tag,
      `Request ID: ${request.id}`,
      `Title: ${request.title}`,
      `Status: ${request.status}`,
      `Requester: ${requester?.name || requester?.telegramFirstName || 'Unknown'}`,
      `Department: ${requester?.department || 'Not specified'}`,
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
    tag,
    `User: ${user.name || user.telegramFirstName || 'Unknown'}`,
    `Email: ${user.email || 'Telegram account'}`,
    `Department: ${user.department || 'Not specified'}`,
    `Role: ${user.role || 'Not assigned'}`,
    `Activity: ${activity}`,
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
    `Request #${request.id}`,
    `Title: ${request.title}`,
    `Status: ${status}`,
    `Amount: ${getRequestAmount(request.extraFields)}`,
    `Requester: ${request.user?.name || request.user?.telegramFirstName || 'Unknown'}`
  ].join('\n');
}

async function notifyTelegramChats(chatIds, message) {
  const uniqueChatIds = [...new Set(chatIds.filter(chatId => {
    if (/^\d+$/.test(String(chatId))) return true;
    console.warn('Telegram notification skipped for an account without a numeric Telegram chat ID.');
    return false;
  }).map(String))];
  const results = await Promise.allSettled(
    uniqueChatIds.map(chatId => sendTelegramMessage(chatId, message))
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Telegram notification failed for chat ${uniqueChatIds[index]}:`, result.reason.message);
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

// Auto Init Super Admin
async function initSuperAdmin() {
    const superAdminEmail = 'superadmin@company.com';
    const superAdminTelegram = 'okeydokey2';

    const adminExists = await prisma.user.findFirst({
        where: {
            OR: [
                { role: 'SUPER_ADMIN' },
                { email: superAdminEmail },
                { telegramUsername: superAdminTelegram }
            ]
        }
    });

    if (adminExists) {
        if (adminExists.role === 'SUPER_ADMIN') {
            await bindSuperAdminTelegramAccount(adminExists);
        }
        console.log(`Super Admin is configured for ${adminExists.email}.`);
        return;
    }

    const password = process.env.SUPER_ADMIN_PASSWORD;
    if (!password) {
        console.warn('SUPER_ADMIN_PASSWORD is not configured. Skipping initial Super Admin creation.');
        return;
    }

    if (SUPER_ADMIN_TELEGRAM_CHAT_ID) {
        if (!/^\d+$/.test(SUPER_ADMIN_TELEGRAM_CHAT_ID)) {
            throw new Error('SUPER_ADMIN_TELEGRAM_CHAT_ID must be a numeric Telegram chat ID.');
        }
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
    const user = matchingTelegram || (await prisma.user.findMany({
      select: { id: true, name: true, email: true, telegramId: true, telegramUsername: true, password: true, role: true, department: true },
      where: {
        OR: [
          { email: { not: null } },
          { telegramId: { not: null } },
          { telegramUsername: { not: null } },
          { name: { not: null } }
        ]
      }
    })).find(candidate =>
      candidate.email?.trim().toLowerCase() === cleanKey ||
      candidate.telegramUsername?.trim().replace(/^@+/, '').toLowerCase() === cleanKey ||
      candidate.name?.trim().toLowerCase() === cleanKey
    );

    if (!user) {
      return res.status(401).json({ error: 'User not found.' });
    }

    const hasBcryptPassword = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.password);
    const passwordMatches = hasBcryptPassword
      ? await bcrypt.compare(password, user.password)
      : password === user.password;
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Incorrect password.' });
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
    res.status(500).json({ error: error.message });
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
    const { userId, code } = req.body;
    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });

    if (!user) {
      return res.status(400).json({ error: "User not found." });
    }

    if (!user.otp || user.otp !== code || (user.otpExpiry && new Date() > new Date(user.otpExpiry))) {
      return res.status(400).json({ error: "Invalid or expired OTP code." });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { otp: null, otpExpiry: null }
    });

    res.json({ message: "Authentication successful", user });
  } catch (error) {
    res.locals.systemError = error;
    res.status(500).json({ error: error.message });
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
    const newUser = await prisma.user.create({
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

    notifyUserActivity('👤 [NEW USER]', newUser, 'Registered with email and password.');
    res.status(201).json({
      message: 'User registered successfully',
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
            where: {
                role: { not: 'SUPER_ADMIN' }
            },
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
        res.status(500).json({ error: 'Failed to fetch users: ' + err.message });
    }
});

// Update User
app.patch('/api/users/:id', requireAdminAuthentication, async (req, res) => {
  try {
    const { id } = req.params;
    const { role, department, telegramId, telegramUsername } = req.body;

    if (role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Super Admin role is reserved and hidden from normal user management.' });
    }
    if (role != null && !ADMIN_ASSIGNABLE_ROLES.includes(role)) {
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
      return next();
    } catch (error) {
      console.error('Administrator Access Check Error:', error);
      res.locals.systemError = error;
      return res.status(500).json({ error: 'Unable to verify administrator access.' });
    }
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
    let csv = 'ID,Title,Category,Target Dept,Stage,Status,Description,Date\n';
    requests.filter(request => canUserSeeRequest(request, actor)).forEach(r => {
      const desc = (r.description || '').replace(/"/g, '""');
      csv += `${r.id},"${r.title}","${r.category}","${r.targetDepartment || 'General'}","${r.approvalStage}","${r.status}","${desc}","${r.createdAt}"\n`;
    });
    res.header('Content-Type', 'text/csv');
    res.attachment('security_audit_request_report.csv');
    res.send(csv);
  } catch (error) {
    res.locals.systemError = error;
    res.status(500).json({ error: error.message });
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

function isDatabaseSchemaUnavailable(error) {
  return error?.code === 'P2021' ||
    /no such table|table .* does not exist|relation .* does not exist/i.test(error?.message || '');
}

async function runStartupInitializer(name, initialize) {
  try {
    await initialize();
  } catch (error) {
    if (isDatabaseSchemaUnavailable(error)) {
      console.warn(`Database tables are not initialized; skipping ${name} for now. Run Prisma db push or migrations.`, error.message);
      return;
    }
    console.error(`Error during ${name}:`, error);
    void notifySuperAdmin(formatServerError(error, `Startup initializer: ${name}`));
  }
}

async function start() {
  assertPostgresDatabaseUrl(process.env.DATABASE_URL);

  return app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server is running on port ${PORT}`);

    await runStartupInitializer('approval chain initialization', initializeApprovalChains);
    await runStartupInitializer('Super Admin initialization', initSuperAdmin);
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error('Unable to prepare the database; server was not started:', error);
    void notifySuperAdmin(formatServerError(error, 'Server startup failure'));
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
  getRequestAmount,
  formatRequestNotification,
  formatServerError,
  redactSensitiveErrorText,
  splitTelegramMessage,
  isAllowedAttachment,
  safeAttachmentFileName,
  getAttachmentContentDisposition,
  isValidOnboardingProfile,
  SELF_ASSIGNABLE_ROLES,
  ADMIN_ASSIGNABLE_ROLES
};