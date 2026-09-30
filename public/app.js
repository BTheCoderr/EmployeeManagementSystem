'use strict';

const role = document.body.dataset.role;
const csrf = document.querySelector('meta[name="csrf-token"]').content;
const $ = id => document.getElementById(id);
const state = { employees:[], departments:[], summary:null, audit:[], selected:null };

const api = async (url, options = {}) => {
  const init = {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type':'application/json' } : {}),
      ...(['POST','PATCH','PUT','DELETE'].includes(options.method) ? { 'X-CSRF-Token':csrf } : {}),
      ...(options.headers || {})
    }
  };
  const response = await fetch(url, init);
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
};

const escapeHtml = value => String(value ?? '')
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

let toastTimer;
const toast = message => {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.add('show');
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200);
};

const money = value => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD', maximumFractionDigits:0 }).format(value || 0);
const statusLabel = status => status === 'leave' ? 'On leave' : status === 'offboarded' ? 'Offboarded' : 'Active';

function renderStats() {
  const cards = [
    ['Headcount', state.summary?.headcount ?? '—', 'Current non-offboarded workforce'],
    ['Departments', state.summary?.departments ?? '—', 'Active organizational groups'],
    ['Recent hires', state.summary?.recentHires ?? '—', 'Started in the last 120 days'],
    ['On leave', state.summary?.onLeave ?? '—', 'Employees currently on leave']
  ];
  if (role === 'admin') cards.push(['Annual payroll', money(state.summary?.activePayroll), 'Visible to administrators only']);
  $('stat-grid').innerHTML = cards.map(([label,value,copy]) =>
    `<article class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(copy)}</small></article>`
  ).join('');
}

function renderEmployees() {
  $('result-count').textContent = `${state.employees.length} employee${state.employees.length === 1 ? '' : 's'}`;
  $('employee-table-body').innerHTML = state.employees.length ? state.employees.map(employee => `
    <tr>
      <td><div class="person"><span class="avatar small">${escapeHtml(employee.first_name[0] + employee.last_name[0])}</span><div><strong>${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)}</strong><small>${escapeHtml(employee.email)}</small></div></div></td>
      <td><strong>${escapeHtml(employee.job_title)}</strong><small>${escapeHtml(employee.location)}</small></td>
      <td>${escapeHtml(employee.department)}</td>
      <td><span class="status ${escapeHtml(employee.status)}">${escapeHtml(statusLabel(employee.status))}</span></td>
      <td><div class="progress"><span style="width:${Math.max(0,Math.min(100,employee.onboarding_progress))}%"></span></div><small>${employee.onboarding_progress}%</small></td>
      <td><button class="row-button" type="button" data-employee-id="${employee.id}">View</button></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty">No employees match these filters.</td></tr>';
}

function renderActivity() {
  if (role === 'viewer') {
    $('activity-panel').innerHTML = '<div class="locked-card"><span>VIEWER ROLE</span><strong>Audit history is restricted.</strong><p>Managers and admins can inspect operational changes.</p></div>';
    return;
  }
  $('activity-list').innerHTML = state.audit.length ? state.audit.map(event => `
    <article class="activity-item">
      <span class="activity-dot"></span>
      <div><strong>${escapeHtml(event.actor_name)} · ${escapeHtml(event.action)}</strong><p>${escapeHtml(event.detail)}</p><small>${new Date(event.created_at + 'Z').toLocaleString()}</small></div>
    </article>
  `).join('') : '<div class="empty">No activity yet.</div>';
}

async function loadData() {
  const params = new URLSearchParams();
  const search = $('search-input').value.trim();
  const department = $('department-filter').value;
  const status = $('status-filter').value;
  if (search) params.set('search', search);
  if (department) params.set('department', department);
  if (status) params.set('status', status);

  const requests = [
    api('/api/summary'),
    api('/api/employees?' + params.toString())
  ];
  if (role !== 'viewer') requests.push(api('/api/audit'));

  const [summary, directory, audit = []] = await Promise.all(requests);
  state.summary = summary;
  state.employees = directory.employees;
  state.departments = directory.departments;
  state.audit = audit;

  const previousDepartment = $('department-filter').value;
  $('department-filter').innerHTML = '<option value="">All departments</option>' + state.departments.map(name => `<option>${escapeHtml(name)}</option>`).join('');
  $('department-filter').value = previousDepartment;
  renderStats();
  renderEmployees();
  renderActivity();
}

function employeePayload() {
  const payload = {
    first_name:$('first-name').value,
    last_name:$('last-name').value,
    email:$('employee-email').value,
    department:$('department').value,
    job_title:$('job-title').value,
    location:$('location').value,
    employment_type:$('employment-type').value,
    status:$('employee-status').value,
    manager_name:$('manager-name').value,
    start_date:$('start-date').value,
    end_date:$('end-date').value,
    onboarding_progress:Number($('onboarding-progress').value || 0)
  };
  if (role === 'admin') payload.salary = $('salary').value === '' ? null : Number($('salary').value);
  return payload;
}

function fillEmployee(employee = null) {
  state.selected = employee;
  $('employee-id').value = employee?.id || '';
  $('employee-dialog-title').textContent = employee ? `${employee.first_name} ${employee.last_name}` : 'Add employee';
  $('first-name').value = employee?.first_name || '';
  $('last-name').value = employee?.last_name || '';
  $('employee-email').value = employee?.email || '';
  $('department').value = employee?.department || '';
  $('job-title').value = employee?.job_title || '';
  $('location').value = employee?.location || '';
  $('employment-type').value = employee?.employment_type || 'Full-time';
  $('employee-status').value = employee?.status || 'active';
  $('manager-name').value = employee?.manager_name || '';
  $('start-date').value = employee?.start_date || '';
  $('end-date').value = employee?.end_date || '';
  $('salary').value = employee?.salary ?? '';
  $('onboarding-progress').value = employee?.onboarding_progress ?? 0;

  const canEdit = role === 'admin' || role === 'manager';
  $('employee-form').querySelectorAll('input,select').forEach(input => {
    if (input.id === 'employee-id') return;
    input.disabled = !canEdit;
  });
  $('salary-field').hidden = role !== 'admin';
  $('save-employee-button').hidden = !canEdit;
  $('archive-button').hidden = role !== 'admin' || !employee || employee.status === 'offboarded';
  $('employee-dialog').showModal();
}

$('employee-table-body').addEventListener('click', event => {
  const button = event.target.closest('[data-employee-id]');
  if (!button) return;
  const employee = state.employees.find(item => item.id === Number(button.dataset.employeeId));
  if (employee) fillEmployee(employee);
});

$('employee-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const id = Number($('employee-id').value || 0);
    await api(id ? `/api/employees/${id}` : '/api/employees', {
      method:id ? 'PATCH' : 'POST',
      body:JSON.stringify(employeePayload())
    });
    $('employee-dialog').close();
    toast(id ? 'Employee updated.' : 'Employee created.');
    await loadData();
  } catch (error) { toast(error.message); }
});

$('archive-button').addEventListener('click', async () => {
  if (!state.selected || !confirm(`Offboard ${state.selected.first_name} ${state.selected.last_name}?`)) return;
  try {
    await api(`/api/employees/${state.selected.id}/archive`, { method:'POST' });
    $('employee-dialog').close();
    toast('Employee offboarded.');
    await loadData();
  } catch (error) { toast(error.message); }
});

$('close-dialog-button').addEventListener('click', () => $('employee-dialog').close());
$('cancel-dialog-button').addEventListener('click', () => $('employee-dialog').close());
$('add-employee-button')?.addEventListener('click', () => fillEmployee());

let searchTimer;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadData().catch(error => toast(error.message)), 250);
});
$('department-filter').addEventListener('change', () => loadData().catch(error => toast(error.message)));
$('status-filter').addEventListener('change', () => loadData().catch(error => toast(error.message)));

loadData().catch(error => toast(error.message));
