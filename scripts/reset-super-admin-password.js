require('dotenv').config();

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function resetSuperAdminPassword() {
  const email = (process.env.SUPER_ADMIN_EMAIL || 'superadmin@company.com')
    .trim()
    .toLowerCase();
  const confirmation = (process.env.SUPER_ADMIN_RESET_CONFIRM_EMAIL || '')
    .trim()
    .toLowerCase();
  const password = process.env.SUPER_ADMIN_RESET_PASSWORD;

  if (!confirmation || confirmation !== email) {
    throw new Error('Set SUPER_ADMIN_RESET_CONFIRM_EMAIL to the exact Super Admin email.');
  }
  if (!password || password.length < 12) {
    throw new Error('SUPER_ADMIN_RESET_PASSWORD must contain at least 12 characters.');
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true }
  });
  if (!user || user.role !== 'SUPER_ADMIN') {
    throw new Error('The configured account is not currently a Super Admin. Deploy the role-restoration code and retry.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: { password: passwordHash }
  });
  console.log(`Password reset successfully for ${email}. Unset the reset variables now.`);
}

resetSuperAdminPassword()
  .catch(error => {
    console.error('Super Admin password reset failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
