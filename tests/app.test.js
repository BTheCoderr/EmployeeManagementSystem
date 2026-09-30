
'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createDatabase}=require('../src/db');
const {createApp}=require('../server');

function cookieFrom(response) {
  const value=response.headers.get('set-cookie');
  return value ? value.split(';')[0] : '';
}

async function createHarness(options={}) {
  const db=createDatabase(':memory:');
  const env=options.env || {NODE_ENV:'test'};
  const app=createApp({db,sessionSecret:'test-secret-that-is-long-enough-for-ci',nodeEnv:options.nodeEnv || 'test',env});
  const server=app.listen(0);
  await new Promise(resolve => server.once('listening',resolve));
  const {port}=server.address(),base=`http://127.0.0.1:${port}`;

  async function login(email,password) {
    const response=await fetch(base + '/login',{
      method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({email,password})
    });
    assert.equal(response.status,302);
    const cookie=cookieFrom(response);
    const session=await fetch(base + '/api/session',{headers:{cookie}}).then(r => r.json());
    return {cookie,csrf:session.csrf,user:session.user};
  }
  return {db,base,login,close:() => new Promise(resolve => server.close(resolve)),request:(route,options={}) => fetch(base + route,options)};
}

test('schema migrations apply to embedded SQLite',() => {
  const db=createDatabase(':memory:');
  const migrations=db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(Array.from(migrations,row => Number(row.version)),[1,2]);
  const columns=db.prepare("PRAGMA table_info('employees')").all().map(row => row.name);
  assert.ok(columns.includes('manager_id')); assert.ok(columns.includes('version'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lifecycle_tasks'").get());
  db.close();
});

test('health reports schema and security headers',async t => {
  const h=await createHarness(); t.after(h.close);
  const response=await h.request('/health'),body=await response.json();
  assert.equal(body.ok,true); assert.equal(body.schemaVersion,2);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.ok(response.headers.get('x-request-id'));
  assert.ok(response.headers.get('content-security-policy').includes("default-src 'self'"));
});

test('admin session exposes compensation summary',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('admin@peopleops.local','AdminDemo2026!');
  assert.equal(auth.user.role,'admin');
  const summary=await h.request('/api/summary',{headers:{cookie:auth.cookie}}).then(r => r.json());
  assert.ok(summary.headcount > 0); assert.ok(summary.activePayroll > 0); assert.ok(summary.openTasks > 0);
});

test('tampered session cookie is rejected',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  assert.equal((await h.request('/api/session',{headers:{cookie:auth.cookie + 'tampered'}})).status,401);
});

test('viewer gets pagination without salary and cannot read audit',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  const response=await h.request('/api/employees?limit=2&page=1&sort=first_name&direction=desc',{headers:{cookie:auth.cookie}});
  const data=await response.json();
  assert.equal(response.status,200); assert.equal(data.employees.length,2); assert.equal(data.pagination.limit,2);
  assert.ok(data.pagination.total >= 8); assert.equal(Object.prototype.hasOwnProperty.call(data.employees[0],'salary'),false);
  assert.equal((await h.request('/api/audit',{headers:{cookie:auth.cookie}})).status,403);
});

test('admin creates employee with manager, tasks, and timeline',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('admin@peopleops.local','AdminDemo2026!');
  const org=await h.request('/api/org',{headers:{cookie:auth.cookie}}).then(r => r.json());
  const manager=org.find(person => person.first_name === 'Jordan');
  const create=await h.request('/api/employees',{
    method:'POST',headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({first_name:'Riley',last_name:'Quinn',email:'riley.quinn@example.test',department:'Engineering',job_title:'QA Engineer',location:'Remote',employment_type:'Full-time',status:'active',manager_id:manager.id,start_date:'2026-10-01',salary:98000})
  });
  assert.equal(create.status,201);
  const employee=await create.json();
  assert.equal(employee.salary,98000); assert.equal(employee.manager_id,manager.id); assert.equal(employee.onboarding_progress,0);
  const tasks=await h.request(`/api/employees/${employee.id}/tasks`,{headers:{cookie:auth.cookie}}).then(r => r.json());
  assert.equal(tasks.length,4);
  const timeline=await h.request(`/api/employees/${employee.id}/timeline`,{headers:{cookie:auth.cookie}}).then(r => r.json());
  assert.ok(timeline.some(event => event.event_type === 'created'));
});

test('completing onboarding task updates progress and timeline',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('admin@peopleops.local','AdminDemo2026!');
  const create=await h.request('/api/employees',{
    method:'POST',headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({first_name:'Kai',last_name:'Stone',email:'kai.stone@example.test',department:'Design',job_title:'Designer',location:'Remote',employment_type:'Full-time',status:'active',start_date:'2026-10-02'})
  });
  const employee=await create.json();
  const tasks=await h.request(`/api/employees/${employee.id}/tasks`,{headers:{cookie:auth.cookie}}).then(r => r.json());
  const task=tasks[0];
  const update=await h.request('/api/tasks/' + task.id,{
    method:'PATCH',headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({completed:true,expected_version:task.version})
  });
  assert.equal(update.status,200);
  const refreshed=await h.request(`/api/employees/${employee.id}`,{headers:{cookie:auth.cookie}}).then(r => r.json());
  assert.equal(refreshed.onboarding_progress,25);
  const timeline=await h.request(`/api/employees/${employee.id}/timeline`,{headers:{cookie:auth.cookie}}).then(r => r.json());
  assert.ok(timeline.some(event => event.event_type === 'task_completed'));
});

test('manager cannot change salary and stale versions conflict',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('manager@peopleops.local','ManagerDemo2026!');
  const directory=await h.request('/api/employees?limit=1',{headers:{cookie:auth.cookie}}).then(r => r.json());
  const employee=directory.employees[0];
  const denied=await h.request('/api/employees/' + employee.id,{
    method:'PATCH',headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({salary:200000,expected_version:employee.version})
  });
  assert.equal(denied.status,403);
  const allowed=await h.request('/api/employees/' + employee.id,{
    method:'PATCH',headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({job_title:'Updated Role',expected_version:employee.version})
  });
  assert.equal(allowed.status,200);
  const conflict=await h.request('/api/employees/' + employee.id,{
    method:'PATCH',headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({job_title:'Stale Role',expected_version:employee.version})
  });
  assert.equal(conflict.status,409);
});

test('admin offboarding creates offboarding checklist',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('admin@peopleops.local','AdminDemo2026!');
  const response=await h.request('/api/employees/1/archive',{method:'POST',headers:{cookie:auth.cookie,'X-CSRF-Token':auth.csrf}});
  assert.equal(response.status,200);
  const tasks=await h.request('/api/employees/1/tasks',{headers:{cookie:auth.cookie}}).then(r => r.json());
  assert.ok(tasks.some(task => task.phase === 'offboarding'));
});

test('mutation APIs reject missing CSRF',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('admin@peopleops.local','AdminDemo2026!');
  assert.equal((await h.request('/api/employees/1/archive',{method:'POST',headers:{cookie:auth.cookie}})).status,403);
});

test('login throttles repeated invalid credentials',async t => {
  const h=await createHarness(); t.after(h.close);
  let response;
  for (let i=0;i<9;i++) response=await h.request('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:'nobody@example.test',password:'bad'})});
  assert.equal(response.status,429);
});

test('production login hides fallback demo credentials',async t => {
  const h=await createHarness({
    nodeEnv:'production',
    env:{NODE_ENV:'production',DEMO_ADMIN_PASSWORD:'production-admin-test',DEMO_MANAGER_PASSWORD:'production-manager-test',DEMO_VIEWER_PASSWORD:'production-viewer-test'}
  });
  t.after(h.close);
  const html=await h.request('/login').then(r => r.text());
  assert.equal(html.includes('AdminDemo2026!'),false); assert.equal(html.includes('Local development demo roles'),false);
});

test('OpenAPI contract is served locally',async t => {
  const h=await createHarness(); t.after(h.close);
  const response=await h.request('/api/openapi.json'),document=await response.json();
  assert.equal(response.status,200); assert.equal(document.openapi,'3.1.0'); assert.ok(document.paths['/api/employees']);
});


test('org endpoint exposes stored manager relationships', async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  const org=await h.request('/api/org',{headers:{cookie:auth.cookie}}).then(r => r.json());
  const jordan=org.find(person => person.first_name === 'Jordan' && person.last_name === 'Lee');
  const avery=org.find(person => person.first_name === 'Avery' && person.last_name === 'Morgan');
  assert.ok(jordan);
  assert.ok(avery);
  assert.equal(Number(avery.manager_id),Number(jordan.id));
});


test('admin backup export is portable and excludes password hashes', async t => {
  const h=await createHarness(); t.after(h.close);
  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');
  const response=await h.request('/api/export',{headers:{cookie:admin.cookie}});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-disposition'),/peopleops-backup-/);
  const backup=await response.json();
  assert.equal(backup.format,'peopleops-backup');
  assert.equal(backup.schema_version,2);
  assert.ok(backup.employees.length >= 8);
  assert.ok(backup.lifecycle_tasks.length > 0);
  assert.ok(backup.users.length >= 3);
  assert.equal(backup.users.some(user => Object.prototype.hasOwnProperty.call(user,'password_hash')),false);
});

test('backup and CSV exports are admin-only', async t => {
  const h=await createHarness(); t.after(h.close);
  const viewer=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  assert.equal((await h.request('/api/export',{headers:{cookie:viewer.cookie}})).status,403);
  assert.equal((await h.request('/api/employees.csv',{headers:{cookie:viewer.cookie}})).status,403);

  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');
  const csv=await h.request('/api/employees.csv',{headers:{cookie:admin.cookie}});
  assert.equal(csv.status,200);
  assert.match(csv.headers.get('content-type'),/^text\/csv/);
  const text=await csv.text();
  assert.ok(text.startsWith('id,first_name,last_name'));
  assert.ok(text.includes('avery.morgan@example.test'));
});


test('employee timeline stores useful diffs while redacting compensation values', async t => {
  const h=await createHarness(); t.after(h.close);
  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');
  const employee=await h.request('/api/employees/1',{headers:{cookie:admin.cookie}}).then(r => r.json());

  const update=await h.request('/api/employees/1',{
    method:'PATCH',
    headers:{cookie:admin.cookie,'Content-Type':'application/json','X-CSRF-Token':admin.csrf},
    body:JSON.stringify({
      job_title:'Principal Frontend Engineer',
      salary:Number(employee.salary || 0) + 5000,
      expected_version:employee.version
    })
  });
  assert.equal(update.status,200);

  const timeline=await h.request('/api/employees/1/timeline',{headers:{cookie:admin.cookie}}).then(r => r.json());
  const event=timeline.find(item => item.event_type === 'updated' && item.changes?.job_title);
  assert.ok(event);
  assert.equal(event.changes.job_title.to,'Principal Frontend Engineer');
  assert.deepEqual(event.changes.salary,{from:'[restricted]',to:'[restricted]'});
  assert.equal(JSON.stringify(event).includes(String(employee.salary)),false);
});


test('backup restore validates before writes and round-trips employee data', async t => {
  const h=await createHarness(); t.after(h.close);
  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');

  const backup=await h.request('/api/export',{headers:{cookie:admin.cookie}}).then(r => r.json());
  backup.employees[0].job_title='Restored Portfolio Role';

  const validation=await h.request('/api/restore/validate',{
    method:'POST',
    headers:{cookie:admin.cookie,'Content-Type':'application/json','X-CSRF-Token':admin.csrf},
    body:JSON.stringify(backup)
  });
  assert.equal(validation.status,200);
  assert.equal((await validation.json()).valid,true);

  const restore=await h.request('/api/restore',{
    method:'POST',
    headers:{cookie:admin.cookie,'Content-Type':'application/json','X-CSRF-Token':admin.csrf},
    body:JSON.stringify(backup)
  });
  assert.equal(restore.status,200);

  const employee=await h.request('/api/employees/' + backup.employees[0].id,{headers:{cookie:admin.cookie}}).then(r => r.json());
  assert.equal(employee.job_title,'Restored Portfolio Role');

  const session=await h.request('/api/session',{headers:{cookie:admin.cookie}});
  assert.equal(session.status,200);
});

test('invalid backup restore is rejected without mutating employee data', async t => {
  const h=await createHarness(); t.after(h.close);
  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');
  const before=await h.request('/api/employees/1',{headers:{cookie:admin.cookie}}).then(r => r.json());

  const invalid={
    format:'peopleops-backup',version:1,schema_version:2,
    employees:[{...before,manager_id:99999}],
    lifecycle_tasks:[],employee_events:[],audit_events:[]
  };
  const response=await h.request('/api/restore',{
    method:'POST',
    headers:{cookie:admin.cookie,'Content-Type':'application/json','X-CSRF-Token':admin.csrf},
    body:JSON.stringify(invalid)
  });
  assert.equal(response.status,400);
  const after=await h.request('/api/employees/1',{headers:{cookie:admin.cookie}}).then(r => r.json());
  assert.equal(after.email,before.email);
  assert.equal(after.job_title,before.job_title);
});

test('backup restore is admin-only', async t => {
  const h=await createHarness(); t.after(h.close);
  const viewer=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  const response=await h.request('/api/restore/validate',{
    method:'POST',
    headers:{cookie:viewer.cookie,'Content-Type':'application/json','X-CSRF-Token':viewer.csrf},
    body:JSON.stringify({})
  });
  assert.equal(response.status,403);
});


test('CSV import previews and transactionally creates employees with manager links', async t => {
  const h=await createHarness(); t.after(h.close);
  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');
  const csv=[
    'first_name,last_name,email,department,job_title,location,employment_type,status,manager_email,start_date,end_date,salary',
    'Morgan,Rivera,morgan.rivera@example.test,Engineering,Staff Engineer,Remote,Full-time,active,jordan.lee@example.test,2026-10-03,,125000',
    'Casey,Nguyen,casey.nguyen@example.test,Engineering,Software Engineer,Providence RI,Full-time,active,morgan.rivera@example.test,2026-10-04,,105000'
  ].join('\n');

  const preview=await h.request('/api/import/csv/validate',{
    method:'POST',
    headers:{cookie:admin.cookie,'Content-Type':'application/json','X-CSRF-Token':admin.csrf},
    body:JSON.stringify({csv})
  });
  assert.equal(preview.status,200);
  const validation=await preview.json();
  assert.deepEqual(validation.summary,{total:2,valid:2,invalid:0});

  const imported=await h.request('/api/import/csv',{
    method:'POST',
    headers:{cookie:admin.cookie,'Content-Type':'application/json','X-CSRF-Token':admin.csrf},
    body:JSON.stringify({csv})
  });
  assert.equal(imported.status,201);
  assert.equal((await imported.json()).imported,2);

  const directory=await h.request('/api/employees?search=casey.nguyen@example.test',{headers:{cookie:admin.cookie}}).then(r => r.json());
  assert.equal(directory.employees.length,1);
  const casey=directory.employees[0];
  const morgan=await h.request('/api/employees?search=morgan.rivera@example.test',{headers:{cookie:admin.cookie}}).then(r => r.json());
  assert.equal(Number(casey.manager_id),Number(morgan.employees[0].id));

  const tasks=await h.request('/api/employees/' + casey.id + '/tasks',{headers:{cookie:admin.cookie}}).then(r => r.json());
  assert.equal(tasks.length,4);
});

test('CSV import rejects invalid or duplicate rows before mutation', async t => {
  const h=await createHarness(); t.after(h.close);
  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');
  const before=await h.request('/api/employees',{headers:{cookie:admin.cookie}}).then(r => r.json());
  const csv=[
    'first_name,last_name,email,department,job_title,location,employment_type,status,start_date',
    'Bad,Row,avery.morgan@example.test,Engineering,Engineer,Remote,Full-time,active,2026-10-03',
    'Also,Bad,not-an-email,Engineering,Engineer,Remote,Full-time,active,2026-10-03'
  ].join('\n');

  const response=await h.request('/api/import/csv',{
    method:'POST',
    headers:{cookie:admin.cookie,'Content-Type':'application/json','X-CSRF-Token':admin.csrf},
    body:JSON.stringify({csv})
  });
  assert.equal(response.status,400);
  const body=await response.json();
  assert.equal(body.summary.invalid,2);

  const after=await h.request('/api/employees',{headers:{cookie:admin.cookie}}).then(r => r.json());
  assert.equal(after.pagination.total,before.pagination.total);
});

test('CSV import is admin-only', async t => {
  const h=await createHarness(); t.after(h.close);
  const viewer=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  const response=await h.request('/api/import/csv/validate',{
    method:'POST',
    headers:{cookie:viewer.cookie,'Content-Type':'application/json','X-CSRF-Token':viewer.csrf},
    body:JSON.stringify({csv:'first_name,last_name\nA,B'})
  });
  assert.equal(response.status,403);
});
