const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured before the server can start.');
}
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL.startsWith('file:/')) {
  throw new Error('Production DATABASE_URL must use an absolute SQLite path on a persistent mounted volume.');
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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPER_ADMIN_TELE_USERNAME = 'okeydokey2';

// Send Telegram Message
async function sendTelegramOTP(chatId, otpCode) {
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🔐 *Security Verification*\n\nYour Login 2FA Code is: \`${otpCode}\`\nThis code expires in 5 minutes.`,
        parse_mode: 'Markdown'
      })
    });
    const data = await response.json();
    return data.ok;
  } catch (error) {
    console.error("Telegram API Error:", error.message);
    return false;
  }
}

// Get Chat ID by Telegram Username
async function getChatIdFromUsername(username) {
  if (!username) return null;
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
    }
    const cleanUsername = String(username).replace(/^@+/, '').trim().toLowerCase();
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.ok && data.result) {
      for (const update of data.result.reverse()) {
        const msg = update.message || update.edited_message;
        if (msg && msg.from && msg.from.username && msg.from.username.toLowerCase() === cleanUsername) {
          return msg.chat.id.toString();
        }
      }
    }
  } catch (err) {
    console.error("Error fetching Telegram Chat ID:", err.message);
  }
  return null;
}

// Auto Init Super Admin
async function initSuperAdmin() {
    try {
        const superAdminEmail = 'superadmin@company.com';
        const superAdminTelegram = 'okeydokey2';

        const adminExists = await prisma.user.findFirst({
            where: {
                OR: [
                    { role: 'SUPER_ADMIN' },
                    { email: superAdminEmail },
                    { telegramId: superAdminTelegram }
                ]
            }
        });

        if (adminExists) {
            console.log(`Super Admin is configured for ${adminExists.email}.`);
            return;
        }

        const password = process.env.SUPER_ADMIN_PASSWORD;
        if (!password) {
            console.warn('SUPER_ADMIN_PASSWORD is not configured. Skipping initial Super Admin creation.');
            return;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await prisma.user.create({
            data: {
                name: 'Super Admin',
                email: superAdminEmail,
                telegramId: superAdminTelegram,
                password: hashedPassword,
                role: 'SUPER_ADMIN',
                department: 'Executive Management'
            }
        });
        console.log(`Initial Super Admin created for ${superAdminEmail}.`);
    } catch (err) {
        console.error('Error initializing Super Admin:', err);
    }
}

function buildApprovalChain(originDepartment, targetDepartment) {
  const departments = [];
  for (const [index, department] of [originDepartment, targetDepartment].entries()) {
    if (typeof department !== 'string' || !department.trim()) continue;
    const normalizedDepartment = department.trim();
    if (index === 1 && normalizedDepartment.toLowerCase() === 'general') continue;
    if (!departments.some(existing => existing.toLowerCase() === normalizedDepartment.toLowerCase())) {
      departments.push(normalizedDepartment);
    }
  }

  return [
    ...departments.map(department => ({
      stepType: 'DEPARTMENT',
      department,
      approverRole: 'MANAGER',
      stage: `PENDING_${department.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MANAGER`
    })),
    {
      stepType: 'EXECUTIVE',
      department: null,
      approverRole: 'EXECUTIVE',
      stage: 'PENDING_EXECUTIVE'
    }
  ].map((step, sequence) => ({ ...step, sequence }));
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
    const chain = buildApprovalChain(request.user.department, request.targetDepartment);
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
      where: { telegramId: cleanKey }
    });
    const user = matchingTelegram || (await prisma.user.findMany({
      where: {
        OR: [
          { email: { not: null } },
          { telegramId: { not: null } },
          { name: { not: null } }
        ]
      }
    })).find(candidate =>
      candidate.email?.trim().toLowerCase() === cleanKey ||
      candidate.telegramId?.trim().replace(/^@+/, '').toLowerCase() === cleanKey ||
      candidate.name?.trim().toLowerCase() === cleanKey
    );

    if (!user) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch && password !== user.password) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    res.json({
      requiresMfa: false,
      token: jwt.sign({ sub: String(user.id) }, jwtSecret, { expiresIn: '8h' }),
      user: {
        id: user.id,
        name: user.name,
        telegramId: user.telegramId,
        role: user.role,
        department: user.department
      }
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});

// Create User API
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password, department, role, telegramId } = req.body || {};

    if (typeof name !== 'string' || !name.trim() ||
        typeof email !== 'string' || !email.trim() ||
        typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (existingUser) {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        department: department || 'General',
        role: role || 'STAFF',
        telegramId: typeof telegramId === 'string' && telegramId.trim()
          ? telegramId.replace(/^@+/, '').trim().toLowerCase()
          : null
      }
    });

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
    res.status(500).json({ error: error.message });
  }
});

// Get All Users API
app.get('/api/users', async (req, res) => {
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
                department: true,
                role: true,
                createdAt: true
            },
            orderBy: { id: 'desc' }
        });
        res.json(users);
    } catch (err) {
        console.error('Get Users Error:', err);
        res.status(500).json({ error: 'Failed to fetch users: ' + err.message });
    }
});

// Update User
app.patch('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { role, department, telegramId } = req.body;

    if (role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Super Admin role is reserved and hidden from normal user management.' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: Number(id) },
      data: {
        ...(role && { role }),
        ...(department && { department }),
        ...(telegramId && { telegramId: String(telegramId).replace(/^@+/, '').trim().toLowerCase() })
      }
    });

    res.json({ message: "User updated successfully", user: updatedUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete User
app.delete('/api/users/:id', async (req, res) => {
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
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// Create Request API
app.post('/api/requests', requireApprovalAuthentication, upload.single('attachment'), async (req, res) => {
  try {
    const { title, description, category, targetDepartment, extraFields } = req.body;
    const attachmentPath = req.file ? req.file.path : null;
    const categoryName = String(category || 'General').trim();
    const requestUserId = req.approverId;
    const originUser = await prisma.user.findUnique({
      where: { id: requestUserId },
      select: { id: true, department: true }
    });
    if (!originUser) {
      return res.status(401).json({ error: 'The account for this session no longer exists.' });
    }
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'A request title is required.' });
    }

    const originDepartment = originUser.department || targetDepartment || 'General';
    const requestTargetDepartment = targetDepartment || originUser.department || 'General';
    const chain = buildApprovalChain(originDepartment, requestTargetDepartment);

    const newRequest = await prisma.request.create({
      data: {
        title: title.trim(),
        description,
        category: categoryName,
        targetDepartment: requestTargetDepartment,
        approvalStage: chain[0].stage,
        currentApprovalStep: 0,
        userId: requestUserId,
        attachment: attachmentPath,
        extraFields: extraFields || null,
        approvalSteps: {
          create: chain.map(({ stage, ...step }) => step)
        }
      },
      include: { approvalSteps: { orderBy: { sequence: 'asc' } } }
    });
    return res.status(201).json(newRequest);
  } catch (error) {
    console.error('Create Request Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/requests', requireApprovalAuthentication, async (req, res) => {
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
      const approvalStage = actor.role === 'MANAGER' && actor.department
        ? `PENDING_${actor.department.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MANAGER`
        : 'PENDING_EXECUTIVE';
      const assignedStepWhere = {
        status: 'PENDING',
        approverRole: ['GM', 'DGM'].includes(actor.role) ? 'EXECUTIVE' : 'MANAGER',
        request: { is: { status: 'PENDING', approvalStage } }
      };
      if (actor.role === 'MANAGER') {
        assignedStepWhere.department = actor.department;
      }
      const assignedSteps = ['MANAGER', 'GM', 'DGM'].includes(actor.role)
        ? await prisma.requestApprovalStep.findMany({
          where: assignedStepWhere,
          select: { requestId: true }
        })
        : [];
      const assignedRequestIds = [...new Set(assignedSteps.map(step => step.requestId))];
      visibilityWhere.OR = [
        { userId: actor.id },
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
    res.status(500).json({ error: error.message });
  }
});

function canUserSeeRequest(request, actor) {
  if (['ADMIN', 'SUPER_ADMIN'].includes(actor.role) || request.userId === actor.id) {
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
  return actor.role === 'MANAGER' &&
    String(actor.department || '').trim().toLowerCase() ===
      String(currentStep.department || '').trim().toLowerCase();
}

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
    if (!approver || !['MANAGER', 'GM', 'DGM'].includes(approver.role)) {
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
      : approver.role === 'MANAGER' &&
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
        include: { approvalSteps: { orderBy: { sequence: 'asc' } } }
      });
    });

    return res.json({ message: 'Request approval updated.', request: updatedRequest });
  } catch (error) {
    if (error.message === 'This request has already been updated. Refresh and try again.') {
      return res.status(409).json({ error: error.message });
    }
    console.error('Request Approval Error:', error);
    return res.status(500).json({ error: 'Unable to update request approval.' });
  }
}

app.patch('/api/requests/:id/approval', requireApprovalAuthentication, handleRequestApproval);

app.patch('/api/requests/:id/status', requireApprovalAuthentication, handleRequestApproval);

app.get('/api/export/requests', requireApprovalAuthentication, async (req, res) => {
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
        user: { select: { id: true, name: true, department: true, role: true } },
        approvalSteps: true
      },
      orderBy: { createdAt: 'desc' }
    });
    let csv = 'ID,Title,Category,Target Dept,Stage,Status,Description,Submitted By,Sender Dept,Role,Date\n';
    requests.filter(request => canUserSeeRequest(request, actor)).forEach(r => {
      const userName = r.user ? r.user.name : 'Unknown';
      const userDept = r.user ? r.user.department : 'N/A';
      const userRole = r.user ? r.user.role : 'N/A';
      const desc = (r.description || '').replace(/"/g, '""');
      csv += `${r.id},"${r.title}","${r.category}","${r.targetDepartment || 'General'}","${r.approvalStage}","${r.status}","${desc}","${userName}","${userDept}","${userRole}","${r.createdAt}"\n`;
    });
    res.header('Content-Type', 'text/csv');
    res.attachment('security_audit_request_report.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;

function start() {
  return app.listen(PORT, '0.0.0.0', async () => {
    try {
      await initializeApprovalChains();
      await initSuperAdmin();
      console.log(`🚀 Server is running on port ${PORT}`);
    } catch (err) {
      console.error("Auto Admin Init Error:", err);
    }
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start, buildApprovalChain, getApprovalTransition, canUserSeeRequest };