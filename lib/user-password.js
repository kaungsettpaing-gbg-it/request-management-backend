const bcrypt = require('bcryptjs');

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$/;

async function hashPassword(password) {
  if (typeof password !== 'string' || !password.length) {
    throw new TypeError('Password must be a non-empty string.');
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw new RangeError('Password must be no more than 72 bytes.');
  }

  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hashedPassword) {
  if (typeof password !== 'string' || typeof hashedPassword !== 'string' ||
      !BCRYPT_HASH_PATTERN.test(hashedPassword)) {
    return false;
  }
  return bcrypt.compare(password, hashedPassword);
}

module.exports = { hashPassword, verifyPassword, BCRYPT_HASH_PATTERN };
