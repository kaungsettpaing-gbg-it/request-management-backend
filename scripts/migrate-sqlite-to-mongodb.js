require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const mongoose = require('mongoose');
const { connectDatabase } = require('../lib/database');
const { hashPassword, BCRYPT_HASH_PATTERN } = require('../lib/user-password');
const User = require('../models/User');
const Request = require('../models/Request');
const AuditLog = require('../models/AuditLog');
const { initializeCounters } = require('../server');

const prisma = new PrismaClient();

function normalizeTelegramId(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.replace(/^@+/, '').trim().toLowerCase() || null;
}

async function migrate() {
  await connectDatabase(process.env.MONGODB_URI);
  await Promise.all([User.init(), Request.init(), AuditLog.init()]);

  const [users, requests, auditLogs] = await Promise.all([
    prisma.user.findMany(),
    prisma.request.findMany(),
    prisma.auditLog.findMany()
  ]);

  const emailSet = new Set();
  const telegramSet = new Set();
  for (const user of users) {
    const email = user.email.trim().toLowerCase();
    if (emailSet.has(email)) {
      throw new Error(`SQLite contains duplicate email addresses after normalization: ${email}`);
    }
    emailSet.add(email);

    const telegramId = normalizeTelegramId(user.telegramId);
    if (telegramId && telegramSet.has(telegramId)) {
      throw new Error(`SQLite contains duplicate Telegram usernames after normalization: ${telegramId}`);
    }
    if (telegramId) telegramSet.add(telegramId);
  }

  const userIds = new Set(users.map(user => user.id));
  const requestIds = new Set(requests.map(request => request.id));
  const bootstrapEmail = (process.env.SUPER_ADMIN_EMAIL || 'superadmin@company.com').trim().toLowerCase();
  const bootstrapTelegram = normalizeTelegramId(
    process.env.SUPER_ADMIN_TELEGRAM_USERNAME || 'okeydokey2'
  );
  const configuredAdminPassword = process.env.SUPER_ADMIN_PASSWORD;
  const hasBootstrapAdmin = users.some(user =>
    user.role === 'SUPER_ADMIN' ||
    user.email.trim().toLowerCase() === bootstrapEmail ||
    normalizeTelegramId(user.telegramId) === bootstrapTelegram
  );
  if (hasBootstrapAdmin && !configuredAdminPassword) {
    throw new Error('Set SUPER_ADMIN_PASSWORD to rotate the imported administrator password.');
  }

  for (const request of requests) {
    if (!userIds.has(request.userId)) {
      throw new Error(`Request ${request.id} references a missing user (${request.userId}).`);
    }
  }
  for (const log of auditLogs) {
    if (!userIds.has(log.userId) || !requestIds.has(log.requestId)) {
      throw new Error(`Audit log ${log.id} references a missing user or request.`);
    }
  }

  const userOperations = [];
  for (const user of users) {
    const isBootstrapAdmin = user.role === 'SUPER_ADMIN' ||
      user.email.trim().toLowerCase() === bootstrapEmail ||
      normalizeTelegramId(user.telegramId) === bootstrapTelegram;
    let password;
    if (isBootstrapAdmin && configuredAdminPassword) {
      if (Buffer.byteLength(configuredAdminPassword, 'utf8') < 12 ||
          Buffer.byteLength(configuredAdminPassword, 'utf8') > 72) {
        throw new Error('SUPER_ADMIN_PASSWORD must be between 12 and 72 bytes.');
      }
      password = await hashPassword(configuredAdminPassword);
    } else {
      password = BCRYPT_HASH_PATTERN.test(user.password)
        ? user.password
        : await hashPassword(user.password);
    }
    userOperations.push({
      updateOne: {
        filter: { id: user.id },
        update: {
          $setOnInsert: {
            id: user.id,
            email: user.email.trim().toLowerCase(),
            password,
            name: user.name,
            department: user.department,
            role: user.role && user.role !== 'USER' ? user.role : 'STAFF',
            telegramId: normalizeTelegramId(user.telegramId),
            otp: user.otp,
            otpExpiry: user.otpExpiry,
            createdAt: user.createdAt
          }
        },
        upsert: true
      }
    });
  }

  const requestOperations = requests.map(request => ({
    updateOne: {
      filter: { id: request.id },
      update: {
        $setOnInsert: {
          id: request.id,
          title: request.title,
          description: request.description,
          category: request.category,
          status: request.status,
          targetDepartment: request.targetDepartment,
          approvalStage: request.approvalStage === 'DEPT_MGR'
            ? 'ORIGIN_MGR'
            : request.approvalStage,
          extraFields: request.extraFields,
          attachment: request.attachment,
          userId: request.userId,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt
        }
      },
      upsert: true
    }
  }));

  const auditOperations = auditLogs.map(log => ({
    updateOne: {
      filter: { id: log.id },
      update: {
        $setOnInsert: {
          id: log.id,
          action: log.action,
          remarks: log.remarks,
          userId: log.userId,
          requestId: log.requestId,
          createdAt: log.createdAt
        }
      },
      upsert: true
    }
  }));

  if (userOperations.length) await User.bulkWrite(userOperations, { ordered: true });
  if (requestOperations.length) await Request.bulkWrite(requestOperations, { ordered: true });
  if (auditOperations.length) await AuditLog.bulkWrite(auditOperations, { ordered: true });
  await initializeCounters();

  console.log(`Migration complete: ${users.length} users, ${requests.length} requests, and ${auditLogs.length} audit logs processed.`);
}

migrate()
  .catch(error => {
    console.error('SQLite-to-MongoDB migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await mongoose.disconnect();
  });
