function getUtcMonthPeriod(date = new Date(), monthOffset = 0) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) ||
      !Number.isInteger(monthOffset)) {
    throw new TypeError('A valid date and integer month offset are required.');
  }

  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + monthOffset,
    1
  ));
  const end = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    1
  ));
  const monthKey = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;

  return { monthKey, start, end };
}

function summarizeRequests(requests) {
  if (!Array.isArray(requests)) {
    throw new TypeError('Requests must be provided as an array.');
  }

  return requests.reduce((summary, request) => {
    if (request.status === 'PENDING') {
      summary.totalRequests += 1;
      summary.pendingCount += 1;
    } else if (request.status === 'APPROVED') {
      summary.totalRequests += 1;
      summary.approvedCount += 1;
    } else if (request.status === 'REJECTED') {
      summary.totalRequests += 1;
      summary.rejectedCount += 1;
    }
    return summary;
  }, {
    totalRequests: 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0
  });
}

function getMonthlyRequestDetails(request) {
  const approvalSteps = [...(request.approvalSteps || [])]
    .filter(step => step.actedAt && step.approvedBy)
    .sort((first, second) => new Date(first.actedAt) - new Date(second.actedAt));
  const actionStatus = ['APPROVED', 'REJECTED'].includes(request.status)
    ? request.status
    : null;
  const decisionStep = actionStatus
    ? [...approvalSteps].reverse().find(step => step.status === actionStatus)
    : approvalSteps.at(-1);
  const matchingAuditAction = actionStatus
    ? new RegExp(actionStatus, 'i')
    : /APPROVED|REJECTED/i;
  const auditDecision = [...(request.auditLogs || [])]
    .filter(log => matchingAuditAction.test(log.action) && log.user)
    .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))[0];
  const approverName = decisionStep?.approvedBy?.name ||
    auditDecision?.user?.name ||
    null;
  const resolutionDate = actionStatus
    ? decisionStep?.actedAt || auditDecision?.createdAt || request.updatedAt || null
    : null;
  const statusLabels = {
    APPROVED: '✅ Approved',
    REJECTED: '❌ Rejected',
    PENDING: '⏳ Pending'
  };

  return {
    requestId: request.id,
    title: request.title || '',
    requestedBy: request.user?.name || request.user?.telegramFirstName || 'Unknown',
    department: request.user?.department || 'N/A',
    status: statusLabels[request.status] || '⏳ Pending',
    approvedRejectedBy: approverName || '',
    createdDate: request.createdAt ? new Date(request.createdAt) : null,
    resolvedDate: resolutionDate ? new Date(resolutionDate) : null
  };
}

function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function formatMonthlyReportMessages(report, requests, maxLength = 3500) {
  if (!Array.isArray(requests)) {
    throw new TypeError('Monthly report requests must be provided as an array.');
  }
  if (!Number.isInteger(maxLength) || maxLength < 500 || maxLength > 4096) {
    throw new RangeError('Telegram message length must be between 500 and 4096 characters.');
  }

  const header = [
    `📊 <b>Monthly Request Report (Summary) — ${escapeTelegramHtml(report.monthKey)}</b>`,
    '----------------------------------------',
    `• <b>Total Requests:</b> ${report.totalRequests}`,
    `• <b>Approved:</b> ✅ ${report.approvedCount}`,
    `• <b>Rejected:</b> ❌ ${report.rejectedCount}`,
    `• <b>Pending:</b> ⏳ ${report.pendingCount}`,
    '',
    '📝 <b>Detailed Breakdown:</b>'
  ].join('\n');
  const details = requests.map((request, index) => {
    const item = getMonthlyRequestDetails(request);
    const date = item.createdDate
      ? item.createdDate.toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        timeZone: 'UTC'
      })
      : 'N/A';
    const resolvedDate = item.resolvedDate
      ? item.resolvedDate.toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        timeZone: 'UTC'
      })
      : null;
    const approver = item.approvedRejectedBy
      ? ` (By: ${escapeTelegramHtml(String(item.approvedRejectedBy).slice(0, 80))})`
      : '';
    return [
      `${index + 1}. <b>#REQ-${item.requestId}:</b> ${escapeTelegramHtml(String(item.title).slice(0, 250))}`,
      `   • <b>Requested By:</b> ${escapeTelegramHtml(String(item.requestedBy).slice(0, 80))} (${escapeTelegramHtml(String(item.department).slice(0, 60))})`,
      `   • <b>Status:</b> ${escapeTelegramHtml(item.status)}${approver}`,
      `   • <b>Date:</b> ${date}`,
      ...(resolvedDate ? [`   • <b>Resolved:</b> ${resolvedDate}`] : [])
    ].join('\n');
  });

  const messages = [];
  let current = header;
  for (const [index, detail] of details.entries()) {
    const separator = '\n\n';
    if (current.length + separator.length + detail.length > maxLength && current !== header) {
      messages.push(current);
      current = `📝 <b>Detailed Breakdown (continued):</b>\n\n${detail}`;
      continue;
    }
    if (current.length + separator.length + detail.length > maxLength) {
      throw new RangeError(`Monthly request detail #${index + 1} exceeds the Telegram message limit.`);
    }
    current += separator + detail;
  }
  if (current) messages.push(current);
  if (!messages.length) messages.push(header);
  if (messages.some(message => message.length > maxLength)) {
    throw new RangeError('Monthly report message exceeds the configured Telegram message limit.');
  }
  return messages;
}

module.exports = {
  formatMonthlyReportMessages,
  getMonthlyRequestDetails,
  getUtcMonthPeriod,
  summarizeRequests
};
