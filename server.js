require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { getJwtSecret, hasConfiguredJwtSecret } = require('./lib/jwt-secret');
const { connectDatabase } = require('./lib/database');
const { hashPassword, verifyPassword } = require('./lib/user-password');
const User = require('./models/User');
const Request = require('./models/Request');
const AuditLog = require('./models/AuditLog');
const Counter = require('./models/Counter');

const app = express();
const uploadsDirectory = path.join(__dirname, 'uploads');

app.use(express.json({ limit: '1mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDirectory));

if (!fs.existsSync(uploadsDirectory)) {
  fs.mkdirSync(uploadsDirectory, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDirectory),
  filename: (_req, file, callback) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function normalizeUsername(value) {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function publicUser(user) {
  if (!user) return null;
  const doc = typeof user.toObject === 'function' ? user.toObject() : user;
  return {
    id: doc.id,
    name: doc.name,
    role: doc.role,
    department: doc.department,
    createdAt: doc.createdAt
  };
}

function exactCaseInsensitive(value) {
  return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

function isDuplicateKeyError(error) {
  return error && error.code === 11000;
}

function createAccessToken(userId) {
  return jwt.sign({ sub: String(userId) }, getJwtSecret(), { expiresIn: '8h' });
}

async function authenticate(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Authentication is required.' });

  let payload;
  try {
    payload = jwt.verify(match[1], getJwtSecret());
  } catch {
    return res.status(401).json({ error: 'Your session is invalid or expired. Please log in again.' });
  }

  const id = validId(payload.sub);
  if (!id) return res.status(401).json({ error: 'Your session is invalid. Please log in again.' });
  try {
    const user = await User.findOne({ id }).select('id name email department role telegramId');
    if (!user) return res.status(401).json({ error: 'Your account no longer exists.' });
    req.user = user;
    return next();
  } catch (error) {
    console.error('Authentication Error:', error);
    return res.status(500).json({ error: 'Unable to authenticate this request.' });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    return next();
  };
}

function canApproveRequest(user, request, owner) {
  if (request.status !== 'PENDING' || request.userId === user.id) return false;
  if (['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return true;
  if (request.approvalStage === 'MANAGER_AND_IT_DUAL') {
    return user.role === 'MANAGER' && owner?.department === user.department;
  }
  if (request.approvalStage === 'IT_MGR_PENDING') {
    return user.role === 'MANAGER' && user.department === 'IT';
  }
  if (request.approvalStage === 'ORIGIN_MGR') {
    return user.role === 'MANAGER' && owner?.department === user.department;
  }
  if (request.approvalStage === 'TARGET_MGR') {
    return user.role === 'MANAGER' && request.targetDepartment === user.department;
  }
  return request.approvalStage === 'EXECUTIVE' && ['GM', 'DGM'].includes(user.role);
}

async function nextId(collectionName) {
  const counter = await Counter.findByIdAndUpdate(
    collectionName,
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return counter.sequence;
}

async function initializeCounters() {
  const collections = [
    ['users', User],
    ['requests', Request],
    ['auditLogs', AuditLog]
  ];

  for (const [name, Model] of collections) {
    const latest = await Model.findOne().sort({ id: -1 }).select({ id: 1 }).lean();
    await Counter.updateOne(
      { _id: name },
      { $max: { sequence: latest ? latest.id : 0 } },
      { upsert: true }
    );
  }
}

async function initSuperAdmin() {
  const email = (process.env.SUPER_ADMIN_EMAIL || 'superadmin@company.com').trim().toLowerCase();
  const telegramId = normalizeUsername(process.env.SUPER_ADMIN_TELEGRAM_USERNAME || 'okeydokey2') || null;
  const adminIdentity = [{ role: 'SUPER_ADMIN' }, { email }];
  if (telegramId) adminIdentity.push({ telegramId });
  const admin = await User.findOne({ $or: adminIdentity });

  if (admin) {
    if (admin.role !== 'SUPER_ADMIN') {
      admin.role = 'SUPER_ADMIN';
      await admin.save();
    }
    console.log(`Super Admin is configured for ${admin.email}.`);
    return;
  }

  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('SUPER_ADMIN_PASSWORD is required to create the initial administrator.');
  }
  if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('SUPER_ADMIN_PASSWORD must be between 12 and 72 bytes.');
  }

  const id = await nextId('users');
  await User.create({
    id,
    name: 'Super Admin',
    email,
    telegramId,
    password,
    role: 'SUPER_ADMIN',
    department: 'Executive Management'
  });
  console.log(`Initial Super Admin created for ${email}.`);
}

app.post('/api/login', async (req, res) => {
  try {
    const loginKey = req.body?.loginKey ?? req.body?.username ?? req.body?.email;
    const password = req.body?.password;
    if (typeof loginKey !== 'string' || !loginKey.trim() ||
        typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const normalizedLogin = normalizeUsername(loginKey);
    if (!normalizedLogin) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    let user = await User.findOne({
      $or: [{ email: normalizedLogin }, { telegramId: normalizedLogin }]
    }).select('+password');
    if (!user) {
      const nameMatches = await User.find({ name: exactCaseInsensitive(normalizedLogin) })
        .select('+password')
        .limit(2);
      if (nameMatches.length === 1) user = nameMatches[0];
    }

    if (!user || !(await verifyPassword(password, user.password))) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    return res.json({
      requiresMfa: false,
      token: createAccessToken(user.id),
      user: {
        id: user.id,
        name: user.name,
        telegramId: user.telegramId,
        role: user.role,
        department: user.department
      }
    });
  } catch (error) {
    console.error('Login Error:', error);
    return res.status(500).json({ error: 'Unable to complete login.' });
  }
});

app.post('/api/verify-mfa', async (req, res) => {
  try {
    const id = validId(req.body?.userId);
    const code = req.body?.code;
    if (!id || typeof code !== 'string') {
      return res.status(400).json({ error: 'User ID and verification code are required.' });
    }

    const user = await User.findOne({ id }).select('+otp +otpExpiry');
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (!user.otp || user.otp !== code || !user.otpExpiry || user.otpExpiry < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired OTP code.' });
    }

    user.otp = null;
    user.otpExpiry = null;
    await user.save();
    return res.json({
      message: 'Authentication successful',
      token: createAccessToken(user.id),
      user: publicUser(user)
    });
  } catch (error) {
    console.error('MFA Verification Error:', error);
    return res.status(500).json({ error: 'Unable to verify the code.' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password, department, telegramId } = req.body || {};
    if (typeof name !== 'string' || !name.trim() ||
        typeof email !== 'string' || !email.trim() ||
        typeof password !== 'string' || !password.length) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (Buffer.byteLength(password, 'utf8') < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Password must be between 8 and 72 bytes.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const existingUser = await User.exists({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    const hashedPassword = await hashPassword(password);
    const user = await User.create({
      id: await nextId('users'),
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      department: typeof department === 'string' && department.trim() ? department.trim() : 'General',
      telegramId: typeof telegramId === 'string' && telegramId.trim()
        ? (normalizeUsername(telegramId) || null)
        : null,
      role: 'STAFF'
    });

    return res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        department: user.department,
        role: user.role
      }
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: 'A user with this email or Telegram username already exists.' });
    }
    if (error.name === 'ValidationError' || error instanceof RangeError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Create User Error:', error);
    return res.status(500).json({ error: 'Unable to register user.' });
  }
});

app.get('/api/users', authenticate, requireRoles('ADMIN', 'SUPER_ADMIN'), async (_req, res) => {
  try {
    const users = await User.find({ role: { $ne: 'SUPER_ADMIN' } })
      .select('id name email telegramId department role createdAt -_id')
      .sort({ id: -1 })
      .lean();
    return res.json(users);
  } catch (error) {
    console.error('Get Users Error:', error);
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

app.patch('/api/users/:id', authenticate, requireRoles('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid user ID.' });

    const { role, department, telegramId } = req.body || {};
    if (role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Super Admin role is reserved.' });
    }

    const updates = {};
    if (typeof role === 'string' && role.trim()) updates.role = role.trim();
    if (typeof department === 'string' && department.trim()) updates.department = department.trim();
    if (typeof telegramId === 'string') {
      updates.telegramId = telegramId.trim() ? (normalizeUsername(telegramId) || null) : null;
    }
    const user = await User.findOneAndUpdate({ id }, updates, { new: true, runValidators: true })
      .select('id name email telegramId department role createdAt');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({ message: 'User updated successfully', user });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: 'A user with this Telegram username already exists.' });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Update User Error:', error);
    return res.status(500).json({ error: 'Unable to update user.' });
  }
});

app.delete('/api/users/:id', authenticate, requireRoles('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid user ID.' });
    if (id === req.user.id) {
      return res.status(409).json({ error: 'You cannot delete your own account.' });
    }
    const user = await User.findOne({ id }).select('id role');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'The Super Admin account cannot be deleted here.' });
    }
    const [requestCount, auditCount] = await Promise.all([
      Request.countDocuments({ userId: id }),
      AuditLog.countDocuments({ userId: id })
    ]);
    if (requestCount || auditCount) {
      return res.status(409).json({ error: 'Cannot delete a user with request or audit history.' });
    }
    await User.deleteOne({ id });
    return res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete User Error:', error);
    return res.status(500).json({ error: 'Unable to delete user.' });
  }
});

app.post('/api/requests', authenticate, upload.single('attachment'), async (req, res) => {
  try {
    const { title, description, category, targetDepartment, extraFields, isDirectExecutive, requiresItApproval } = req.body || {};
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Request title is required.' });
    }
    if (extraFields) {
      try {
        JSON.parse(extraFields);
      } catch {
        return res.status(400).json({ error: 'Request details must be valid JSON.' });
      }
    }

    let approvalStage = 'ORIGIN_MGR';
    if (isDirectExecutive === 'true' || isDirectExecutive === true) {
      approvalStage = 'EXECUTIVE';
    } else if (targetDepartment === 'IT' || requiresItApproval === 'true' ||
               requiresItApproval === true || category === 'Maintenance') {
      approvalStage = 'MANAGER_AND_IT_DUAL';
    }

    const request = await Request.create({
      id: await nextId('requests'),
      title: title.trim(),
      description: typeof description === 'string' ? description : null,
      category: typeof category === 'string' && category.trim() ? category.trim() : 'General',
      targetDepartment: req.user.role === 'STAFF'
        ? (req.user.department || 'General')
        : (typeof targetDepartment === 'string' && targetDepartment.trim()
          ? targetDepartment.trim()
          : 'General'),
      approvalStage,
      userId: req.user.id,
      attachment: req.file ? path.join('uploads', req.file.filename) : null,
      extraFields: typeof extraFields === 'string' && extraFields ? extraFields : null
    });
    return res.status(201).json(request);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: error.message });
    }
    console.error('Create Request Error:', error);
    return res.status(500).json({ error: 'Unable to submit request.' });
  }
});

app.get('/api/requests', authenticate, async (req, res) => {
  try {
    const [requests, users, logs] = await Promise.all([
      Request.find().select('-_id').sort({ createdAt: -1 }).lean(),
      User.find().select('id name department role createdAt -_id').lean(),
      AuditLog.find().select('-_id').sort({ createdAt: -1 }).lean()
    ]);
    const usersById = new Map(users.map(user => [user.id, user]));
    const logsByRequest = new Map();
    for (const log of logs) {
      const requestLogs = logsByRequest.get(log.requestId) || [];
      requestLogs.push({ ...log, user: usersById.get(log.userId) || null });
      logsByRequest.set(log.requestId, requestLogs);
    }

    const visibleRequests = requests.filter(request => {
      const owner = usersById.get(request.userId);
      if (['ADMIN', 'SUPER_ADMIN', 'GM', 'DGM', 'HR'].includes(req.user.role)) return true;
      if (req.user.role === 'STAFF') return request.userId === req.user.id;
      if (['MANAGER', 'ASSISTANT'].includes(req.user.role)) {
        if (request.approvalStage === 'ORIGIN_MGR' || request.approvalStage === 'MANAGER_AND_IT_DUAL') {
          return owner?.department === req.user.department || request.userId === req.user.id;
        }
        if (request.approvalStage === 'IT_MGR_PENDING') {
          return req.user.department === 'IT' || owner?.department === req.user.department;
        }
        if (request.approvalStage === 'TARGET_MGR') {
          return request.targetDepartment === req.user.department || owner?.department === req.user.department;
        }
      }
      return true;
    });
    return res.json(visibleRequests.map(request => ({
      ...request,
      user: usersById.get(request.userId) || null,
      auditLogs: logsByRequest.get(request.id) || []
    })));
  } catch (error) {
    console.error('Get Requests Error:', error);
    return res.status(500).json({ error: 'Unable to fetch requests.' });
  }
});

app.patch('/api/requests/:id/status', authenticate, async (req, res) => {
  try {
    const id = validId(req.params.id);
    const { status, remarks } = req.body || {};
    if (!id || !['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ error: 'Valid request ID and status are required.' });
    }

    const request = await Request.findOne({ id });
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    if (request.userId === req.user.id) {
      return res.status(403).json({ error: 'SoD Restriction: You cannot approve/reject your own request.' });
    }
    const owner = await User.findOne({ id: request.userId }).select('id department').lean();
    if (!canApproveRequest(req.user, request, owner)) {
      return res.status(403).json({ error: 'You are not authorized to approve this request.' });
    }

    let nextStage = request.approvalStage;
    let finalStatus = request.status;
    if (status === 'REJECTED') {
      finalStatus = 'REJECTED';
      nextStage = 'REJECTED';
    } else if (request.approvalStage === 'MANAGER_AND_IT_DUAL') {
      nextStage = 'IT_MGR_PENDING';
    } else if (request.approvalStage === 'IT_MGR_PENDING') {
      nextStage = 'COMPLETED';
      finalStatus = 'APPROVED';
    } else if (request.approvalStage === 'ORIGIN_MGR') {
      if (request.targetDepartment && owner && request.targetDepartment !== owner.department) {
        nextStage = 'TARGET_MGR';
      } else {
        nextStage = 'COMPLETED';
        finalStatus = 'APPROVED';
      }
    } else if (request.approvalStage === 'TARGET_MGR' || request.approvalStage === 'EXECUTIVE') {
      nextStage = 'COMPLETED';
      finalStatus = 'APPROVED';
    }

    const updatedRequest = await Request.findOneAndUpdate(
      { id, status: 'PENDING', approvalStage: request.approvalStage },
      { $set: { status: finalStatus, approvalStage: nextStage, updatedAt: new Date() } },
      { new: true, runValidators: true }
    );
    if (!updatedRequest) {
      return res.status(409).json({ error: 'This request was updated by someone else. Refresh and try again.' });
    }

    await AuditLog.create({
      id: await nextId('auditLogs'),
      action: status,
      remarks: typeof remarks === 'string' && remarks.trim()
        ? remarks.trim()
        : `Status changed to ${status} (Stage: ${nextStage})`,
      userId: req.user.id,
      requestId: id
    });
    return res.json({ message: 'Approval status updated', request: updatedRequest });
  } catch (error) {
    console.error('Update Request Status Error:', error);
    return res.status(500).json({ error: 'Unable to update request status.' });
  }
});

app.get(
  '/api/export/requests',
  authenticate,
  requireRoles('ADMIN', 'SUPER_ADMIN', 'GM', 'DGM', 'MANAGER', 'HR'),
  async (_req, res) => {
  try {
    const [requests, users] = await Promise.all([
      Request.find().select('-_id').sort({ createdAt: -1 }).lean(),
      User.find().select('id name department role -_id').lean()
    ]);
    const usersById = new Map(users.map(user => [user.id, user]));
    const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = [[
      'ID', 'Title', 'Category', 'Target Dept', 'Stage', 'Status',
      'Description', 'Submitted By', 'Sender Dept', 'Role', 'Date'
    ]];
    for (const request of requests) {
      const user = usersById.get(request.userId);
      rows.push([
        request.id,
        request.title,
        request.category,
        request.targetDepartment || 'General',
        request.approvalStage,
        request.status,
        request.description,
        user ? user.name : 'Unknown',
        user ? user.department : 'N/A',
        user ? user.role : 'N/A',
        request.createdAt
      ]);
    }
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment('security_audit_request_report.csv');
    return res.send(csv);
  } catch (error) {
    console.error('Export Requests Error:', error);
    return res.status(500).json({ error: 'Unable to export requests.' });
  }
  }
);

async function start() {
  if (!hasConfiguredJwtSecret()) {
    console.warn('JWT_SECRET is not configured. A temporary random secret will be used; all login sessions will expire when this server restarts. Configure a persistent JWT_SECRET for production.');
  }
  getJwtSecret();
  await connectDatabase(process.env.MONGODB_URI);
  try {
    await Promise.all([User.init(), Request.init(), AuditLog.init()]);
    await initializeCounters();
    await initSuperAdmin();
  } catch (error) {
    await mongoose.disconnect();
    throw error;
  }

  const port = Number(process.env.PORT) || 5000;
  return app.listen(port, '0.0.0.0', () => {
    console.log(`Request management server is running on port ${port}.`);
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error('Server startup failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  start,
  initSuperAdmin,
  initializeCounters,
  nextId,
  authenticate,
  requireRoles,
  canApproveRequest
};
