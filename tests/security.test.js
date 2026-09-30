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
  const app=createApp({
    db,
    sessionSecret:'security-regression-secret-for-peopleops',
    nodeEnv:options.nodeEnv || 'test',
    env
  });
  const server=app.listen(0);
  await new Promise(resolve => server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;

  async function login(email,password) {
    const response=await fetch(base + '/login',{
      method:'POST',
      redirect:'manual',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({email,password})
    });
    assert.equal(response.status,302);
    const cookie=cookieFrom(response);
    const session=await fetch(base + '/api/session',{headers:{cookie}}).then(r => r.json());
    return {cookie,csrf:session.csrf,user:session.user,setCookie:response.headers.get('set-cookie')};
  }

  return {
    base,db,login,
    request:(route,options={}) => fetch(base + route,options),
    close:() => new Promise(resolve => server.close(resolve))
  };
}

test('unauthenticated API requests are rejected',async t => {
  const h=await createHarness(); t.after(h.close);
  const response=await h.request('/api/employees');
  assert.equal(response.status,401);
  assert.equal((await response.json()).error,'Authentication required.');
});

test('session cookies use HttpOnly and SameSite protections',async t => {
  const h=await createHarness(); t.after(h.close);
  const auth=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  assert.match(auth.setCookie,/HttpOnly/i);
  assert.match(auth.setCookie,/SameSite=Lax/i);
});

test('production session cookies also use Secure',async t => {
  const h=await createHarness({
    nodeEnv:'production',
    env:{
      NODE_ENV:'production',
      DEMO_ADMIN_PASSWORD:'production-admin-test',
      DEMO_MANAGER_PASSWORD:'production-manager-test',
      DEMO_VIEWER_PASSWORD:'production-viewer-test'
    }
  });
  t.after(h.close);
  const auth=await h.login('viewer@peopleops.local','production-viewer-test');
  assert.match(auth.setCookie,/; Secure/i);
});

test('viewer cannot mutate employees even with a valid CSRF token',async t => {
  const h=await createHarness(); t.after(h.close);
  const viewer=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  const response=await h.request('/api/employees/1',{
    method:'PATCH',
    headers:{
      cookie:viewer.cookie,
      'Content-Type':'application/json',
      'X-CSRF-Token':viewer.csrf
    },
    body:JSON.stringify({job_title:'Unauthorized change',expected_version:1})
  });
  assert.equal(response.status,403);
});

test('manager cannot use admin-only offboarding or export routes',async t => {
  const h=await createHarness(); t.after(h.close);
  const manager=await h.login('manager@peopleops.local','ManagerDemo2026!');
  assert.equal((await h.request('/api/employees/1/archive',{
    method:'POST',
    headers:{cookie:manager.cookie,'X-CSRF-Token':manager.csrf}
  })).status,403);
  assert.equal((await h.request('/api/export',{headers:{cookie:manager.cookie}})).status,403);
  assert.equal((await h.request('/api/employees.csv',{headers:{cookie:manager.cookie}})).status,403);
});

test('forged CSRF token is rejected for admin mutation',async t => {
  const h=await createHarness(); t.after(h.close);
  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');
  const response=await h.request('/api/employees/1/archive',{
    method:'POST',
    headers:{cookie:admin.cookie,'X-CSRF-Token':'forged-token'}
  });
  assert.equal(response.status,403);
});

test('security headers omit framework identification and restrict browser capabilities',async t => {
  const h=await createHarness(); t.after(h.close);
  const response=await h.request('/health');
  assert.equal(response.headers.get('x-powered-by'),null);
  assert.equal(response.headers.get('x-frame-options'),'DENY');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.match(response.headers.get('permissions-policy'),/camera=\(\)/);
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});

test('viewer responses never expose salary fields',async t => {
  const h=await createHarness(); t.after(h.close);
  const viewer=await h.login('viewer@peopleops.local','ViewerDemo2026!');
  const response=await h.request('/api/employees',{headers:{cookie:viewer.cookie}});
  const body=await response.json();
  assert.equal(JSON.stringify(body).includes('"salary"'),false);
});

test('backup export does not expose password hashes',async t => {
  const h=await createHarness(); t.after(h.close);
  const admin=await h.login('admin@peopleops.local','AdminDemo2026!');
  const backup=await h.request('/api/export',{headers:{cookie:admin.cookie}}).then(r => r.json());
  assert.equal(JSON.stringify(backup).includes('password_hash'),false);
});
