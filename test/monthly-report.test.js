const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');
const {
  createMonthlyReportWorkbook,
  createMonthlyReportPdf,
  formatMonthlyReportMessages,
  getMonthlyAnalytics,
  getMonthlyRequestDetails,
  getUtcMonthPeriod,
  getUtcMonthPeriodFromKey,
  summarizeRequests
} = require('../lib/monthly-report');
const {
  canAccessMonthlyReports,
  createMonthlyAuditCsv,
  createMonthlyReportCsv
} = require('../server');

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

test('monthly report access is granted only to approved reporting roles', () => {
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SUPERVISOR']) {
    assert.equal(canAccessMonthlyReports(role), true);
  }
  for (const role of ['STAFF', 'ASSISTANT', 'HR', 'GM', null]) {
    assert.equal(canAccessMonthlyReports(role), false);
  }
});

test('monthly audit CSV exports raw audit log rows with formula-safe values', () => {
  const csv = createMonthlyAuditCsv([{
    id: 42,
    createdAt: new Date('2026-10-05T12:00:00.000Z'),
    action: 'APPROVED',
    remarks: '=approved',
    userId: 7,
    user: { name: 'Manager A' },
    requestId: 12,
    request: {
      title: 'Laptop request',
      status: 'APPROVED',
      user: { name: 'User A', department: 'IT' }
    }
  }]);

  assert.match(csv, /^"Audit ID","Date & Time","Action","Remarks"/);
  assert.match(csv, /"42","2026-10-05T12:00:00\.000Z","APPROVED","'=approved","7","Manager A","12","Laptop request","APPROVED","User A","IT"/);
});

test('monthly Excel report includes styled executive KPIs and a complete filtered request log', async () => {
  const report = {
    monthKey: '2026-10',
    totalRequests: 3,
    approvedCount: 1,
    rejectedCount: 1,
    pendingCount: 1,
    generatedAt: new Date('2026-10-19T08:00:00.000Z')
  };
  const requests = [
    {
      id: 12,
      title: 'Laptop replacement',
      category: 'Equipment',
      targetDepartment: 'IT',
      status: 'APPROVED',
      createdAt: new Date('2026-10-05T09:30:00.000Z'),
      updatedAt: new Date('2026-10-05T12:00:00.000Z'),
      extraFields: JSON.stringify({
        amount: '125000',
        items: 'Business laptop',
        quantity: '2',
        quantityUnit: 'pcs',
        urgency: 'High'
      }),
      user: { name: 'User A', department: 'Finance' },
      approvalSteps: [{
        status: 'APPROVED',
        actedAt: new Date('2026-10-05T12:00:00.000Z'),
        approvedBy: { name: 'Manager A' }
      }]
    },
    {
      id: 13,
      title: 'Travel request',
      category: 'Travel',
      targetDepartment: 'Operations',
      status: 'REJECTED',
      createdAt: new Date('2026-10-06T09:30:00.000Z'),
      user: { name: 'User B', department: 'IT' },
      approvalSteps: []
    },
    {
      id: 14,
      title: 'Office supplies',
      category: 'General',
      targetDepartment: 'Finance',
      status: 'PENDING',
      createdAt: new Date('2026-10-07T09:30:00.000Z'),
      user: { name: 'User C', department: 'IT' },
      approvalSteps: []
    }
  ];
  const file = await createMonthlyReportWorkbook(report, requests);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);

  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), [
    'Executive Summary',
    'Detailed Requests Log'
  ]);
  const summary = workbook.getWorksheet('Executive Summary');
  assert.equal(summary.getCell('A5').value, 3);
  assert.equal(summary.getCell('A13').value, 125000);
  assert.equal(summary.getCell('D13').value, 'IT');

  const log = workbook.getWorksheet('Detailed Requests Log');
  assert.deepEqual(log.getRow(1).values.slice(1), [
    'Request ID',
    'Date & Time Submitted',
    'Requester Name',
    'Requester Department',
    'Target Department',
    'Request Title / Category',
    'Quantity / Item Details',
    'Amount / Cost',
    'Approver Name',
    'Status',
    'Approval / Rejection Date'
  ]);
  assert.equal(log.getCell('A2').value, 12);
  assert.equal(log.getCell('B2').value.toISOString(), '2026-10-05T09:30:00.000Z');
  assert.equal(log.getCell('F2').value, 'Laptop replacement / Equipment');
  assert.equal(log.getCell('G2').value, 'Business laptop; Qty: 2 pcs; urgency: High');
  assert.equal(log.getCell('H2').value, 125000);
  assert.equal(log.getCell('I2').value, 'Manager A');
  assert.equal(log.getCell('J2').value, 'Approved');
  assert.equal(log.getCell('K2').value.toISOString(), '2026-10-05T12:00:00.000Z');
  assert.equal(log.getCell('J3').value, 'Rejected');
  assert.equal(log.getCell('J4').value, 'Pending');
  assert.equal(log.getCell('A1').fill.fgColor.argb, 'FF17365D');
  assert.equal(log.getCell('A1').font.color.argb, 'FFFFFFFF');
  assert.equal(log.getCell('A2').fill.fgColor.argb, 'FFF3F6F9');
  assert.equal(log.getCell('A3').fill.fgColor.argb, 'FFFFFFFF');
  assert.equal(log.getCell('A2').border.bottom.style, 'thin');
  assert.equal(log.autoFilter, 'A1:K4');
  assert.equal(log.views[0].ySplit, 1);
  assert.equal(log.conditionalFormattings[0].rules.length, 3);
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
