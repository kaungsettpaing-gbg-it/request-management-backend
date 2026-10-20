const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createMonthlyReportPdf,
  formatMonthlyReportMessages,
  getMonthlyAnalytics,
  getMonthlyRequestDetails,
  getUtcMonthPeriod,
  getUtcMonthPeriodFromKey,
  summarizeRequests
} = require('../lib/monthly-report');
const { createMonthlyReportCsv } = require('../server');

test('monthly periods use UTC calendar-month boundaries, including year rollover', () => {
  const period = getUtcMonthPeriod(new Date('2026-01-01T00:00:00.000Z'), -1);

  assert.equal(period.monthKey, '2025-12');
  assert.equal(period.start.toISOString(), '2025-12-01T00:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('selected report months validate and use UTC calendar boundaries', () => {
  const period = getUtcMonthPeriodFromKey('2026-02');
  assert.equal(period.start.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.throws(() => getUtcMonthPeriodFromKey('2026-13'), /YYYY-MM/);
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

test('monthly analytics totals approved spend and ranks departments', () => {
  assert.deepEqual(getMonthlyAnalytics([
    { status: 'APPROVED', extraFields: JSON.stringify({ amount: '2500' }), user: { department: 'IT' } },
    { status: 'APPROVED', extraFields: { amount: '7500' }, user: { department: 'Finance' } },
    { status: 'PENDING', extraFields: { amount: '50000' }, user: { department: 'IT' } },
    { status: 'REJECTED', extraFields: { amount: '90000' }, user: { department: 'HR' } }
  ]), {
    totalSpendAmount: 10000,
    topRequestingDepartment: 'IT',
    topSpendingDepartment: 'Finance',
    spendingByDepartment: [
      { department: 'Finance', requestCount: 1, spendAmount: 7500 },
      { department: 'IT', requestCount: 2, spendAmount: 2500 },
      { department: 'HR', requestCount: 1, spendAmount: 0 }
    ]
  });
});

test('monthly executive PDF generator returns a PDF document', async () => {
  const period = getUtcMonthPeriodFromKey('2026-10');
  const pdf = await createMonthlyReportPdf({
    monthKey: period.monthKey,
    periodStart: period.start,
    periodEnd: period.end,
    generatedAt: new Date('2026-10-20T09:00:00.000Z'),
    totalRequests: 1,
    approvedCount: 1,
    rejectedCount: 0,
    pendingCount: 0
  }, [{
    id: 25,
    title: 'Office equipment refresh',
    status: 'APPROVED',
    createdAt: new Date('2026-10-05T09:00:00.000Z'),
    extraFields: JSON.stringify({ amount: 125000 }),
    user: { name: 'Jordan User', department: 'Operations' },
    approvalSteps: []
  }]);

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 1000);
});

test('monthly report CSV includes summary and dashboard request columns', () => {
  const createdAt = new Date('2026-10-05T09:30:00.000Z');
  const csv = createMonthlyReportCsv({
    monthKey: '2026-10',
    totalRequests: 1,
    approvedCount: 1,
    rejectedCount: 0,
    pendingCount: 0,
    generatedAt: new Date('2026-10-19T08:00:00.000Z')
  }, [{
    id: 12,
    title: 'Laptop, replacement',
    status: 'APPROVED',
    createdAt,
    updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    user: { name: 'User A', department: 'IT' },
    approvalSteps: [{
      status: 'APPROVED',
      actedAt: new Date('2026-10-05T12:00:00.000Z'),
      approvedBy: { name: 'Manager A' }
    }]
  }]);

  assert.match(csv, /^"Report Month","2026-10"/);
  assert.match(csv, /"Request ID","Title","Requested By","Department","Status","Approved\/Rejected By","Created Date","Resolved Date"/);
  assert.match(csv, /"12","Laptop, replacement","User A","IT","✅ Approved","Manager A","2026-10-05T09:30:00\.000Z","2026-10-05T12:00:00\.000Z"/);
});

test('monthly request mapping includes requester, reviewer, and resolution date', () => {
  const request = {
    id: 101,
    title: 'Laptop Upgrade',
    status: 'APPROVED',
    createdAt: new Date('2026-10-05T09:30:00.000Z'),
    updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    user: { name: 'User A', department: 'IT' },
    approvalSteps: [
      {
        status: 'APPROVED',
        actedAt: new Date('2026-10-05T11:00:00.000Z'),
        approvedBy: { name: 'Manager A' }
      },
      {
        status: 'APPROVED',
        actedAt: new Date('2026-10-05T12:00:00.000Z'),
        approvedBy: { name: 'Super Admin' }
      }
    ]
  };

  const details = getMonthlyRequestDetails(request);
  assert.deepEqual(Object.keys(details), [
    'requestId',
    'title',
    'requestedBy',
    'department',
    'status',
    'approvedRejectedBy',
    'createdDate',
    'resolvedDate'
  ]);
  assert.deepEqual(details, {
    requestId: 101,
    title: 'Laptop Upgrade',
    requestedBy: 'User A',
    department: 'IT',
    status: '✅ Approved',
    approvedRejectedBy: 'Super Admin',
    createdDate: new Date('2026-10-05T09:30:00.000Z'),
    resolvedDate: new Date('2026-10-05T12:00:00.000Z')
  });
});

test('rejected reports identify the rejecting reviewer and use audit history as fallback', () => {
  assert.deepEqual(getMonthlyRequestDetails({
    id: 103,
    title: 'Access Rights Request',
    status: 'REJECTED',
    createdAt: new Date('2026-10-12T10:00:00.000Z'),
    updatedAt: new Date('2026-10-12T12:00:00.000Z'),
    user: { name: 'User B', department: 'HR' },
    approvalSteps: [],
    auditLogs: [{
      action: 'MANAGER_REJECTED',
      createdAt: new Date('2026-10-12T12:00:00.000Z'),
      user: { name: 'Manager B' }
    }]
  }), {
    requestId: 103,
    title: 'Access Rights Request',
    requestedBy: 'User B',
    department: 'HR',
    status: '❌ Rejected',
    approvedRejectedBy: 'Manager B',
    createdDate: new Date('2026-10-12T10:00:00.000Z'),
    resolvedDate: new Date('2026-10-12T12:00:00.000Z')
  });
});

test('pending report rows have no resolution date and expose latest reviewer', () => {
  assert.deepEqual(getMonthlyRequestDetails({
    id: 102,
    title: 'Access Rights Request',
    status: 'PENDING',
    createdAt: new Date('2026-10-12T10:00:00.000Z'),
    updatedAt: new Date('2026-10-12T11:00:00.000Z'),
    user: { name: 'User B', department: 'HR' },
    approvalSteps: [{
      status: 'APPROVED',
      actedAt: new Date('2026-10-12T11:00:00.000Z'),
      approvedBy: { name: 'Manager' }
    }]
  }), {
    requestId: 102,
    title: 'Access Rights Request',
    requestedBy: 'User B',
    department: 'HR',
    status: '⏳ Pending',
    approvedRejectedBy: 'Manager',
    createdDate: new Date('2026-10-12T10:00:00.000Z'),
    resolvedDate: null
  });
});

test('monthly Telegram summary includes detailed entries and emits bounded HTML chunks', () => {
  const messages = formatMonthlyReportMessages({
    monthKey: '2026-09',
    totalRequests: 12,
    approvedCount: 7,
    rejectedCount: 2,
    pendingCount: 3
  }, [{
    id: 101,
    title: '<Laptop & Upgrade>',
    status: 'APPROVED',
    createdAt: new Date('2026-10-05T09:30:00.000Z'),
    updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    extraFields: JSON.stringify({ amount: '1200' }),
    user: { name: 'User A', department: 'IT' },
    approvalSteps: [{
      status: 'APPROVED',
      actedAt: new Date('2026-10-05T12:00:00.000Z'),
      approvedBy: { name: 'Super Admin' }
    }]
  }]);

  assert.equal(messages.length, 1);
  assert.match(messages[0], /📊 <b>Monthly Executive Report - September 2026<\/b>/);
  assert.match(messages[0], /💰 <b>Total Requests &amp; Budget Summary<\/b>/);
  assert.match(messages[0], /• <b>Total Requests:<\/b> 12/);
  assert.match(messages[0], /• <b>Approved Spend:<\/b> 1,200 MMK/);
  assert.match(messages[0], /🏢 <b>Top Spending Department:<\/b> IT \(1,200 MMK\)/);
  assert.match(messages[0], /📎 <b>PDF report:<\/b> Executive PDF attached below\./);
  assert.match(messages[0], /• <b>Approved:<\/b> ✅ 7/);
  assert.match(messages[0], /• <b>Rejected:<\/b> ❌ 2/);
  assert.match(messages[0], /• <b>Pending:<\/b> ⏳ 3/);
  assert.match(messages[0], /#REQ-101:<\/b> &lt;Laptop &amp; Upgrade&gt;/);
  assert.match(messages[0], /Requested By:<\/b> User A \(IT\)/);
  assert.match(messages[0], /Status:<\/b> ✅ Approved \(By: Super Admin\)/);
  assert.match(messages[0], /Resolved:<\/b> Oct 05, 2026/);
  assert.ok(messages[0].length <= 3500);
});

test('monthly Telegram details split into separate valid-sized messages', () => {
  const requests = Array.from({ length: 16 }, (_, index) => ({
    id: index + 1,
    title: `Request ${index + 1} ${'x'.repeat(400)}`,
    status: 'PENDING',
    createdAt: new Date('2026-10-05T09:30:00.000Z'),
    user: { name: 'User A', department: 'IT' }
  }));
  const messages = formatMonthlyReportMessages({
    monthKey: '2026-09',
    totalRequests: requests.length,
    approvedCount: 0,
    rejectedCount: 0,
    pendingCount: requests.length
  }, requests);

  assert.ok(messages.length > 1);
  assert.ok(messages.every(message => message.length <= 3500));
  assert.match(messages[1], /Detailed Breakdown \(continued\)/);
});
