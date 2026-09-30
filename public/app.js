
'use strict';

const role=document.body.dataset.role;
const csrf=document.querySelector('meta[name="csrf-token"]').content;
const $=id => document.getElementById(id);
const state={employees:[],departments:[],summary:null,audit:[],org:[],analytics:null,selected:null,tasks:[],timeline:[],page:1,pages:1,total:0};

const api=async (url,options={}) => {
  const response=await fetch(url,{
    ...options,
    headers:{
      ...(options.body ? {'Content-Type':'application/json'} : {}),
      ...(['POST','PATCH','PUT','DELETE'].includes(options.method) ? {'X-CSRF-Token':csrf} : {}),
      ...(options.headers || {})
    }
  });
  const data=response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const error=new Error(data?.error || `Request failed (${response.status})`);
    error.status=response.status; error.data=data; throw error;
  }
  return data;
};

const escapeHtml=value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
let toastTimer;
const toast=message => {
  clearTimeout(toastTimer); $('toast').textContent=message; $('toast').classList.add('show');
  toastTimer=setTimeout(() => $('toast').classList.remove('show'),2400);
};
const money=value => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(value || 0);
const statusLabel=status => status === 'leave' ? 'On leave' : status === 'offboarded' ? 'Offboarded' : 'Active';

function renderStats() {
  const cards=[
    ['Headcount',state.summary?.headcount ?? '—','Current workforce'],
    ['Departments',state.summary?.departments ?? '—','Organizational groups'],
    ['Recent hires',state.summary?.recentHires ?? '—','Last 120 days'],
    ['Open tasks',state.summary?.openTasks ?? '—','Lifecycle work remaining'],
    ['On leave',state.summary?.onLeave ?? '—','Currently on leave']
  ];
  if (role === 'admin') cards.push(['Annual payroll',money(state.summary?.activePayroll),'Admin-only compensation']);
  $('stat-grid').innerHTML=cards.map(([label,value,copy]) => `<article class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(copy)}</small></article>`).join('');
}

function renderBars(targetId,rows=[]) {
  const max=Math.max(1,...rows.map(row => Number(row.value || 0)));
  $(targetId).innerHTML=rows.length ? rows.map(row => `
    <div class="bar-row"><div><strong>${escapeHtml(row.label)}</strong><span>${row.value}</span></div><div class="bar-track"><span style="width:${Math.round((row.value/max)*100)}%"></span></div></div>
  `).join('') : '<div class="empty">No data yet.</div>';
}

function renderEmployees() {
  $('result-count').textContent=`${state.total} employee${state.total === 1 ? '' : 's'}`;
  $('page-label').textContent=`Page ${state.page} of ${state.pages}`;
  $('previous-page-button').disabled=state.page <= 1; $('next-page-button').disabled=state.page >= state.pages;
  $('employee-table-body').innerHTML=state.employees.length ? state.employees.map(employee => `
    <tr>
      <td><div class="person"><span class="avatar small">${escapeHtml(employee.first_name[0] + employee.last_name[0])}</span><div><strong>${escapeHtml(employee.first_name)} ${escapeHtml(employee.last_name)}</strong><small>${escapeHtml(employee.email)}</small></div></div></td>
      <td><strong>${escapeHtml(employee.job_title)}</strong><small>${escapeHtml(employee.location)}</small></td>
      <td>${escapeHtml(employee.department)}</td><td><span class="status ${escapeHtml(employee.status)}">${escapeHtml(statusLabel(employee.status))}</span></td>
      <td><div class="progress"><span style="width:${Math.max(0,Math.min(100,employee.onboarding_progress))}%"></span></div><small>${employee.onboarding_progress}%</small></td>
      <td><button class="row-button" type="button" data-employee-id="${employee.id}">View</button></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty">No employees match these filters.</td></tr>';
}

function renderActivity() {
  if (role === 'viewer') {
    $('activity-panel').innerHTML='<div class="locked-card"><span>VIEWER ROLE</span><strong>Audit history is restricted.</strong><p>Managers and admins can inspect operational changes.</p></div>';
    return;
  }
  $('activity-list').innerHTML=state.audit.length ? state.audit.map(event => `
    <article class="activity-item"><span class="activity-dot"></span><div><strong>${escapeHtml(event.actor_name)} · ${escapeHtml(event.action)}</strong><p>${escapeHtml(event.detail)}</p><small>${new Date(event.created_at + 'Z').toLocaleString()}</small></div></article>
  `).join('') : '<div class="empty">No activity yet.</div>';
}

function renderOrg() {
  const people=new Map(state.org.map(person => [Number(person.id),person]));
  const children=new Map();
  for (const person of state.org) {
    const managerId=Number(person.manager_id || 0);
    if (!managerId || !people.has(managerId) || managerId === Number(person.id)) continue;
    const list=children.get(managerId) || [];
    list.push(person);
    children.set(managerId,list);
  }

  const roots=state.org.filter(person => {
    const managerId=Number(person.manager_id || 0);
    return !managerId || !people.has(managerId) || managerId === Number(person.id);
  });

  const renderNode=(person,depth=0,seen=new Set()) => {
    if (seen.has(Number(person.id))) return '';
    const nextSeen=new Set(seen);
    nextSeen.add(Number(person.id));
    const reports=(children.get(Number(person.id)) || []).sort((a,b) => a.last_name.localeCompare(b.last_name));
    return `
      <article class="org-node depth-${Math.min(depth,3)}">
        <button type="button" class="org-person" data-org-employee-id="${person.id}">
          <span class="avatar small">${escapeHtml(person.first_name[0] + person.last_name[0])}</span>
          <span><strong>${escapeHtml(person.first_name)} ${escapeHtml(person.last_name)}</strong><small>${escapeHtml(person.job_title)} · ${escapeHtml(person.department)}</small></span>
          <em>${reports.length} report${reports.length === 1 ? '' : 's'}</em>
        </button>
        ${reports.length ? '<div class="org-children">' + reports.map(report => renderNode(report,depth+1,nextSeen)).join('') + '</div>' : ''}
      </article>
    `;
  };

  $('org-chart').innerHTML=roots.length
    ? roots.sort((a,b) => a.last_name.localeCompare(b.last_name)).map(person => renderNode(person)).join('')
    : '<div class="empty">No reporting relationships yet.</div>';
}

function renderManagerOptions(employee=null) {
  $('manager-id').innerHTML='<option value="">No manager</option>' + state.org
    .filter(person => person.status !== 'offboarded' && person.id !== employee?.id)
    .map(person => `<option value="${person.id}">${escapeHtml(person.first_name)} ${escapeHtml(person.last_name)} · ${escapeHtml(person.job_title)}</option>`).join('');
  $('manager-id').value=employee?.manager_id ? String(employee.manager_id) : '';
}

function renderTasks() {
  if (!state.selected) return;
  $('task-list').innerHTML=state.tasks.length ? state.tasks.map(task => `
    <article class="task-item ${task.completed_at ? 'complete' : ''}">
      <button type="button" class="task-check" data-task-id="${task.id}" data-task-version="${task.version}" data-task-completed="${task.completed_at ? '1' : '0'}" ${role === 'viewer' ? 'disabled' : ''}>${task.completed_at ? '✓' : ''}</button>
      <div><span>${escapeHtml(task.phase)}</span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.owner_name || 'Unassigned')}${task.due_date ? ' · due ' + escapeHtml(task.due_date) : ''}</small></div>
    </article>
  `).join('') : '<div class="empty">No lifecycle tasks yet.</div>';
}

function renderTimeline() {
  if (!state.selected) return;
  $('timeline-list').innerHTML=state.timeline.length ? state.timeline.map(event => `
    <article class="timeline-item"><span></span><div><strong>${escapeHtml(event.event_type.replaceAll('_',' '))}</strong><p>${escapeHtml(event.detail)}</p><small>${escapeHtml(event.actor_name)} · ${new Date(event.created_at + 'Z').toLocaleString()}</small></div></article>
  `).join('') : '<div class="empty">No timeline events yet.</div>';
}

async function loadData() {
  const params=new URLSearchParams({page:String(state.page),limit:'20',sort:$('sort-filter').value,direction:'asc'});
  const search=$('search-input').value.trim(),department=$('department-filter').value,status=$('status-filter').value;
  if (search) params.set('search',search); if (department) params.set('department',department); if (status) params.set('status',status);
  const requests=[api('/api/summary'),api('/api/employees?' + params.toString()),api('/api/org'),api('/api/analytics')];
  if (role !== 'viewer') requests.push(api('/api/audit'));
  const [summary,directory,org,analytics,audit=[]]=await Promise.all(requests);
  Object.assign(state,{summary,employees:directory.employees,departments:directory.departments,page:directory.pagination.page,pages:directory.pagination.pages,total:directory.pagination.total,org,analytics,audit});
  const previousDepartment=$('department-filter').value;
  $('department-filter').innerHTML='<option value="">All departments</option>' + state.departments.map(name => `<option>${escapeHtml(name)}</option>`).join('');
  $('department-filter').value=previousDepartment;
  renderStats(); renderEmployees(); renderActivity(); renderBars('department-bars',analytics.departments); renderBars('employment-bars',analytics.employmentTypes); renderOrg();
}

async function loadEmployeeDetails(id) {
  const [employee,tasks,timeline]=await Promise.all([api('/api/employees/' + id),api('/api/employees/' + id + '/tasks'),api('/api/employees/' + id + '/timeline')]);
  state.tasks=tasks; state.timeline=timeline; fillEmployee(employee);
}

function employeePayload() {
  const payload={
    first_name:$('first-name').value,last_name:$('last-name').value,email:$('employee-email').value,
    department:$('department').value,job_title:$('job-title').value,location:$('location').value,
    employment_type:$('employment-type').value,status:$('employee-status').value,manager_id:$('manager-id').value || null,
    start_date:$('start-date').value,end_date:$('end-date').value
  };
  if (Number($('employee-id').value || 0)) payload.expected_version=Number($('employee-version').value);
  if (role === 'admin') payload.salary=$('salary').value === '' ? null : Number($('salary').value);
  return payload;
}

function fillEmployee(employee=null) {
  state.selected=employee;
  $('employee-id').value=employee?.id || ''; $('employee-version').value=employee?.version || '';
  $('employee-dialog-title').textContent=employee ? `${employee.first_name} ${employee.last_name}` : 'Add employee';
  $('first-name').value=employee?.first_name || ''; $('last-name').value=employee?.last_name || ''; $('employee-email').value=employee?.email || '';
  $('department').value=employee?.department || ''; $('job-title').value=employee?.job_title || ''; $('location').value=employee?.location || '';
  $('employment-type').value=employee?.employment_type || 'Full-time'; $('employee-status').value=employee?.status || 'active';
  $('start-date').value=employee?.start_date || ''; $('end-date').value=employee?.end_date || ''; $('salary').value=employee?.salary ?? '';
  renderManagerOptions(employee);
  const canEdit=role === 'admin' || role === 'manager';
  $('employee-form').querySelectorAll('.form-grid input,.form-grid select').forEach(input => { input.disabled=!canEdit; });
  $('salary-field').hidden=role !== 'admin'; $('save-employee-button').hidden=!canEdit;
  $('archive-button').hidden=role !== 'admin' || !employee || employee.status === 'offboarded';
  $('employee-detail-grid').hidden=!employee;
  if (employee) { renderTasks(); renderTimeline(); }
  $('employee-dialog').showModal();
}

$('org-chart').addEventListener('click',event => {
  const button=event.target.closest('[data-org-employee-id]');
  if (button) loadEmployeeDetails(Number(button.dataset.orgEmployeeId)).catch(error => toast(error.message));
});

$('employee-table-body').addEventListener('click',event => {
  const button=event.target.closest('[data-employee-id]');
  if (button) loadEmployeeDetails(Number(button.dataset.employeeId)).catch(error => toast(error.message));
});

$('employee-form').addEventListener('submit',async event => {
  event.preventDefault();
  try {
    const id=Number($('employee-id').value || 0);
    const saved=await api(id ? `/api/employees/${id}` : '/api/employees',{method:id ? 'PATCH' : 'POST',body:JSON.stringify(employeePayload())});
    $('employee-dialog').close(); toast(id ? 'Employee updated.' : 'Employee created with onboarding checklist.');
    await loadData();
    if (saved?.id) await loadEmployeeDetails(saved.id);
  } catch (error) {
    if (error.status === 409 && error.data?.current) $('employee-version').value=error.data.current.version;
    toast(error.message);
  }
});

$('archive-button').addEventListener('click',async () => {
  if (!state.selected || !confirm(`Start offboarding for ${state.selected.first_name} ${state.selected.last_name}?`)) return;
  try {
    await api(`/api/employees/${state.selected.id}/archive`,{method:'POST'});
    toast('Offboarding workflow started.'); await loadData(); await loadEmployeeDetails(state.selected.id);
  } catch (error) { toast(error.message); }
});

$('task-list').addEventListener('click',async event => {
  const button=event.target.closest('[data-task-id]');
  if (!button || role === 'viewer') return;
  try {
    await api('/api/tasks/' + button.dataset.taskId,{method:'PATCH',body:JSON.stringify({completed:button.dataset.taskCompleted !== '1',expected_version:Number(button.dataset.taskVersion)})});
    const id=state.selected.id;
    const [employee,tasks,timeline]=await Promise.all([api('/api/employees/' + id),api('/api/employees/' + id + '/tasks'),api('/api/employees/' + id + '/timeline')]);
    state.selected=employee; state.tasks=tasks; state.timeline=timeline; $('employee-version').value=employee.version;
    renderTasks(); renderTimeline(); await loadData();
  } catch (error) { toast(error.message); }
});

$('add-task-button')?.addEventListener('click',async () => {
  const title=$('new-task-title').value.trim();
  if (!state.selected || !title) return toast('Add a task title first.');
  try {
    await api(`/api/employees/${state.selected.id}/tasks`,{method:'POST',body:JSON.stringify({title,phase:$('new-task-phase').value})});
    $('new-task-title').value='';
    state.tasks=await api(`/api/employees/${state.selected.id}/tasks`);
    state.timeline=await api(`/api/employees/${state.selected.id}/timeline`);
    renderTasks(); renderTimeline(); await loadData();
  } catch (error) { toast(error.message); }
});

$('close-dialog-button').addEventListener('click',() => $('employee-dialog').close());
$('cancel-dialog-button').addEventListener('click',() => $('employee-dialog').close());
$('add-employee-button')?.addEventListener('click',() => { state.tasks=[]; state.timeline=[]; fillEmployee(); });

let searchTimer;
$('search-input').addEventListener('input',() => {
  clearTimeout(searchTimer); state.page=1;
  searchTimer=setTimeout(() => loadData().catch(error => toast(error.message)),250);
});
for (const id of ['department-filter','status-filter','sort-filter']) $(id).addEventListener('change',() => { state.page=1; loadData().catch(error => toast(error.message)); });
$('previous-page-button').addEventListener('click',() => { if (state.page > 1) { state.page--; loadData().catch(error => toast(error.message)); } });
$('next-page-button').addEventListener('click',() => { if (state.page < state.pages) { state.page++; loadData().catch(error => toast(error.message)); } });

loadData().catch(error => toast(error.message));
