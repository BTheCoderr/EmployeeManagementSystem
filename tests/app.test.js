'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/db');
const { createApp } = require('../server');

function cookieFrom(response) {
  const value = response.headers.get('set-cookie');
  return value ? value.split(';')[0] : '';
}

async function createHarness() {
  const db = createDatabase(':memory:');
  const app = createApp({
    db,
    sessionSecret:'test-secret-that-is-long-enough-for-ci',
    nodeEnv:'test',
    env:{ NODE_ENV:'test' }
  });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function login(email, password) {
    const response = await fetch(base + '/login', {
      method:'POST',
      redirect:'manual',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body:new URLSearchParams({ email, password })
    });
    assert.equal(response.status,302);
    const cookie=cookieFrom(response);
    const session=await fetch(base + '/api/session',{headers:{cookie}}).then(r=>r.json());
    return { cookie, csrf:session.csrf, user:session.user };
  }

  return {
    db, base, login,
    close:() => new Promise(resolve => server.close(resolve)),
    request:(path, options={}) => fetch(base + path, options)
  };
}

test('health endpoint responds without authentication', async t => {
  const h=await createHarness(); t.after(h.close);
  const response=await h.request('/health');
  assert.equal(response.status,200);
  assert.equal((await response.json()).ok,true);
});

test('admin login returns signed session and compensation summary', async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('admin@peopleops.local','AdminDemo2026!');
  assert.equal(auth.user.role,'admin');
  const response=await h.request('/api/summary',{headers:{cookie:auth.cookie}});
  assert.equal(response.status,200);
  const summary=await response.json();
  assert.ok(summary.headcount > 0);
  assert.ok(summary.activePayroll > 0);
});

test('viewer can read directory but cannot create employees or view salaries', async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  const directory=await h.request('/api/employees',{headers:{cookie:auth.cookie}});
  assert.equal(directory.status,200);
  const first=(await directory.json()).employees[0];
  assert.equal(Object.prototype.hasOwnProperty.call(first,'salary'),false);

  const create=await h.request('/api/employees',{
    method:'POST',
    headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({first_name:'Test'})
  });
  assert.equal(create.status,403);
});

test('admin can create an employee and audit event', async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('admin@peopleops.local','AdminDemo2026!');
  const create=await h.request('/api/employees',{
    method:'POST',
    headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({
      first_name:'Riley',last_name:'Quinn',email:'riley.quinn@example.test',department:'Engineering',
      job_title:'QA Engineer',location:'Remote',employment_type:'Full-time',status:'active',
      manager_name:'Jordan Lee',start_date:'2026-10-01',salary:98000,onboarding_progress:10
    })
  });
  assert.equal(create.status,201);
  const employee=await create.json();
  assert.equal(employee.salary,98000);

  const audit=await h.request('/api/audit',{headers:{cookie:auth.cookie}});
  const events=await audit.json();
  assert.ok(events.some(event => event.action === 'create' && Number(event.entity_id) === employee.id));
});

test('manager can update operations fields but cannot change compensation', async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('manager@peopleops.local','ManagerDemo2026!');
  const directory=await h.request('/api/employees',{headers:{cookie:auth.cookie}}).then(r=>r.json());
  const employee=directory.employees[0];

  const denied=await h.request('/api/employees/' + employee.id,{
    method:'PATCH',
    headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({salary:200000})
  });
  assert.equal(denied.status,403);

  const allowed=await h.request('/api/employees/' + employee.id,{
    method:'PATCH',
    headers:{cookie:auth.cookie,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},
    body:JSON.stringify({onboarding_progress:96})
  });
  assert.equal(allowed.status,200);
  assert.equal((await allowed.json()).onboarding_progress,96);
});

test('mutation APIs reject missing CSRF tokens', async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('admin@peopleops.local','AdminDemo2026!');
  const response=await h.request('/api/employees/1/archive',{method:'POST',headers:{cookie:auth.cookie}});
  assert.equal(response.status,403);
});
