const assert = require('node:assert/strict');
const test = require('node:test');
const { buildApprovalChain, canUserSeeRequest, getApprovalTransition } = require('../server');

test('cross-department requests route through origin, target, then executive approval', () => {
  const chain = buildApprovalChain('Admin', 'Finance', true);

  assert.deepEqual(chain.map(({ stepType, department, approverRole }) => ({
    stepType,
    department,
    approverRole
  })), [
    { stepType: 'DEPARTMENT', department: 'Admin', approverRole: 'MANAGER' },
    { stepType: 'DEPARTMENT', department: 'Finance', approverRole: 'MANAGER' },
    { stepType: 'EXECUTIVE', department: null, approverRole: 'EXECUTIVE' }
  ]);
});

test('same-department requests do not repeat a department manager step', () => {
  const chain = buildApprovalChain('Finance', 'finance', true);

  assert.deepEqual(chain.map(step => step.department), ['Finance', null]);
  assert.equal(chain.at(-1).approverRole, 'EXECUTIVE');
});

test('General target requests do not wait for a nonexistent General department manager', () => {
  const chain = buildApprovalChain('Admin', 'General', true);

  assert.deepEqual(chain.map(step => step.department), ['Admin', null]);
});

test('approval advances from the origin manager to the target manager and then to executives', () => {
  const chain = buildApprovalChain('Admin', 'Finance', true);

  assert.deepEqual(getApprovalTransition('APPROVED', { sequence: 0 }, chain[1]), {
    status: 'PENDING',
    approvalStage: 'PENDING_FINANCE_MANAGER',
    currentApprovalStep: 1
  });
  assert.deepEqual(getApprovalTransition('APPROVED', { sequence: 1 }, chain[2]), {
    status: 'PENDING',
    approvalStage: 'PENDING_EXECUTIVE',
    currentApprovalStep: 2
  });
  assert.deepEqual(getApprovalTransition('APPROVED', { sequence: 2 }, null), {
    status: 'APPROVED',
    approvalStage: 'COMPLETED',
    currentApprovalStep: 3
  });
});

test('Admin requests go to the target manager and require executives only when marked important', () => {
  const normalChain = buildApprovalChain('Admin', 'Finance', false);
  const importantChain = buildApprovalChain('Admin', 'Finance', true);

  assert.deepEqual(normalChain.map(step => [step.department, step.approverRole]), [
    ['Admin', 'MANAGER'],
    ['Finance', 'MANAGER']
  ]);
  assert.deepEqual(importantChain.map(step => [step.department, step.approverRole]), [
    ['Admin', 'MANAGER'],
    ['Finance', 'MANAGER'],
    [null, 'EXECUTIVE']
  ]);
  assert.deepEqual(getApprovalTransition('APPROVED', normalChain[0], normalChain[1]), {
    status: 'PENDING',
    approvalStage: 'PENDING_FINANCE_MANAGER',
    currentApprovalStep: 1
  });
});

test('rejection terminates the chain at the rejecting step', () => {
  assert.deepEqual(getApprovalTransition('REJECTED', { sequence: 1 }, { sequence: 2 }), {
    status: 'REJECTED',
    approvalStage: 'REJECTED',
    currentApprovalStep: 1
  });
});

test('request visibility is limited to the current manager or executive step', () => {
  const request = {
    id: 10,
    userId: 1,
    status: 'PENDING',
    currentApprovalStep: 1,
    approvalSteps: [
      { sequence: 0, department: 'Admin', approverRole: 'MANAGER', status: 'APPROVED' },
      { sequence: 1, department: 'Finance', approverRole: 'MANAGER', status: 'PENDING' },
      { sequence: 2, department: null, approverRole: 'EXECUTIVE', status: 'PENDING' }
    ]
  };

  assert.equal(canUserSeeRequest(request, { id: 2, role: 'MANAGER', department: 'Finance' }), true);
  assert.equal(canUserSeeRequest(request, { id: 3, role: 'MANAGER', department: 'Admin' }), false);
  assert.equal(canUserSeeRequest(request, { id: 4, role: 'GM', department: 'Executive Management' }), false);
  assert.equal(canUserSeeRequest(request, { id: 1, role: 'STAFF', department: 'Admin' }), true);
  assert.equal(canUserSeeRequest(request, { id: 5, role: 'ADMIN', department: null }), true);
});

test('the final request is visible to executives only after department steps finish', () => {
  const request = {
    id: 10,
    userId: 1,
    status: 'PENDING',
    currentApprovalStep: 2,
    approvalSteps: [
      { sequence: 0, department: 'Admin', approverRole: 'MANAGER', status: 'APPROVED' },
      { sequence: 1, department: 'Finance', approverRole: 'MANAGER', status: 'APPROVED' },
      { sequence: 2, department: null, approverRole: 'EXECUTIVE', status: 'PENDING' }
    ]
  };

  assert.equal(canUserSeeRequest(request, { id: 2, role: 'MANAGER', department: 'Finance' }), false);
  assert.equal(canUserSeeRequest(request, { id: 3, role: 'DGM', department: null }), true);
});

test('completed requests are not visible in another manager’s approval queue', () => {
  const request = {
    id: 10,
    userId: 1,
    status: 'APPROVED',
    currentApprovalStep: 3,
    approvalSteps: []
  };

  assert.equal(canUserSeeRequest(request, { id: 2, role: 'MANAGER', department: 'Finance' }), false);
});

test('processed requests remain visible to the approver who handled a step', () => {
  const request = {
    id: 10,
    userId: 1,
    status: 'APPROVED',
    currentApprovalStep: 2,
    approvalSteps: [
      { sequence: 0, status: 'APPROVED', approvedById: 2 },
      { sequence: 1, status: 'APPROVED', approvedById: 3 }
    ]
  };

  assert.equal(canUserSeeRequest(request, { id: 2, role: 'MANAGER', department: 'Admin' }), true);
  assert.equal(canUserSeeRequest(request, { id: 4, role: 'MANAGER', department: 'Finance' }), false);
});
