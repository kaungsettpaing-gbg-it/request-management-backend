const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

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
const TELEGRAM_BOT_TOKEN = '8535213758:AAE9IiL25d7RxcYEv4MmFwRi2LX3ZS8cREw';
const SUPER_ADMIN_TELE_USERNAME = 'okeydokey2';

// Send Telegram Message
async function sendTelegramOTP(chatId, otpCode) {
  try {
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
        const hashedPassword = await bcrypt.hash('admin123', 10);

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
            await prisma.user.update({
                where: { id: adminExists.id },
                data: {
                    name: 'Super Admin',
                    email: superAdminEmail,
                    telegramId: superAdminTelegram,
                    password: hashedPassword,
                    role: 'SUPER_ADMIN',
                    department: 'Executive Management'
                }
            });
            console.log('✅ Super Admin restored successfully! Username: okeydokey2 | Email: superadmin@company.com | Password: admin123');
            return;
        }

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
        console.log('✅ Default Super Admin created successfully! Username: okeydokey2 | Email: superadmin@company.com | Password: admin123');
    } catch (err) {
        console.error('Error initializing Super Admin:', err);
    }
}

// Login Endpoint (Fixed Prisma mode error)
app.post('/api/login', async (req, res) => {
  try {
    const loginKey = req.body.loginKey || req.body.username || req.body.email || '';
    const password = req.body.password;

    if (!loginKey || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    const cleanKey = String(loginKey).replace(/^@+/, '').trim().toLowerCase();

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanKey },
          { telegramId: cleanKey },
          { name: cleanKey }
        ]
      }
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials. User not found." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch && password !== user.password) {
      return res.status(401).json({ error: "Invalid credentials. Wrong password." });
    }

    // Access Expiry Check
    if (user.accessExpiry && new Date(user.accessExpiry) < new Date()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { role: 'STAFF', accessExpiry: null }
      });
      user.role = 'STAFF';
    }

    res.json({
      requiresMfa: false,
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
    const { name, email, password, department, role, telegramId } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (existingUser) {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: {
        name: String(name).trim(),
        email: normalizedEmail,
        password: hashedPassword,
        department: department || 'General',
        role: role || 'STAFF',
        telegramId: telegramId ? String(telegramId).replace(/^@+/, '').trim().toLowerCase() : null
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
            select: {
                id: true,
                name: true,
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
    const { role, department, accessExpiry, telegramId } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: Number(id) },
      data: { 
        role, 
        department,
        ...(telegramId && { telegramId: String(telegramId).replace(/^@+/, '').trim().toLowerCase() }),
        ...(accessExpiry && { accessExpiry: new Date(accessExpiry) })
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
    await prisma.user.delete({ where: { id: Number(req.params.id) } });
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create Request API
app.post('/api/requests', upload.single('attachment'), async (req, res) => {
  try {
    const { title, description, category, userId, targetDepartment, extraFields, isDirectExecutive, requiresItApproval } = req.body;
    const attachmentPath = req.file ? req.file.path : null;

    let initialStage = "ORIGIN_MGR";
    if (isDirectExecutive === 'true' || isDirectExecutive === true) {
      initialStage = "EXECUTIVE";
    } else if (targetDepartment === 'IT' || requiresItApproval === 'true' || category === 'Maintenance') {
      initialStage = "MANAGER_AND_IT_DUAL";
    }

    const newRequest = await prisma.request.create({
      data: { 
        title, 
        description, 
        category: category || "General", 
        targetDepartment: targetDepartment || "General",
        approvalStage: initialStage,
        userId: Number(userId),
        attachment: attachmentPath,
        extraFields: extraFields || null
      }
    });
    res.json(newRequest);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/requests', async (req, res) => {
  try {
    const requests = await prisma.request.findMany({ 
      include: { 
        user: true,
        auditLogs: { include: { user: true }, orderBy: { createdAt: 'desc' } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/requests/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, userId, remarks } = req.body;

    const request = await prisma.request.findUnique({
      where: { id: Number(id) },
      include: { user: true }
    });

    if (!request) return res.status(404).json({ error: "Request not found" });

    if (request.userId === Number(userId)) {
      return res.status(403).json({ error: "SoD Restriction: You cannot approve/reject your own request." });
    }

    let nextStage = request.approvalStage;
    let finalStatus = request.status;

    if (status === 'REJECTED') {
      finalStatus = 'REJECTED';
      nextStage = 'REJECTED';
    } else if (status === 'APPROVED') {
      if (request.approvalStage === 'MANAGER_AND_IT_DUAL') {
        nextStage = 'IT_MGR_PENDING';
      } else if (request.approvalStage === 'IT_MGR_PENDING') {
        nextStage = 'COMPLETED';
        finalStatus = 'APPROVED';
      } else if (request.approvalStage === 'ORIGIN_MGR') {
        if (request.targetDepartment && request.targetDepartment !== request.user.department) {
          nextStage = 'TARGET_MGR';
        } else {
          nextStage = 'COMPLETED';
          finalStatus = 'APPROVED';
        }
      } else if (request.approvalStage === 'TARGET_MGR' || request.approvalStage === 'EXECUTIVE') {
        nextStage = 'COMPLETED';
        finalStatus = 'APPROVED';
      }
    }

    const updatedRequest = await prisma.request.update({
      where: { id: Number(id) },
      data: { status: finalStatus, approvalStage: nextStage }
    });

    if (userId) {
      await prisma.auditLog.create({
        data: {
          action: status,
          remarks: remarks || `Status changed to ${status} (Stage: ${nextStage})`,
          userId: Number(userId),
          requestId: Number(id)
        }
      });
    }

    res.json({ message: "Approval status updated", request: updatedRequest });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/export/requests', async (req, res) => {
  try {
    const requests = await prisma.request.findMany({ include: { user: true }, orderBy: { createdAt: 'desc' } });
    let csv = 'ID,Title,Category,Target Dept,Stage,Status,Description,Submitted By,Sender Dept,Role,Date\n';
    requests.forEach(r => {
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
app.listen(PORT, '0.0.0.0', async () => {
  try {
    await initSuperAdmin();
    console.log(`🚀 Server is running on port ${PORT}`);
  } catch (err) {
    console.error("Auto Admin Init Error:", err);
  }
});