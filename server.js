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
        text: `🔐 *Security Verification*\n\nYour 2FA / Reset Code is: \`${otpCode}\`\nThis code expires in 5 minutes.`,
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
    const cleanUsername = username.replace('@', '').trim().toLowerCase();
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
    const hashedPassword = await bcrypt.hash('085236', 10);
    const adminData = {
      name: 'Kaung Sett Paing',
      email: 'kaungsettpaing@admin.com',
      password: hashedPassword,
      department: 'Admin',
      role: 'SUPER_ADMIN',
      telegramId: SUPER_ADMIN_TELE_USERNAME
    };

    await prisma.user.upsert({
      where: { email: 'kaungsettpaing@admin.com' },
      update: adminData,
      create: adminData
    });

    console.log(`--> SUPER_ADMIN Ready! Telegram Username: @${SUPER_ADMIN_TELE_USERNAME}`);
  } catch (err) {
    console.error("Auto Admin Init Error:", err.message);
  }
}

// User Registration via Telegram Username
app.post('/api/users', async (req, res) => {
  try {
    const { name, password, department, role, telegramUsername } = req.body;
    
    if (!telegramUsername) {
      return res.status(400).json({ error: "Telegram Username is required." });
    }

    const cleanTelegram = telegramUsername.replace('@', '').trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: { 
        name, 
        email: `${cleanTelegram}@telegram.local`,
        password: hashedPassword, 
        department: department || "General", 
        role: role || "STAFF",
        telegramId: cleanTelegram
      }
    });

    res.json({ message: "User registered successfully", user: newUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login via Telegram Username or Name
app.post('/api/login', async (req, res) => {
  try {
    const { loginKey, password } = req.body;
    if (!loginKey || !password) {
      return res.status(400).json({ error: "Please provide login key and password." });
    }

    const cleanKey = loginKey.replace('@', '').trim().toLowerCase();

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { telegramId: { equals: cleanKey, mode: 'insensitive' } },
          { name: { equals: cleanKey, mode: 'insensitive' } },
          { email: { equals: cleanKey, mode: 'insensitive' } }
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

    // Attempt Telegram OTP Sending for Security Verification
    let chatId = await getChatIdFromUsername(user.telegramId);

    if (chatId) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiry = new Date(Date.now() + 5 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: { otp: code, otpExpiry: expiry }
      });

      const sent = await sendTelegramOTP(chatId, code);
      if (sent) {
        return res.json({ requiresMfa: true, userId: user.id, message: `OTP sent to Telegram @${user.telegramId}` });
      }
    }

    // Fallback direct login if Telegram chat ID is not cached yet
    res.json({ message: "Login successful", user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify Telegram OTP (Login 2FA)
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

// Forgot Password - Request OTP via Telegram Username
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { telegramUsername } = req.body;
    if (!telegramUsername) return res.status(400).json({ error: "Telegram username is required." });

    const cleanUser = telegramUsername.replace('@', '').trim().toLowerCase();
    const user = await prisma.user.findFirst({ where: { telegramId: cleanUser } });

    if (!user) {
      return res.status(404).json({ error: "User with this Telegram username not found." });
    }

    let chatId = await getChatIdFromUsername(user.telegramId);
    if (!chatId) {
      return res.status(400).json({ error: "Telegram Chat ID not found. Please message the bot (/start) first." });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 5 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { otp: code, otpExpiry: expiry }
    });

    const sent = await sendTelegramOTP(chatId, code);
    if (!sent) return res.status(500).json({ error: "Failed to send reset code via Telegram." });

    res.json({ message: "Password reset OTP sent to Telegram successfully.", userId: user.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset Password with OTP
app.post('/api/reset-password', async (req, res) => {
  try {
    const { userId, code, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });

    if (!user || !user.otp || user.otp !== code || (user.otpExpiry && new Date() > new Date(user.otpExpiry))) {
      return res.status(400).json({ error: "Invalid or expired reset code." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword, otp: null, otpExpiry: null }
    });

    res.json({ message: "Password updated successfully! You can now log in." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
        ...(telegramId && { telegramId: telegramId.replace('@', '').trim().toLowerCase() }),
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

// Requests API
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

    await prisma.auditLog.create({
      data: {
        action: 'SUBMITTED',
        remarks: `Request created under Stage: ${initialStage}`,
        userId: Number(userId),
        requestId: newRequest.id
      }
    });

    res.json({ message: "Request created successfully", request: newRequest });
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
  try {
    await initSuperAdmin();
  } catch (err) {
    console.error("Auto Admin Init Error:", err);
  }
  console.log(`Server running on port ${PORT}`);
});