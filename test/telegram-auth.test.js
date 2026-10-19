const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  ADMIN_ASSIGNABLE_ROLES,
  createTelegramDeepLink,
  createTelegramLinkToken,
  deriveTelegramWebhookSecret,
  escapeCsvCell,
  formatRequestNotification,
  formatRequestStatusHeader,
  formatRequestStatusLabel,
  formatTelegramField,
  formatServerError,
  getAttachmentContentDisposition,
  isAllowedAttachment,
  isValidOnboardingProfile,
  parseTelegramStartPayload,
  redactSensitiveErrorText,
  resolveTelegramWebhookUrl,
  safeAttachmentFileName,
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

test('creates short opaque Telegram deep-link tokens and accepts only valid start payloads', () => {
  const first = createTelegramLinkToken();
  const second = createTelegramLinkToken();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.tokenHash, second.tokenHash);
  assert.equal(
    createTelegramDeepLink(first.token, 'Telegbg_Bot'),
    `https://t.me/Telegbg_Bot?start=${first.token}`
  );
  assert.throws(() => createTelegramDeepLink(first.token, 'invalid username'));
  assert.equal(parseTelegramStartPayload(`/start ${first.token}`), first.token);
  assert.equal(parseTelegramStartPayload(`/start@Telegbg_Bot ${first.token}`), first.token);
  assert.equal(parseTelegramStartPayload('/start'), null);
  assert.equal(parseTelegramStartPayload('/start user_42'), null);
  assert.equal(parseTelegramStartPayload(`/start ${first.token} extra`), null);
});

test('derives stable webhook configuration from Railway domain and JWT secret', () => {
  assert.equal(
    resolveTelegramWebhookUrl('', 'request-app.up.railway.app'),
    'https://request-app.up.railway.app/api/telegram/webhook'
  );
  assert.equal(
    resolveTelegramWebhookUrl('https://custom.example/api/telegram/webhook', 'ignored.up.railway.app'),
    'https://custom.example/api/telegram/webhook'
  );
  assert.equal(resolveTelegramWebhookUrl('', 'not a domain/path'), null);
  assert.equal(resolveTelegramWebhookUrl('', ''), null);

  const secret = deriveTelegramWebhookSecret('stable-jwt-secret');
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(deriveTelegramWebhookSecret('stable-jwt-secret'), secret);
  assert.notEqual(deriveTelegramWebhookSecret('different-jwt-secret'), secret);
  assert.equal(deriveTelegramWebhookSecret(''), null);
});

test('formats request notifications with dynamic status headers and request details', () => {
  const timestampBefore = Date.now();
  const message = formatRequestNotification({
    id: 42,
    title: 'Office supplies',
    extraFields: JSON.stringify({ amount: '1250000' }),
    user: { name: 'Aye Aye', department: 'Finance' }
  }, 'APPROVED');
  assert.deepEqual(message.split('\n').slice(0, 7), [
    '[✅ REQUEST APPROVED]',
    'Request ID: 42',
    'Title: Office supplies',
    'Status: ✅ APPROVED',
    'Requester: Aye Aye',
    'Department: Finance',
    'Amount: 1,250,000 MMK'
  ]);
  assert.match(message.split('\n')[7], /^Timestamp: \d{4}-\d\d-\d\dT/);
  assert.ok(Date.now() >= timestampBefore);
  assert.equal(formatRequestStatusHeader('APPROVED'), '[✅ REQUEST APPROVED]');
  assert.equal(formatRequestStatusHeader('REJECTED'), '[❌ REQUEST REJECTED]');
  assert.equal(formatRequestStatusHeader('PENDING'), '[⏳ REQUEST PENDING]');
  assert.equal(formatRequestStatusLabel('APPROVED'), '✅ APPROVED');
  assert.equal(formatRequestStatusLabel('REJECTED'), '❌ REJECTED');
  assert.equal(formatRequestStatusLabel('PENDING'), '⏳ PENDING');
});

test('keeps Telegram notification fields single-line and bounded', () => {
  assert.equal(formatTelegramField('Name\nStatus: APPROVED', 100), 'Name Status: APPROVED');
  assert.equal(formatTelegramField('x'.repeat(10), 4), 'xxxx');
  assert.equal(formatTelegramField('', 10), 'Not specified');
  assert.deepEqual(formatRequestNotification({
    id: 42,
    title: 'Office supplies\nStatus: APPROVED',
    extraFields: JSON.stringify({ amount: '1250000' }),
    user: { name: 'Aye Aye\nRequester: Fake User', department: 'Finance' }
  }, 'PENDING').split('\n').slice(0, 7), [
    '[⏳ REQUEST PENDING]',
    'Request ID: 42',
    'Title: Office supplies Status: APPROVED',
    'Status: ⏳ PENDING',
    'Requester: Aye Aye Requester: Fake User',
    'Department: Finance',
    'Amount: 1,250,000 MMK'
  ]);
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

test('attachment validation enforces matching supported MIME types and safe download names', () => {
  assert.equal(isAllowedAttachment({
    mimetype: 'image/jpeg',
    originalname: 'receipt.jpg',
    buffer: Buffer.from([0xff, 0xd8, 0xff])
  }), true);
  assert.equal(isAllowedAttachment({
    mimetype: 'application/pdf',
    originalname: 'receipt.exe',
    buffer: Buffer.from('%PDF-1.7')
  }), false);
  assert.equal(isAllowedAttachment({
    mimetype: 'image/gif',
    originalname: 'receipt.gif',
    buffer: Buffer.from('GIF89a')
  }), false);
  assert.equal(isAllowedAttachment({
    mimetype: 'application/pdf',
    originalname: 'receipt.pdf',
    buffer: Buffer.from('not a PDF')
  }), false);
  assert.equal(isAllowedAttachment({
    mimetype: 'application/pdf',
    originalname: 'receipt.pdf',
    buffer: Buffer.from('%PDF-1.7')
  }), true);
  assert.equal(safeAttachmentFileName('../report.pdf'), 'report.pdf');
  assert.equal(safeAttachmentFileName('..\\report.pdf'), 'report.pdf');
  const disposition = getAttachmentContentDisposition('စာရွက်စာတမ်း.pdf');
  assert.match(disposition, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
  assert.equal(disposition.includes('\n'), false);
});

test('CSV export escapes spreadsheet formulas and quotes values correctly', () => {
  assert.equal(escapeCsvCell('A "quoted" title'), '"A ""quoted"" title"');
  assert.equal(escapeCsvCell('=HYPERLINK("https://example.invalid")'), '"\'=HYPERLINK(""https://example.invalid"")"');
  assert.equal(escapeCsvCell('ordinary text'), '"ordinary text"');
});
