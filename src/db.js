
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');

const MIGRATIONS_DIR = path.join(__dirname,'..','migrations');

const SAMPLE_EMPLOYEES = [
  ['Avery','Morgan','avery.morgan@example.test','Engineering','Frontend Engineer','Providence, RI','Full-time','active','Jordan Lee','2025-11-04',null,108000,100],
  ['Jordan','Lee','jordan.lee@example.test','Engineering','Engineering Manager','Remote','Full-time','active','Dana Brooks','2024-06-10',null,142000,100],
  ['Mina','Patel','mina.patel@example.test','People','People Operations Specialist','Boston, MA','Full-time','active','Robin Chen','2026-03-02',null,82000,88],
  ['Theo','Grant','theo.grant@example.test','Design','Product Designer','Cambridge, MA','Full-time','leave','Jordan Lee','2025-08-18',null,101000,100],
  ['Nia','Coleman','nia.coleman@example.test','Customer Success','Customer Success Manager','Remote','Full-time','active','Robin Chen','2026-01-12',null,92000,100],
  ['Eli','Santos','eli.santos@example.test','Sales','Account Executive','New York, NY','Full-time','active','Dana Brooks','2026-07-06',null,88000,72],
  ['Samira','Wells','samira.wells@example.test','Finance','Financial Analyst','Boston, MA','Full-time','active','Dana Brooks','2025-09-15',null,94000,100],
  ['Miles','Foster','miles.foster@example.test','Operations','Operations Coordinator','Providence, RI','Contract','offboarded','Robin Chen','2025-02-03','2026-08-28',64000,100]
];

const DEFAULT_ONBOARDING_TASKS = [
  'Complete account and access setup',
  'Review policies and required documents',
  'Meet manager and immediate team',
  'Complete 30-day check-in'
];

const DEFAULT_OFFBOARDING_TASKS = [
  'Recover company equipment',
  'Revoke account and system access',
  'Complete knowledge transfer',
  'Finalize offboarding documentation'
];

function ensureDirectory(filename) {
  if (filename === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true});
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(name => /^\d+_.+\.sql$/.test(name))
    .sort((a,b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
}

function migrateDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);

  const applied=new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => Number(row.version)));
  for (const filename of migrationFiles()) {
    const version=Number(filename.split('_')[0]);
    if (applied.has(version)) continue;
    const sql=fs.readFileSync(path.join(MIGRATIONS_DIR,filename),'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version,name) VALUES (?,?)').run(version,filename);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${filename} failed: ${error.message}`);
    }
  }
}

function createDatabase(filename=':memory:') {
  ensureDirectory(filename);
  const db=new DatabaseSync(filename,{timeout:5000});
  db.exec('PRAGMA foreign_keys = ON;');
  migrateDatabase(db);
  return db;
}

function audit(db,actor,action,entityType,entityId,detail) {
  db.prepare(`
    INSERT INTO audit_events (actor_user_id,actor_name,action,entity_type,entity_id,detail)
    VALUES (?,?,?,?,?,?)
  `).run(actor?.id || null,actor?.name || 'System',action,entityType,entityId || null,detail);
}

function recordEmployeeEvent(db,employeeId,actor,eventType,detail,changes=null) {
  db.prepare(`
    INSERT INTO employee_events (employee_id,actor_user_id,actor_name,event_type,detail,changes_json)
    VALUES (?,?,?,?,?,?)
  `).run(Number(employeeId),actor?.id || null,actor?.name || 'System',eventType,detail,changes ? JSON.stringify(changes) : null);
}

function createDefaultTasks(db,employeeId,phase,actor=null) {
  const tasks=phase === 'offboarding' ? DEFAULT_OFFBOARDING_TASKS : DEFAULT_ONBOARDING_TASKS;
  const existing=Number(db.prepare(
    'SELECT COUNT(*) AS count FROM lifecycle_tasks WHERE employee_id=? AND phase=?'
  ).get(Number(employeeId),phase).count);
  if (existing) return;
  const insert=db.prepare(`
    INSERT INTO lifecycle_tasks (employee_id,phase,title,owner_name,created_by_user_id)
    VALUES (?,?,?,?,?)
  `);
  for (const title of tasks) insert.run(Number(employeeId),phase,title,actor?.name || null,actor?.id || null);
}

function recalculateOnboarding(db,employeeId) {
  const totals=db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
    FROM lifecycle_tasks
    WHERE employee_id=? AND phase='onboarding'
  `).get(Number(employeeId));
  const total=Number(totals.total || 0);
  if (!total) return;
  const progress=Math.round((Number(totals.completed || 0) / total) * 100);
  db.prepare('UPDATE employees SET onboarding_progress=?,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?')
    .run(progress,Number(employeeId));
}

function seedDatabase(db,env=process.env) {
  const userCount=Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
  if (userCount === 0) {
    const production=env.NODE_ENV === 'production';
    const credentials=[
      {email:'admin@peopleops.local',name:'Alex Morgan',role:'admin',password:env.DEMO_ADMIN_PASSWORD || (production ? null : 'AdminDemo2026!')},
      {email:'manager@peopleops.local',name:'Jordan Lee',role:'manager',password:env.DEMO_MANAGER_PASSWORD || (production ? null : 'ManagerDemo2026!')},
      {email:'viewer@peopleops.local',name:'Taylor Reed',role:'viewer',password:env.DEMO_VIEWER_PASSWORD || (production ? null : 'ViewerDemo2026!')}
    ];
    if (credentials.some(item => !item.password)) throw new Error('Demo account passwords must be provided through environment variables in production.');
    const insert=db.prepare('INSERT INTO users (email,name,role,password_hash) VALUES (?,?,?,?)');
    for (const user of credentials) insert.run(user.email,user.name,user.role,hashPassword(user.password));
  }

  const employeeCount=Number(db.prepare('SELECT COUNT(*) AS count FROM employees').get().count);
  if (employeeCount === 0) {
    const insert=db.prepare(`
      INSERT INTO employees (
        first_name,last_name,email,department,job_title,location,employment_type,status,
        manager_name,start_date,end_date,salary,onboarding_progress
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const employee of SAMPLE_EMPLOYEES) {
      const result=insert.run(...employee);
      const id=Number(result.lastInsertRowid);
      recordEmployeeEvent(db,id,null,'created',`Employee record initialized for ${employee[0]} ${employee[1]}`);
    }

    const jordan=db.prepare("SELECT id FROM employees WHERE email='jordan.lee@example.test'").get();
    if (jordan) {
      db.prepare("UPDATE employees SET manager_id=? WHERE email IN ('avery.morgan@example.test','theo.grant@example.test')")
        .run(Number(jordan.id));
    }

    const needsOnboarding=db.prepare(
      "SELECT id,onboarding_progress FROM employees WHERE status != 'offboarded' AND onboarding_progress < 100"
    ).all();
    for (const employee of needsOnboarding) {
      createDefaultTasks(db,employee.id,'onboarding');
      const tasks=db.prepare("SELECT id FROM lifecycle_tasks WHERE employee_id=? AND phase='onboarding' ORDER BY id").all(employee.id);
      const completeCount=Math.round((Number(employee.onboarding_progress) / 100) * tasks.length);
      for (const task of tasks.slice(0,completeCount)) {
        db.prepare("UPDATE lifecycle_tasks SET completed_at=CURRENT_TIMESTAMP WHERE id=?").run(task.id);
      }
    }

    for (const employee of db.prepare("SELECT id FROM employees WHERE status='offboarded'").all()) {
      createDefaultTasks(db,employee.id,'offboarding');
    }
  }
}

module.exports={
  createDatabase,migrateDatabase,seedDatabase,audit,recordEmployeeEvent,
  createDefaultTasks,recalculateOnboarding,SAMPLE_EMPLOYEES
};
