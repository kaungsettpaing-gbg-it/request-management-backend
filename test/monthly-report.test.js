const assert = require('node:assert/strict');
const test = require('node:test');
const {
  formatMonthlyReportMessages,
  getMonthlyRequestDetails,
  getUtcMonthPeriod,
  summarizeRequests
} = require('../lib/monthly-report');
const { createMonthlyReportCsv } = require('../server');

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
    user: { name: 'User A', department: 'IT' },
    approvalSteps: [{
      status: 'APPROVED',
      actedAt: new Date('2026-10-05T12:00:00.000Z'),
      approvedBy: { name: 'Super Admin' }
    }]
  }]);

  assert.equal(messages.length, 1);
  assert.match(messages[0], /📊 <b>Monthly Request Report \(Summary\) — 2026-09<\/b>/);
  assert.match(messages[0], /• <b>Total Requests:<\/b> 12/);
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
