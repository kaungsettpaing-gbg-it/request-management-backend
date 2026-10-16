const assert = require('node:assert/strict');
const test = require('node:test');
const User = require('../models/User');
const { hashPassword, verifyPassword } = require('../lib/user-password');

test('password hashing stores a bcrypt digest and verifies the original password', async () => {
  const password = 'correct horse battery staple';
  const digest = await hashPassword(password);

  assert.notEqual(digest, password);
  assert.match(digest, /^\$2[aby]\$12\$/);
  assert.equal(await verifyPassword(password, digest), true);
  assert.equal(await verifyPassword('wrong password', digest), false);
});

test('password hashing rejects passwords beyond bcrypt byte limits', async () => {
  await assert.rejects(hashPassword('x'.repeat(73)), {
    name: 'RangeError',
    message: 'Password must be no more than 72 bytes.'
  });
});

test('user JSON omits password and MFA secrets', () => {
  const user = new User({
    id: 1,
    name: 'Test User',
    email: 'test@example.com',
    password: 'secret',
    otp: '123456',
    otpExpiry: new Date(),
    role: 'STAFF'
  });

  const serialized = user.toJSON();
  assert.equal(serialized.role, 'STAFF');
  assert.equal('password' in serialized, false);
  assert.equal('otp' in serialized, false);
  assert.equal('otpExpiry' in serialized, false);
  assert.equal('_id' in serialized, false);
});
