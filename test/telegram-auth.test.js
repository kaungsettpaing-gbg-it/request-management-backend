const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  ADMIN_ASSIGNABLE_ROLES,
  formatRequestNotification,
  formatServerError,
  isValidOnboardingProfile,
  redactSensitiveErrorText,
  SELF_ASSIGNABLE_ROLES,
  splitTelegramMessage,
  verifyTelegramLogin
} = require('../server');

const botToken = 'unit-test-bot-token';
const nowSeconds = 1_800_000_000;

function signTelegramPayload(payload) {
  const checkString = Object.entries(payload)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  return crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
}

function makePayload(overrides = {}) {
  const payload = {
    id: 123456789,
    first_name: 'Test User',
    username: 'test_user',
    auth_date: nowSeconds - 60,
    ...overrides
  };
  return { ...payload, hash: signTelegramPayload(payload) };
}

test('verifies Telegram login signatures and returns the supported identity fields', () => {
  assert.deepEqual(verifyTelegramLogin(makePayload(), botToken, nowSeconds), {
    id: '123456789',
    username: 'test_user',
    firstName: 'Test User'
  });
});

test('rejects altered signatures and stale or future Telegram login payloads', () => {
  const valid = makePayload();
  assert.equal(verifyTelegramLogin({ ...valid, first_name: 'Changed' }, botToken, nowSeconds), null);
  assert.equal(verifyTelegramLogin(makePayload({ auth_date: nowSeconds - 86401 }), botToken, nowSeconds), null);
  assert.equal(verifyTelegramLogin(makePayload({ auth_date: nowSeconds + 31 }), botToken, nowSeconds), null);
});

test('formats request notifications with amount and requester details', () => {
  assert.equal(formatRequestNotification({
    id: 42,
    title: 'Office supplies',
    extraFields: JSON.stringify({ amount: '1250000' }),
    user: { name: 'Aye Aye' }
  }, 'PENDING'), [
    'Request #42',
    'Title: Office supplies',
    'Status: PENDING',
    'Amount: 1,250,000 MMK',
    'Requester: Aye Aye'
  ].join('\n'));
});

test('onboarding only allows recognized departments and non-privileged roles', () => {
  assert.equal(isValidOnboardingProfile('IT', 'STAFF'), true);
  assert.equal(isValidOnboardingProfile('Finance', 'ASSISTANT'), true);
  assert.equal(isValidOnboardingProfile('HR', 'SUPERVISOR'), true);
  assert.equal(isValidOnboardingProfile('IT', 'IT_SPECIALIST'), true);
  assert.equal(isValidOnboardingProfile('Finance', 'ADMIN'), false);
  assert.equal(isValidOnboardingProfile('Unknown', 'STAFF'), false);
  assert.deepEqual(SELF_ASSIGNABLE_ROLES, ['STAFF', 'ASSISTANT', 'SUPERVISOR', 'IT_SPECIALIST']);
  assert.deepEqual(ADMIN_ASSIGNABLE_ROLES, [
    'STAFF', 'ASSISTANT', 'SUPERVISOR', 'IT_SPECIALIST', 'MANAGER', 'DGM', 'GM', 'ADMIN'
  ]);
});

test('server error alerts redact secrets and split messages within Telegram limits', () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = botToken;
  try {
    const safeText = redactSensitiveErrorText(
      `failed ${botToken} postgres://db-user:db-password@host/db`,
      botToken
    );
    assert.equal(safeText.includes(botToken), false);
    assert.equal(safeText.includes('db-password'), false);
    assert.match(formatServerError(new Error('database unavailable')), /\[SERVER ERROR\]/);
  } finally {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }

  const chunks = splitTelegramMessage('a'.repeat(8000));
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(chunk => chunk.length <= 3500));
});
