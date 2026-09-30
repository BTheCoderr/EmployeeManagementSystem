
ALTER TABLE employees ADD COLUMN manager_id INTEGER REFERENCES employees(id);
ALTER TABLE employees ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS employee_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  actor_user_id INTEGER,
  actor_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL,
  changes_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY(actor_user_id) REFERENCES users(id)
) STRICT;

CREATE TABLE IF NOT EXISTS lifecycle_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('onboarding','offboarding')),
  title TEXT NOT NULL,
  owner_name TEXT,
  due_date TEXT,
  completed_at TEXT,
  created_by_user_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY(created_by_user_id) REFERENCES users(id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id);
CREATE INDEX IF NOT EXISTS idx_employee_events_employee ON employee_events(employee_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_tasks_employee ON lifecycle_tasks(employee_id, phase);
