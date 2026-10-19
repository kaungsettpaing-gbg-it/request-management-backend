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

function formatMonthlyReportMessage(report) {
  return [
    `📊 Monthly Request Report — ${report.monthKey}`,
    `Total requests: ${report.totalRequests}`,
    `✅ Approved: ${report.approvedCount}`,
    `❌ Rejected: ${report.rejectedCount}`,
    `⏳ Pending: ${report.pendingCount}`
  ].join('\n');
}

module.exports = {
  formatMonthlyReportMessage,
  getUtcMonthPeriod,
  summarizeRequests
};
