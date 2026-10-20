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

function getUtcMonthPeriodFromKey(monthKey) {
  if (typeof monthKey !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new TypeError('Month must use the YYYY-MM format.');
  }
  const [year, month] = monthKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  return {
    monthKey,
    start,
    end: new Date(Date.UTC(year, month, 1))
  };
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

function getMonthlyAnalytics(requests) {
  if (!Array.isArray(requests)) {
    throw new TypeError('Monthly report requests must be provided as an array.');
  }

  const departments = new Map();
  let totalSpendAmount = 0;
  for (const request of requests) {
    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(request.status)) continue;
    const department = request.user?.department?.trim() || 'Unassigned';
    const entry = departments.get(department) || { department, requestCount: 0, spendAmount: 0 };
    entry.requestCount += 1;

    if (request.status === 'APPROVED') {
      try {
        const extraFields = typeof request.extraFields === 'string'
          ? JSON.parse(request.extraFields)
          : request.extraFields;
        const amount = Number(extraFields?.amount);
        if (Number.isFinite(amount) && amount > 0) {
          entry.spendAmount += amount;
          totalSpendAmount += amount;
        }
      } catch {
        // Ignore malformed optional request metadata in aggregate totals.
      }
    }

    departments.set(department, entry);
  }

  const departmentBreakdown = [...departments.values()].sort((first, second) =>
    second.spendAmount - first.spendAmount || first.department.localeCompare(second.department)
  );
  const topRequestingDepartment = [...departmentBreakdown]
    .sort((first, second) =>
      second.requestCount - first.requestCount || first.department.localeCompare(second.department)
    )[0]?.department || 'N/A';
  const topSpendingDepartment = departmentBreakdown.find(entry => entry.spendAmount > 0)?.department || 'N/A';

  return {
    totalSpendAmount,
    topRequestingDepartment,
    topSpendingDepartment,
    spendingByDepartment: departmentBreakdown
  };
}

function createMonthlyReportPdf(report, requests) {
  if (!Array.isArray(requests)) {
    throw new TypeError('Monthly report requests must be provided as an array.');
  }
  const PDFDocument = require('pdfkit');
  const analytics = getMonthlyAnalytics(requests);
  const document = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 34, right: 36, bottom: 40, left: 36 },
    info: { Title: `Monthly Executive Report ${report.monthKey}`, Author: 'Requests System' }
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));

    const navy = '#13283f';
    const blue = '#176b87';
    const ink = '#233448';
    const muted = '#63758a';
    const line = '#dce4eb';
    const contentWidth = document.page.width - 72;
    const currency = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    const monthLabel = new Date(`${report.monthKey}-01T00:00:00.000Z`).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric', timeZone: 'UTC'
    });
    const dateLabel = value => value
      ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' })
      : '—';

    document.rect(0, 0, document.page.width, 112).fill(navy);
    document.roundedRect(36, 27, 40, 40, 8).fill(blue);
    document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text('R', 36, 36, {
      width: 40, align: 'center'
    });
    document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19)
      .text('Requests System', 90, 25);
    document.fillColor('#b7c9d8').font('Helvetica').fontSize(9)
      .text('MONTHLY EXECUTIVE REPORT', 90, 51, { characterSpacing: 1.2 });
    document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16)
      .text(monthLabel, 90, 72);
    document.fillColor('#d2dce5').font('Helvetica').fontSize(9)
      .text(`${dateLabel(report.periodStart)} – ${dateLabel(new Date(new Date(report.periodEnd).getTime() - 86400000))}`, 530, 43, {
        width: contentWidth - 494, align: 'right'
      });
    document.fillColor('#d2dce5').fontSize(8)
      .text(`Generated ${dateLabel(report.generatedAt)} | All dates UTC`, 530, 59, {
        width: contentWidth - 494, align: 'right'
      });

    const cards = [
      { label: 'TOTAL REQUESTS', value: String(report.totalRequests ?? 0), accent: blue },
      { label: 'TOTAL APPROVED', value: String(report.approvedCount ?? 0), accent: '#27845c' },
      { label: 'APPROVED SPEND', value: `${currency.format(analytics.totalSpendAmount)} MMK`, accent: '#bd8b2f' },
      { label: 'TOP REQUESTING DEPT.', value: analytics.topRequestingDepartment, accent: '#6a6f9e' }
    ];
    const cardGap = 12;
    const cardWidth = (contentWidth - cardGap * 3) / 4;
    const cardY = 128;
    cards.forEach((card, index) => {
      const x = 36 + index * (cardWidth + cardGap);
      document.roundedRect(x, cardY, cardWidth, 69, 6).fill('#f4f7fa').stroke(line);
      document.rect(x, cardY, 4, 69).fill(card.accent);
      document.fillColor(muted).font('Helvetica-Bold').fontSize(7)
        .text(card.label, x + 14, cardY + 13, { width: cardWidth - 24, characterSpacing: 0.6 });
      document.fillColor(ink).font('Helvetica-Bold').fontSize(index === 3 ? 13 : 18)
        .text(card.value, x + 14, cardY + 34, { width: cardWidth - 24, height: 24, ellipsis: true });
    });

    let y = cardY + 88;
    document.fillColor(ink).font('Helvetica-Bold').fontSize(10).text('SPENDING BY DEPARTMENT', 36, y);
    y += 19;
    const spendingDepartments = analytics.spendingByDepartment
      .filter(entry => entry.spendAmount > 0)
      .slice(0, 6);
    const maxSpend = Math.max(...spendingDepartments.map(entry => entry.spendAmount), 1);
    if (!spendingDepartments.length) {
      document.fillColor(muted).font('Helvetica').fontSize(9).text('No approved spending recorded for this period.', 36, y);
      y += 20;
    } else {
      const barLabelWidth = 112;
      const barWidth = contentWidth - barLabelWidth - 110;
      spendingDepartments.forEach(entry => {
        document.fillColor(ink).font('Helvetica').fontSize(8)
          .text(entry.department, 36, y + 2, { width: barLabelWidth - 8, ellipsis: true });
        document.roundedRect(36 + barLabelWidth, y, barWidth, 10, 4).fill('#e8eef3');
        document.roundedRect(36 + barLabelWidth, y, Math.max(4, barWidth * entry.spendAmount / maxSpend), 10, 4).fill(blue);
        document.fillColor(ink).font('Helvetica-Bold').fontSize(8)
          .text(`${currency.format(entry.spendAmount)} MMK`, 36 + barLabelWidth + barWidth + 10, y + 1, {
            width: 100, align: 'right'
          });
        y += 17;
      });
      y += 7;
    }

    const columns = [
      { key: 'id', label: 'REQUEST', width: 48 },
      { key: 'title', label: 'REQUEST DETAILS', width: 150 },
      { key: 'requester', label: 'REQUESTED BY', width: 102 },
      { key: 'department', label: 'DEPARTMENT', width: 82 },
      { key: 'status', label: 'STATUS', width: 78 },
      { key: 'reviewer', label: 'REVIEWED BY', width: 108 },
      { key: 'created', label: 'SUBMITTED', width: 94 },
      { key: 'resolved', label: 'RESOLVED', width: 108 }
    ];
    const tableWidth = columns.reduce((total, column) => total + column.width, 0);
    const tableX = (document.page.width - tableWidth) / 2;
    const drawTableHeader = () => {
      document.roundedRect(tableX, y, tableWidth, 22, 3).fill(navy);
      let x = tableX;
      columns.forEach(column => {
        document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
          .text(column.label, x + 6, y + 7, { width: column.width - 12 });
        x += column.width;
      });
      y += 22;
    };

    if (y + 50 > document.page.height - 40) {
      document.addPage();
      y = 38;
    }
    document.fillColor(ink).font('Helvetica-Bold').fontSize(10).text('REQUEST DETAIL', 36, y);
    y += 17;
    drawTableHeader();

    requests.forEach((request, index) => {
      const details = getMonthlyRequestDetails(request);
      const values = {
        id: `#${details.requestId}`,
        title: String(details.title || '—').slice(0, 100),
        requester: String(details.requestedBy || '—').slice(0, 60),
        department: String(details.department || '—').slice(0, 45),
        status: request.status || 'PENDING',
        reviewer: String(details.approvedRejectedBy || '—').slice(0, 55),
        created: dateLabel(details.createdDate),
        resolved: dateLabel(details.resolvedDate)
      };
      const fontSize = 7.5;
      document.font('Helvetica').fontSize(fontSize);
      const rowHeight = Math.min(48, Math.max(30, ...columns.map(column =>
        document.heightOfString(values[column.key], { width: column.width - 12, lineGap: 1 }) + 12
      )));
      if (y + rowHeight > document.page.height - 38) {
        document.addPage();
        y = 38;
        drawTableHeader();
      }
      document.rect(tableX, y, tableWidth, rowHeight)
        .fill(index % 2 ? '#f3f6f9' : '#ffffff')
        .stroke(line);
      let x = tableX;
      columns.forEach(column => {
        if (column.key === 'status') {
          const style = request.status === 'APPROVED'
            ? { fill: '#e3f3eb', text: '#176b48', label: 'Approved' }
            : request.status === 'REJECTED'
              ? { fill: '#fae9e8', text: '#a83c35', label: 'Rejected' }
              : { fill: '#fff2d6', text: '#8a6112', label: 'Pending' };
          document.roundedRect(x + 5, y + 8, column.width - 10, 15, 7).fill(style.fill);
          document.fillColor(style.text).font('Helvetica-Bold').fontSize(7)
            .text(style.label, x + 6, y + 12, { width: column.width - 12, align: 'center' });
        } else {
          document.fillColor(column.key === 'id' ? blue : ink)
            .font(column.key === 'id' ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(fontSize)
            .text(values[column.key], x + 6, y + 6, {
              width: column.width - 12,
              height: rowHeight - 10,
              ellipsis: true,
              lineGap: 1
            });
        }
        x += column.width;
      });
      y += rowHeight;
    });

    document.end();
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

  const analytics = getMonthlyAnalytics(requests);
  const monthLabel = new Date(`${report.monthKey}-01T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
  const currency = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const topDepartmentSpend = analytics.spendingByDepartment.find(
    entry => entry.department === analytics.topSpendingDepartment
  )?.spendAmount || 0;
  const header = [
    `📊 <b>Monthly Executive Report - ${escapeTelegramHtml(monthLabel)}</b>`,
    '',
    '💰 <b>Total Requests &amp; Budget Summary</b>',
    `• <b>Total Requests:</b> ${report.totalRequests}`,
    `• <b>Approved:</b> ✅ ${report.approvedCount}`,
    `• <b>Rejected:</b> ❌ ${report.rejectedCount}`,
    `• <b>Pending:</b> ⏳ ${report.pendingCount}`,
    `• <b>Approved Spend:</b> ${currency.format(analytics.totalSpendAmount)} MMK`,
    '',
    `🏢 <b>Top Spending Department:</b> ${escapeTelegramHtml(analytics.topSpendingDepartment)} (${currency.format(topDepartmentSpend)} MMK)`,
    '📎 <b>PDF report:</b> Executive PDF attached below.',
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
  createMonthlyReportPdf,
  formatMonthlyReportMessages,
  getMonthlyAnalytics,
  getMonthlyRequestDetails,
  getUtcMonthPeriod,
  getUtcMonthPeriodFromKey,
  summarizeRequests
};
