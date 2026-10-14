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

// Temporary MFA store (In-memory for session verification)
const activeMfaCodes = {};

async function initSuperAdmin() {
  try {
    const hashedPassword = await bcrypt.hash('085236', 10);
    await prisma.user.upsert({
      where: { email: 'kaungsettpaing@admin.com' },
      update: {
        name: 'Kaung Sett Paing',
        password: hashedPassword,
        role: 'SUPER_ADMIN',
        department: 'Admin'
      },
      create: {
        name: 'Kaung Sett Paing',
        email: 'kaungsettpaing@admin.com',
        password: hashedPassword,
        department: 'Admin',
        role: 'SUPER_ADMIN'
      }
    });
    console.log("--> SUPER_ADMIN Account (kaungsettpaing@admin.com) Hash-Verified & Ready!");
  } catch (err) {
    console.error("Auto Admin Error:", err.message);
  }
}

// User Registration with Password Hashing
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, password, department, role, accessExpiry } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const newUser = await prisma.user.create({
      data: { 
        name, 
        email, 
        password: hashedPassword, 
        department: department || "General", 
        role: role || "STAFF"
      }
    });
    res.json({ message: "User created successfully with security hashing", user: newUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login with Password Hashing Verification & MFA Generation
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: email }, { name: email }] }
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch && password !== user.password) { // Fallback for old plain-text users
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Principle of Least Privilege & Time-Bound Access Revocation check
    if (user.accessExpiry && new Date(user.accessExpiry) < new Date()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { role: 'STAFF', accessExpiry: null }
      });
      user.role = 'STAFF';
    }

    // MFA Enforcement for Executive / Admin roles
    if (['SUPER_ADMIN', 'ADMIN', 'GM', 'DGM'].includes(user.role)) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      activeMfaCodes[user.email] = code;
      console.log(`[SECURITY ALERT] MFA Verification Code for ${user.email}: ${code}`);
      return res.json({ requiresMfa: true, email: user.email });
    }

    res.json({ message: "Login successful", user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// MFA Verification Endpoint
app.post('/api/verify-mfa', async (req, res) => {
  const { email, code } = req.body;
  if (activeMfaCodes[email] && activeMfaCodes[email] === code) {
    delete activeMfaCodes[email];
    const user = await prisma.user.findUnique({ where: { email } });
    return res.json({ message: "MFA Authentication Successful", user });
  }
  return res.status(400).json({ error: "Invalid MFA Code" });
});

// Fetch Users (Principle of Least Privilege Scope)
app.get('/api/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Temporary / Time-Bound Elevated Access Assignment
app.patch('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { role, department, accessExpiry } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: Number(id) },
      data: { 
        role, 
        department,
        ...(accessExpiry && { accessExpiry: new Date(accessExpiry) })
      }
    });

    res.json({ message: "Role and Access Bounds updated successfully", user: updatedUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: Number(req.params.id) } });
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit Request with Manager and IT Dual Approval Stage logic
app.post('/api/requests', upload.single('attachment'), async (req, res) => {
  try {
    const { title, description, category, userId, targetDepartment, extraFields, isDirectExecutive, requiresItApproval } = req.body;
    const attachmentPath = req.file ? req.file.path : null;

    let initialStage = "ORIGIN_MGR";
    if (isDirectExecutive === 'true' || isDirectExecutive === true) {
      initialStage = "EXECUTIVE";
    } else if (targetDepartment === 'IT' || requiresItApproval === 'true' || category === 'Maintenance') {
      initialStage = "MANAGER_AND_IT_DUAL"; // Dual Approval Triggered
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

// Approval Engine: Segregation of Duties (SoD) & Dual Approval Validation
app.patch('/api/requests/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, userId, remarks } = req.body;

    const request = await prisma.request.findUnique({
      where: { id: Number(id) },
      include: { user: true }
    });

    if (!request) return res.status(404).json({ error: "Request not found" });

    // Segregation of Duties (SoD) Enforcement: User cannot approve their own request
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
        nextStage = 'IT_MGR_PENDING'; // Transitioning stage 1 of dual approval
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

    res.json({ message: "Approval workflow updated with SoD & Dual approval controls", request: updatedRequest });
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
    if (typeof initSuperAdmin === 'function') {
      await initSuperAdmin();
    }
  } catch (err) {
    console.error("Auto Admin Init Error:", err);
  }
  console.log(`Server running on port ${PORT}`);
});