'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');

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

function ensureDirectory(filename) {
  if (filename === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function createDatabase(filename = ':memory:') {
  ensureDirectory(filename);
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','manager','viewer')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      department TEXT NOT NULL,
      job_title TEXT NOT NULL,
      location TEXT NOT NULL,
      employment_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','leave','offboarded')),
      manager_name TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      salary INTEGER,
      onboarding_progress INTEGER NOT NULL DEFAULT 0 CHECK(onboarding_progress BETWEEN 0 AND 100),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(actor_user_id) REFERENCES users(id)
    ) STRICT;
  `);
  return db;
}

function seedDatabase(db, env = process.env) {
  const userCount = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
  if (userCount === 0) {
    const production = env.NODE_ENV === 'production';
    const credentials = [
      {
        email:'admin@peopleops.local',
        name:'Alex Morgan',
        role:'admin',
        password:env.DEMO_ADMIN_PASSWORD || (production ? null : 'AdminDemo2026!')
      },
      {
        email:'manager@peopleops.local',
        name:'Jordan Lee',
        role:'manager',
        password:env.DEMO_MANAGER_PASSWORD || (production ? null : 'ManagerDemo2026!')
      },
      {
        email:'viewer@peopleops.local',
        name:'Taylor Reed',
        role:'viewer',
        password:env.DEMO_VIEWER_PASSWORD || (production ? null : 'ViewerDemo2026!')
      }
    ];
    if (credentials.some(item => !item.password)) {
      throw new Error('Demo account passwords must be provided through environment variables in production.');
    }
    const insert = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)');
    for (const user of credentials) insert.run(user.email, user.name, user.role, hashPassword(user.password));
  }

  const employeeCount = Number(db.prepare('SELECT COUNT(*) AS count FROM employees').get().count);
  if (employeeCount === 0) {
    const insert = db.prepare(`
      INSERT INTO employees (
        first_name,last_name,email,department,job_title,location,employment_type,status,
        manager_name,start_date,end_date,salary,onboarding_progress
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const employee of SAMPLE_EMPLOYEES) insert.run(...employee);
  }
}

function audit(db, actor, action, entityType, entityId, detail) {
  db.prepare(`
    INSERT INTO audit_events (actor_user_id, actor_name, action, entity_type, entity_id, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actor?.id || null, actor?.name || 'System', action, entityType, entityId || null, detail);
}

module.exports = { createDatabase, seedDatabase, audit, SAMPLE_EMPLOYEES };
