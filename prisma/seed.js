<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Enterprise Request Management System</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 20px; background: #f0f2f5; color: #333; }
        .container { max-width: 1050px; background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin: auto; }
        h2 { color: #1a73e8; margin-top: 0; }
        h3 { border-bottom: 2px solid #eee; padding-bottom: 8px; color: #444; }
        input, select, textarea { width: 100%; padding: 9px; margin: 6px 0 12px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
        button { background: #1a73e8; color: white; border: none; padding: 9px 14px; cursor: pointer; border-radius: 4px; font-weight: bold; }
        button:hover { background: #1557b0; }
        .card { background: #f8f9fa; padding: 15px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #ddd; }
        
        .stats-container { display: flex; gap: 15px; margin-bottom: 20px; }
        .stat-card { flex: 1; background: white; padding: 15px; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); border-left: 4px solid #1a73e8; text-align: center; }
        .stat-card.pending { border-left-color: #d97706; }
        .stat-card.approved { border-left-color: #16a34a; }
        .stat-card.rejected { border-left-color: #dc2626; }
        .stat-number { font-size: 22px; font-weight: bold; margin-top: 5px; color: #333; }

        .request-item { background: #fff; padding: 14px; margin-top: 10px; border-radius: 6px; border-left: 5px solid #1a73e8; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .status-PENDING { color: #d97706; font-weight: bold; }
        .status-APPROVED { color: #16a34a; font-weight: bold; }
        .status-REJECTED { color: #dc2626; font-weight: bold; }
        .btn-approve { background: #16a34a; margin-right: 5px; }
        .btn-reject { background: #dc2626; }
        .executive-tag { background: #d97706; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; }
        .super-admin-tag { background: #8e44ad; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; }
        .filter-bar { display: flex; gap: 10px; margin-bottom: 15px; align-items: center; flex-wrap: wrap; }
        .filter-bar input, .filter-bar select { margin: 0; flex: 1; min-width: 150px; }
        table.checklist { width: 100%; border-collapse: collapse; margin-top: 10px; }
        table.checklist th, table.checklist td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 13px; }
        table.checklist th { background-color: #f2f2f2; }
        .dynamic-fields { background: #eef2f7; padding: 10px; border-radius: 4px; margin-bottom: 10px; border: 1px dashed #b8c7ce; }
        .timestamp { font-size: 11px; color: #555; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Enterprise Request Management System</h2>
        
        <!-- Session Bar -->
        <div id="sessionBar" class="card" style="background: #e8f0fe; display: none;">
            <strong>User:</strong> <span id="sessName"></span> | 
            <strong>Dept:</strong> <span id="sessDept"></span> | 
            <strong>Role:</strong> <span id="sessRole" style="color: #1a73e8;"></span>
            <span id="superTag" class="super-admin-tag" style="display:none; margin-left:10px;">SUPER ADMIN</span>
            <span id="execTag" class="executive-tag" style="display:none; margin-left:10px;">EXECUTIVE LEVEL</span>
            <button onclick="logout()" style="float: right; padding: 4px 8px; background: #dc3545; font-size: 12px;">Logout</button>
        </div>

        <!-- Auth Section -->
        <div id="authSection">
            <div style="display: flex; gap: 20px;">
                <div style="flex: 1;" class="card">
                    <h3>Login</h3>
                    <form id="loginForm">
                        <label><small>Email or Username:</small></label>
                        <input type="text" id="loginEmail" placeholder="e.g. kaungsettpaing@admin.com or Kaung Sett Paing" required>
                        <label><small>Password:</small></label>
                        <input type="password" id="loginPassword" placeholder="Password" required>
                        <button type="submit">Login</button>
                    </form>
                </div>
                <div style="flex: 1;" class="card">
                    <h3>Register User</h3>
                    <form id="userForm">
                        <input type="text" id="regName" placeholder="Full Name" required>
                        <input type="email" id="regEmail" placeholder="Email" required>
                        <input type="password" id="regPassword" placeholder="Password" required>
                        
                        <label><small>Department:</small></label>
                        <select id="regDept">
                            <option value="HR">HR</option>
                            <option value="Finance">Finance</option>
                            <option value="Cashier">Cashier</option>
                            <option value="Sales & Marketing">Sales & Marketing</option>
                            <option value="Warehouse">Warehouse</option>
                            <option value="M&E">M&E</option>
                            <option value="Production">Production</option>
                            <option value="Admin">Admin</option>
                            <option value="Executive Management">Executive Management</option>
                        </select>

                        <label><small>Role Position:</small></label>
                        <select id="regRole">
                            <option value="STAFF">Staff (Employee)</option>
                            <option value="ASSISTANT">Assistant / Supervisor</option>
                            <option value="MANAGER">Department Manager</option>
                            <option value="DGM">Deputy General Manager (DGM)</option>
                            <option value="GM">General Manager (GM)</option>
                            <option value="GM_PA">GM's Personal Assistant (PA)</option>
                            <option value="ADMIN">Administrator</option>
                        </select>
                        <button type="submit" style="background: #28a745;">Register</button>
                    </form>
                </div>
            </div>
        </div>

        <!-- Dashboard Section -->
        <div id="dashboardSection" style="display: none;">
            <div class="stats-container">
                <div class="stat-card">
                    <div>Total Requests</div>
                    <div class="stat-number" id="statTotal">0</div>
                </div>
                <div class="stat-card pending">
                    <div>Pending</div>
                    <div class="stat-number" id="statPending">0</div>
                </div>
                <div class="stat-card approved">
                    <div>Approved</div>
                    <div class="stat-number" id="statApproved">0</div>
                </div>
                <div class="stat-card rejected">
                    <div>Rejected</div>
                    <div class="stat-number" id="statRejected">0</div>
                </div>
            </div>

            <!-- Dynamic Request Form -->
            <div class="card" id="requestFormCard">
                <h3>Submit New Request</h3>
                <form id="requestForm" enctype="multipart/form-data">
                    <input type="text" id="title" name="title" placeholder="Request Title" required>
                    
                    <label><small>Select Category:</small></label>
                    <select id="category" name="category" onchange="renderDynamicFields()">
                        <option value="Purchase">Purchase / Procurement</option>
                        <option value="Leave">Leave Request</option>
                        <option value="Maintenance">Maintenance / Repair</option>
                        <option value="Finance">Financial / Budget</option>
                        <option value="General">General / Other</option>
                    </select>

                    <!-- Dynamic Fields Container -->
                    <div id="dynamicFieldsContainer" class="dynamic-fields"></div>

                    <textarea id="description" name="description" placeholder="Description..."></textarea>
                    
                    <label><small>Attach File / Receipt / Image (Optional):</small></label>
                    <input type="file" id="attachment" name="attachment" accept="image/*,.pdf,.doc,.docx">

                    <button type="submit">Submit Request</button>
                </form>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; border: none;">System Requests Overview (Newest First)</h3>
                <button id="exportBtn" onclick="exportReport()" style="background: #17a2b8; display: none;">Export CSV Report</button>
            </div>

            <!-- Advanced Filtering Bar -->
            <div class="filter-bar" style="margin-top: 15px;">
                <input type="text" id="searchKeyword" placeholder="Search keyword..." oninput="filterRequests()">
                <select id="filterStatus" onchange="filterRequests()">
                    <option value="">All Statuses</option>
                    <option value="PENDING">Pending</option>
                    <option value="APPROVED">Approved</option>
                    <option value="REJECTED">Rejected</option>
                </select>
                <select id="filterCategory" onchange="filterRequests()">
                    <option value="">All Categories</option>
                    <option value="Purchase">Purchase</option>
                    <option value="Leave">Leave</option>
                    <option value="Maintenance">Maintenance</option>
                    <option value="Finance">Finance</option>
                    <option value="General">General</option>
                </select>
            </div>

            <div id="requestList" style="margin-top: 15px;">Loading...</div>
        </div>
    </div>

    <script>
        let currentUser = null;
        let allRequests = [];

        function renderDynamicFields() {
            const catEl = document.getElementById('category');
            if (!catEl) return;
            const cat = catEl.value;
            const container = document.getElementById('dynamicFieldsContainer');
            if (!container) return;
            container.innerHTML = '';

            if (cat === 'Purchase') {
                container.innerHTML = '<label><small>Estimated Amount ($ / MMK):</small></label>' +
                    '<input type="number" id="dyn_amount" placeholder="e.g. 150000" required>' +
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

        document.getElementById('userForm').addEventListener('submit', async (e) => {
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
                    alert("User Registered Successfully!");
                    document.getElementById('userForm').reset();
                } else {
                    alert("Error in registration");
                }
            } catch(err) {
                alert("Error: " + err.message);
            }
        });

        document.getElementById('loginForm').addEventListener('submit', async (e) => {
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

        function logout() {
            currentUser = null;
            updateUI();
        }

        function updateUI() {
            if (currentUser) {
                document.getElementById('authSection').style.display = 'none';
                document.getElementById('sessionBar').style.display = 'block';
                document.getElementById('dashboardSection').style.display = 'block';
                
                document.getElementById('sessName').innerText = currentUser.name || 'User';
                document.getElementById('sessDept').innerText = currentUser.department || 'N/A';
                document.getElementById('sessRole').innerText = currentUser.role || 'STAFF';

                if (currentUser.role === 'SUPER_ADMIN') {
                    document.getElementById('superTag').style.display = 'inline-block';
                    document.getElementById('execTag').style.display = 'none';
                    document.getElementById('requestFormCard').style.display = 'none';
                } else if (['GM', 'DGM', 'GM_PA'].includes(currentUser.role)) {
                    document.getElementById('superTag').style.display = 'none';
                    document.getElementById('execTag').style.display = 'inline-block';
                    document.getElementById('requestFormCard').style.display = 'none'; // Executives oversee and approve
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

        document.getElementById('requestForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData();
            formData.append('title', document.getElementById('title').value);
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

        async function loadRequests() {
            try {
                const res = await fetch('/api/requests');
                allRequests = await res.json();
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
            const keyword = (document.getElementById('searchKeyword').value || '').toLowerCase();
            const statusFilter = document.getElementById('filterStatus').value;
            const categoryFilter = document.getElementById('filterCategory').value;

            const filtered = allRequests.filter(req => {
                let isVisible = true;
                // RBAC Visibility Logic
                if (currentUser.role === 'STAFF') {
                    isVisible = req.userId === currentUser.id;
                } else if (['MANAGER', 'ASSISTANT'].includes(currentUser.role)) {
                    isVisible = (req.user && req.user.department === currentUser.department) || req.userId === currentUser.id;
                }
                // GM, DGM, GM_PA, SUPER_ADMIN, ADMIN can see ALL requests across all departments

                const matchKeyword = (req.title || '').toLowerCase().includes(keyword) || 
                                     (req.description && req.description.toLowerCase().includes(keyword)) ||
                                     (req.extraFields && req.extraFields.toLowerCase().includes(keyword));
                const matchStatus = statusFilter === "" || req.status === statusFilter;
                const matchCategory = categoryFilter === "" || req.category === categoryFilter;

                return isVisible && matchKeyword && matchStatus && matchCategory;
            });

            renderRequests(filtered);
        }

        function renderRequests(requests) {
            const listDiv = document.getElementById('requestList');
            listDiv.innerHTML = '';
            
            if (!Array.isArray(requests) || requests.length === 0) {
                listDiv.innerHTML = '<p>No matching requests found.</p>';
                return;
            }

            // SUPER_ADMIN or Executive (GM, DGM, GM_PA) Table / Checklist View
            if (currentUser && (currentUser.role === 'SUPER_ADMIN' || ['GM', 'DGM', 'GM_PA'].includes(currentUser.role))) {
                let canApprove = ['GM', 'DGM', 'SUPER_ADMIN'].includes(currentUser.role); // PA can view easily, GM & DGM can approve
                let html = '<table class="checklist"><thead><tr><th>ID & Date/Time</th><th>Title</th><th>Category</th><th>Details</th><th>Attachment</th><th>Submitted By</th><th>Status</th>' + (canApprove ? '<th>Executive Action</th>' : '<th>View Mode</th>') + '</tr></thead><tbody>';
                
                requests.forEach(req => {
                    const userName = req.user ? req.user.name : 'Unknown';
                    const userDept = req.user ? req.user.department : 'N/A';
                    const userRole = req.user ? req.user.role : 'N/A';
                    let extraStr = '';
                    try {
                        const extra = req.extraFields ? JSON.parse(req.extraFields) : {};
                        extraStr = Object.entries(extra).map(([k, v]) => '<b>' + k + ':</b> ' + v).join(', ');
                    } catch(e) {}

                    let fileLink = req.attachment ? '<a href="/' + req.attachment + '" target="_blank">View File</a>' : 'None';
                    const formattedDate = req.createdAt ? new Date(req.createdAt).toLocaleString() : 'N/A';

                    let actionCell = '<span style="color: #666; font-style: italic;">View Only</span>';
                    if (canApprove) {
                        actionCell = '<button class="btn-approve" style="padding:3px 6px; font-size:11px;" onclick="updateStatus(' + req.id + ', \'APPROVED\')">Approve</button>' +
                                     '<button class="btn-reject" style="padding:3px 6px; font-size:11px;" onclick="updateStatus(' + req.id + ', \'REJECTED\')">Reject</button>';
                    }

                    html += '<tr>' +
                        '<td>#' + req.id + '<br><span class="timestamp">' + formattedDate + '</span></td>' +
                        '<td><b>' + req.title + '</b><br><small>' + (req.description || '') + '</small></td>' +
                        '<td>' + req.category + '</td>' +
                        '<td><small>' + extraStr + '</small></td>' +
                        '<td>' + fileLink + '</td>' +
                        '<td>' + userName + ' (' + userDept + ' - ' + userRole + ')</td>' +
                        '<td><span class="status-' + req.status + '">' + req.status + '</span></td>' +
                        '<td>' + actionCell + '</td>' +
                    '</tr>';
                });
                html += '</tbody></table>';
                listDiv.innerHTML = html;
                return;
            }

            // Standard Cards View for Managers / Staff
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

                let actionButtons = '';
                if (currentUser && ['MANAGER', 'ADMIN', 'ASSISTANT'].includes(currentUser.role)) {
                    actionButtons = '<div>' +
                        '<button class="btn-approve" onclick="updateStatus(' + req.id + ', \'APPROVED\')">Approve</button>' +
                        '<button class="btn-reject" onclick="updateStatus(' + req.id + ', \'REJECTED\')">Reject</button>' +
                    '</div>';
                }

                listDiv.innerHTML += '<div class="request-item">' +
                    '<div>' +
                        '<strong>' + req.title + '</strong> [<b>' + req.category + '</b>] <span class="status-' + req.status + '">[' + req.status + ']</span><br>' +
                        '<span class="timestamp">📅 Submitted on: ' + formattedDate + '</span><br>' +
                        '<small>' + (req.description || 'No description') + '</small><br>' +
                        (extraStr ? '<small style="color:#0056b3;">' + extraStr + '</small><br>' : '') +
                        fileLink + '<br>' +
                        '<em>By: ' + userName + ' (' + userDept + ' - ' + userRole + ')</em>' +
                    '</div>' +
                    actionButtons +
                '</div>';
            });
        }

        async function updateStatus(id, status) {
            try {
                const res = await fetch('/api/requests/' + id + '/status', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status })
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
    </script>
</body>
</html>