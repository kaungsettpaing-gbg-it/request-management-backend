const assert = require('node:assert/strict');
const test = require('node:test');
const {
  formatMonthlyReportMessage,
  getUtcMonthPeriod,
  summarizeRequests
} = require('../lib/monthly-report');

test('monthly periods use UTC calendar-month boundaries, including year rollover', () => {
  const period = getUtcMonthPeriod(new Date('2026-01-01T00:00:00.000Z'), -1);

  assert.equal(period.monthKey, '2025-12');
  assert.equal(period.start.toISOString(), '2025-12-01T00:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('monthly report summaries count all three request statuses', () => {
  assert.deepEqual(summarizeRequests([
    { status: 'PENDING' },
    { status: 'APPROVED' },
    { status: 'REJECTED' },
    { status: 'PENDING' },
    { status: 'CANCELLED' }
  ]), {
    totalRequests: 4,
    pendingCount: 2,
    approvedCount: 1,
    rejectedCount: 1
  });
  assert.deepEqual(summarizeRequests([]), {
    totalRequests: 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0
  });
});

test('monthly Telegram summary formats status counts with icons', () => {
  assert.equal(formatMonthlyReportMessage({
    monthKey: '2026-09',
    totalRequests: 12,
    approvedCount: 7,
    rejectedCount: 2,
    pendingCount: 3
  }), [
    '📊 Monthly Request Report — 2026-09',
    'Total requests: 12',
    '✅ Approved: 7',
    '❌ Rejected: 2',
    '⏳ Pending: 3'
  ].join('\n'));
});
