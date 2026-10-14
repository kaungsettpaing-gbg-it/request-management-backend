let currentUser = null;
let allRequests = [];
let currentRequestTab = 'PENDING';

function switchAuthTab(tab) {
    const loginContent = document.getElementById('loginTabContent');
    const registerContent = document.getElementById('registerTabContent');
    const loginBtn = document.getElementById('tabLoginBtn');
    const registerBtn = document.getElementById('tabRegisterBtn');

    if (tab === 'login') {
        if (loginContent) loginContent.style.display = 'block';
        if (registerContent) registerContent.style.display = 'none';
        if (loginBtn) loginBtn.classList.add('active');
        if (registerBtn) registerBtn.classList.remove('active');
    } else {
        if (loginContent) loginContent.style.display = 'none';
        if (registerContent) registerContent.style.display = 'block';
        if (registerBtn) registerBtn.classList.add('active');
        if (loginBtn) loginBtn.classList.remove('active');
    }
}

function switchRequestTab(status) {
    currentRequestTab = status;
    document.querySelectorAll('.req-tab-btn').forEach(btn => btn.classList.remove('active'));
    
    const activeBtn = document.getElementById('tabReq_' + status);
    if (activeBtn) activeBtn.classList.add('active');
    
    filterRequests();
}

function renderDynamicFields() {
    const catEl = document.getElementById('category');
    if (!catEl) return;
    const cat = catEl.value;
    const container = document.getElementById('dynamicFieldsContainer');
    if (!container) return;
    container.innerHTML = '';

    if (cat === 'Purchase') {
        container.innerHTML = '<label><small>Estimated Amount ($ / MMK):</small></label>' +
            '<input type="number" id="dyn_amount" placeholder="e.g. 500000 or 1000000" required>' +
            '<label><small>Quantity / Items:</small></label>' +
            '<input type="text" id="dyn_quantity" placeholder="e.g. 2 Laptops" required>';
    } else if (cat === 'Leave') {
        container.innerHTML = '<label><small>Leave Type:</small></label>' +
            '<select id="dyn_leaveType">' +
                '<option value="Casual">Casual Leave</option>' +
                '<option value="Medical">Medical Leave</option>' +
                '<option value="Annual">Annual Leave</option>' +
            '</select>' +
            '<label><small>Number of Days:</small></label>' +
            '<input type="number" id="dyn_days" placeholder="e.g. 3" required>';
    } else if (cat === 'Maintenance') {
        container.innerHTML = '<label><small>Equipment / Location:</small></label>' +
            '<input type="text" id="dyn_location" placeholder="e.g. Server Room AC" required>' +
            '<label><small>Urgency Level:</small></label>' +
            '<select id="dyn_urgency">' +
                '<option value="Low">Low</option>' +
                '<option value="Medium">Medium</option>' +
                '<option value="High/Critical">High / Critical</option>' +
            '</select>';
    } else {
        container.innerHTML = '<small style="color:#666;">No additional fields required for this category.</small>';
    }
}

function updateUI() {
    if (currentUser) {
        document.getElementById('authSection').style.display = 'none';
        document.getElementById('sessionBar').style.display = 'block';
        document.getElementById('dashboardSection').style.display = 'block';
        
        document.getElementById('sessName').innerText = currentUser.name || 'User';
        document.getElementById('sessDept').innerText = currentUser.department || 'N/A';
        document.getElementById('sessRole').innerText = currentUser.role || 'STAFF';

        const targetDeptContainer = document.getElementById('targetDeptContainer');
        if (currentUser.role === 'STAFF') {
            if (targetDeptContainer) targetDeptContainer.style.display = 'none';
        } else {
            if (targetDeptContainer) targetDeptContainer.style.display = 'block';
        }

        if (currentUser.role === 'SUPER_ADMIN') {
            document.getElementById('superTag').style.display = 'inline-block';
            document.getElementById('execTag').style.display = 'none';
            document.getElementById('requestFormCard').style.display = 'none';
        } else if (['GM', 'DGM', 'GM_PA'].includes(currentUser.role)) {
            document.getElementById('superTag').style.display = 'none';
            document.getElementById('execTag').style.display = 'inline-block';
            document.getElementById('requestFormCard').style.display = 'none';
        } else {
            document.getElementById('superTag').style.display = 'none';
            document.getElementById('execTag').style.display = 'none';
            document.getElementById('requestFormCard').style.display = 'block';
        }

        if (['ADMIN', 'SUPER_ADMIN', 'GM', 'DGM', 'MANAGER', 'HR'].includes(currentUser.role)) {
            document.getElementById('exportBtn').style.display = 'block';
        } else {
            document.getElementById('exportBtn').style.display = 'none';
        }
    } else {
        document.getElementById('authSection').style.display = 'block';
        document.getElementById('sessionBar').style.display = 'none';
        document.getElementById('dashboardSection').style.display = 'none';
    }
}

function logout() {
    currentUser = null;
    updateUI();
}

async function loadRequests() {
    try {
        const res = await fetch('/api/requests');
        allRequests = await res.json();
        
        // Sorting: Newest First
        allRequests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        updateAnalytics(allRequests);
        filterRequests();
    } catch(err) {
        console.error(err);
    }
}

function updateAnalytics(requests) {
    if (!Array.isArray(requests)) return;
    document.getElementById('statTotal').innerText = requests.length;
    document.getElementById('statPending').innerText = requests.filter(r => r.status === 'PENDING').length;
    document.getElementById('statApproved').innerText = requests.filter(r => r.status === 'APPROVED').length;
    document.getElementById('statRejected').innerText = requests.filter(r => r.status === 'REJECTED').length;
}

function filterRequests() {
    if (!Array.isArray(allRequests)) return;
    const keyword = (document.getElementById('searchKeyword')?.value || '').toLowerCase();
    const categoryFilter = document.getElementById('filterCategory')?.value || '';

    const filtered = allRequests.filter(req => {
        // Tab Status Matching
        if (currentRequestTab === 'PENDING' && req.status !== 'PENDING') return false;
        if (currentRequestTab === 'APPROVED' && req.status !== 'APPROVED') return false;
        if (currentRequestTab === 'REJECTED' && req.status !== 'REJECTED') return false;

        let isVisible = true;
        const originDept = req.user ? req.user.department : '';

        if (currentUser.role === 'STAFF') {
            isVisible = req.userId === currentUser.id;
        } else if (['MANAGER', 'ASSISTANT'].includes(currentUser.role)) {
            if (req.approvalStage === 'ORIGIN_MGR') {
                isVisible = originDept === currentUser.department || req.userId === currentUser.id;
            } else if (req.approvalStage === 'TARGET_MGR') {
                isVisible = req.targetDepartment === currentUser.department || originDept === currentUser.department || req.userId === currentUser.id;
            } else {
                isVisible = true;
            }
        }

        const matchKeyword = (req.title || '').toLowerCase().includes(keyword) || 
                             (req.description && req.description.toLowerCase().includes(keyword)) ||
                             (req.extraFields && req.extraFields.toLowerCase().includes(keyword));
        const matchCategory = categoryFilter === "" || req.category === categoryFilter;

        return isVisible && matchKeyword && matchCategory;
    });

    // Ensure Newest First Sorting
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    renderRequests(filtered);
}

function renderRequests(requests) {
    const listDiv = document.getElementById('requestList');
    if (!listDiv) return;
    listDiv.innerHTML = '';
    
    if (!Array.isArray(requests) || requests.length === 0) {
        listDiv.innerHTML = `<p style="color: var(--text-muted); padding: 20px; text-align: center; background: #ffffff; border-radius: 8px; border: 1px solid var(--border-color);">No <b>${currentRequestTab}</b> requests found.</p>`;
        return;
    }

    requests.forEach(req => {
        const userName = req.user ? req.user.name : 'Unknown';
        const userDept = req.user ? req.user.department : 'N/A';
        const userRole = req.user ? req.user.role : 'N/A';
        let extraStr = '';
        try {
            const extra = req.extraFields ? JSON.parse(req.extraFields) : {};
            extraStr = Object.entries(extra).map(([k, v]) => '<b>' + k + ':</b> ' + v).join(' | ');
        } catch(e) {}

        let fileLink = req.attachment ? '<br><small>📎 <b>Attachment:</b> <a href="/' + req.attachment + '" target="_blank">Download/View File</a></small>' : '';
        const formattedDate = req.createdAt ? new Date(req.createdAt).toLocaleString() : 'N/A';

        // Audit Log History HTML Generation
        let auditHtml = '';
        if (req.auditLogs && req.auditLogs.length > 0) {
            auditHtml = '<div class="audit-history-box" style="background: #f1f5f9; padding: 10px; border-radius: 6px; margin-top: 10px; font-size: 12px; border-left: 3px solid #4f46e5;"><strong>📜 Audit Log History:</strong>';
            req.auditLogs.forEach(log => {
                const logTime = new Date(log.createdAt).toLocaleString();
                const actor = log.user ? `${log.user.name} (${log.user.role})` : 'System';
                auditHtml += `<div class="audit-entry" style="margin-top: 4px; color: #334155;">⏱ <b>${log.action}</b> by ${actor} on ${logTime} - <i>${log.remarks || 'No remarks'}</i></div>`;
            });
            auditHtml += '</div>';
        } else {
            auditHtml = '<div class="audit-history-box" style="background: #f1f5f9; padding: 8px; border-radius: 6px; margin-top: 10px; font-size: 12px; color: #64748b;">📜 Audit Log History: <i>No history recorded yet.</i></div>';
        }

        let canAction = false;
        if (req.status === 'PENDING' && currentUser) {
            if (['SUPER_ADMIN', 'ADMIN'].includes(currentUser.role)) {
                canAction = true;
            } else if (req.approvalStage === 'ORIGIN_MGR' && currentUser.role === 'MANAGER' && userDept === currentUser.department) {
                canAction = true;
            } else if (req.approvalStage === 'TARGET_MGR' && currentUser.role === 'MANAGER' && req.targetDepartment === currentUser.department) {
                canAction = true;
            } else if (req.approvalStage === 'EXECUTIVE' && ['GM', 'DGM'].includes(currentUser.role)) {
                canAction = true;
            }
        }

        let actionButtons = '';
        if (canAction) {
            actionButtons = '<div>' +
                '<button class="btn-approve" onclick="updateStatus(' + req.id + ', \'APPROVED\')">Approve</button>' +
                '<button class="btn-reject" onclick="updateStatus(' + req.id + ', \'REJECTED\')">Reject</button>' +
            '</div>';
        }

        listDiv.innerHTML += '<div class="request-item">' +
            '<div class="request-header">' +
                '<div>' +
                    '<strong>' + req.title + '</strong> [<b>' + req.category + '</b>] <span class="status-' + req.status + '">[' + req.status + ']</span> ' +
                    '<span class="stage-badge">Stage: ' + req.approvalStage + '</span><br>' +
                    '<span class="timestamp">📅 Submitted on: ' + formattedDate + ' | 🎯 Target Dept: <b>' + (req.targetDepartment || 'General') + '</b></span><br>' +
                    '<small>' + (req.description || 'No description') + '</small><br>' +
                    (extraStr ? '<small style="color:#0284c7;">' + extraStr + '</small><br>' : '') +
                    fileLink + '<br>' +
                    '<em>By: ' + userName + ' (' + userDept + ' - ' + userRole + ')</em>' +
                '</div>' +
                actionButtons +
            '</div>' +
            auditHtml +
        '</div>';
    });
}

async function updateStatus(id, status) {
    const remarks = prompt(`Enter optional remarks for setting status to ${status}:`);
    try {
        const res = await fetch('/api/requests/' + id + '/status', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, userId: currentUser.id, remarks })
        });
        if (res.ok) {
            loadRequests();
        } else {
            alert("Failed to update status");
        }
    } catch(err) {
        alert("Error updating status: " + err.message);
    }
}

function exportReport() {
    window.location.href = '/api/export/requests';
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('userForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('regName').value;
        const email = document.getElementById('regEmail').value;
        const password = document.getElementById('regPassword').value;
        const department = document.getElementById('regDept').value;
        const role = document.getElementById('regRole').value;

        try {
            const res = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password, department, role })
            });
            if (res.ok) {
                alert("User Registered Successfully! You can now log in.");
                document.getElementById('userForm').reset();
                switchAuthTab('login');
            } else {
                alert("Error in registration");
            }
        } catch(err) {
            alert("Error: " + err.message);
        }
    });

    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value.trim();

        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (res.ok && data.user) {
                currentUser = data.user;
                updateUI();
                renderDynamicFields();
                loadRequests();
            } else {
                alert("Login Error: " + (data.error || "Invalid credentials"));
            }
        } catch (err) {
            alert("Network Error: " + err.message);
        }
    });

    document.getElementById('requestForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const formData = new FormData();
        formData.append('title', document.getElementById('title').value);
        
        let targetDept = currentUser.department;
        if (currentUser.role !== 'STAFF') {
            targetDept = document.getElementById('targetDepartment').value;
        }
        formData.append('targetDepartment', targetDept);
        
        const isDirect = document.getElementById('isDirectExecutive') ? document.getElementById('isDirectExecutive').checked : false;
        formData.append('isDirectExecutive', isDirect);

        formData.append('category', document.getElementById('category').value);
        formData.append('description', document.getElementById('description').value);
        formData.append('userId', currentUser.id);

        const extraFields = {};
        const cat = document.getElementById('category').value;
        if (cat === 'Purchase') {
            extraFields.amount = document.getElementById('dyn_amount')?.value;
            extraFields.quantity = document.getElementById('dyn_quantity')?.value;
        } else if (cat === 'Leave') {
            extraFields.leaveType = document.getElementById('dyn_leaveType')?.value;
            extraFields.days = document.getElementById('dyn_days')?.value;
        } else if (cat === 'Maintenance') {
            extraFields.location = document.getElementById('dyn_location')?.value;
            extraFields.urgency = document.getElementById('dyn_urgency')?.value;
        }
        formData.append('extraFields', JSON.stringify(extraFields));

        const fileInput = document.getElementById('attachment');
        if (fileInput && fileInput.files[0]) {
            formData.append('attachment', fileInput.files[0]);
        }

        try {
            const res = await fetch('/api/requests', {
                method: 'POST',
                body: formData
            });
            if (res.ok) {
                alert("Request submitted successfully!");
                document.getElementById('requestForm').reset();
                renderDynamicFields();
                loadRequests();
            } else {
                alert("Error submitting request");
            }
        } catch(err) {
            alert("Submit Error: " + err.message);
        }
    });
});