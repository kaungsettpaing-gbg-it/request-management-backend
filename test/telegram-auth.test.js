const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { formatRequestNotification, isValidOnboardingProfile, verifyTelegramLogin } = require('../server');

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
  assert.equal(isValidOnboardingProfile('Finance', 'ADMIN'), false);
  assert.equal(isValidOnboardingProfile('Unknown', 'STAFF'), false);
});
