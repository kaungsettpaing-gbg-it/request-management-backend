const assert = require('node:assert/strict');
const test = require('node:test');
const { authenticate, canApproveRequest, requireRoles } = require('../server');
const { connectDatabase } = require('../lib/database');
const { getJwtSecret, hasConfiguredJwtSecret } = require('../lib/jwt-secret');

function responseMock() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('protected routes reject requests without a bearer token', async () => {
  const response = responseMock();
  let continued = false;
  await authenticate({ get: () => '' }, response, () => { continued = true; });

  assert.equal(response.statusCode, 401);
  assert.equal(continued, false);
});

test('database connection refuses to start without a MongoDB URI', async () => {
  await assert.rejects(connectDatabase(undefined), {
    message: 'MONGODB_URI is required to connect to the application database.'
  });
});

test('JWT secret generates a cryptographically strong fallback when missing', () => {
  const env = {};
  const secret = getJwtSecret(env);

  assert.equal(Buffer.byteLength(secret, 'utf8') >= 32, true);
  assert.equal(getJwtSecret(env), secret);
  assert.equal(hasConfiguredJwtSecret(env), false);
});

test('JWT secret rejects explicitly configured values shorter than 32 bytes', () => {
  assert.throws(
    () => getJwtSecret({ JWT_SECRET: 'too-short' }),
    /JWT_SECRET must be at least 32 bytes/
  );
});

test('protected routes reject malformed bearer tokens', async () => {
  const response = responseMock();
  let continued = false;
  await authenticate({ get: () => 'Bearer invalid-token' }, response, () => { continued = true; });

  assert.equal(response.statusCode, 401);
  assert.equal(continued, false);
});

test('role middleware denies users outside the allowed roles', () => {
  const response = responseMock();
  let continued = false;
  requireRoles('ADMIN')({ user: { role: 'STAFF' } }, response, () => { continued = true; });

  assert.equal(response.statusCode, 403);
  assert.equal(continued, false);
});

test('approval checks enforce workflow role, department, and separation of duties', () => {
  const manager = { id: 2, role: 'MANAGER', department: 'Finance' };
  const request = { id: 1, userId: 1, status: 'PENDING', approvalStage: 'ORIGIN_MGR' };

  assert.equal(canApproveRequest(manager, request, { department: 'Finance' }), true);
  assert.equal(canApproveRequest(manager, request, { department: 'HR' }), false);
  assert.equal(canApproveRequest({ ...manager, id: 1 }, request, { department: 'Finance' }), false);
  assert.equal(canApproveRequest({ ...manager, role: 'STAFF' }, request, { department: 'Finance' }), false);
  assert.equal(
    canApproveRequest(
      manager,
      { ...request, approvalStage: 'TARGET_MGR', targetDepartment: 'Finance' },
      { department: 'HR' }
    ),
    true
  );
});
