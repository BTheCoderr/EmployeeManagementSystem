'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createDatabase, seedDatabase, audit } = require('./src/db');
const {
  COOKIE_NAME,
  verifyPassword,
  createSessionToken,
  readSessionToken,
  parseCookies,
  sessionCookie,
  clearSessionCookie
} = require('./src/security');

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_DB = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'peopleops.sqlite');

function createApp(options = {}) {
  const app = express();
  const db = options.db || createDatabase(options.dbPath || DEFAULT_DB);
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const isProduction = (options.nodeEnv || process.env.NODE_ENV) === 'production';
  const loginAttempts = new Map();

  seedDatabase(db, options.env || process.env);

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(express.json({ limit: '50kb' }));
  app.use('/assets', express.static(path.join(__dirname, 'public'), {
    maxAge: isProduction ? '1h' : 0,
    etag: true
  }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "style-src 'self'",
      "script-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'"
    ].join('; '));

    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    const session = readSessionToken(token, sessionSecret);
    req.session = session;
    req.user = null;
    if (session) {
      req.user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(session.uid) || null;
    }
    res.locals.user = req.user;
    res.locals.csrf = session?.csrf || '';
    next();
  });

  const requireAuth = (req, res, next) => {
    if (req.user) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error:'Authentication required.' });
    return res.redirect('/login');
  };

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error:'Authentication required.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error:'You do not have permission for this action.' });
    next();
  };

  const requireCsrf = (req, res, next) => {
    if (!req.session || req.get('x-csrf-token') !== req.session.csrf) {
      return res.status(403).json({ error:'Invalid or missing CSRF token.' });
    }
    next();
  };

  const safeText = (value, max = 120) => String(value ?? '').trim().slice(0, max);
  const allowedStatuses = new Set(['active','leave','offboarded']);
  const allowedEmployment = new Set(['Full-time','Part-time','Contract','Intern']);

  const serializeEmployee = (row, role) => {
    if (!row) return null;
    const employee = { ...row };
    if (role !== 'admin') delete employee.salary;
    return employee;
  };

  const getEmployee = id => db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(id));

  app.get('/health', (req, res) => res.json({ ok:true, service:'peopleops-console' }));

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('login', { error:null });
  });

  app.post('/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(ip) || { count:0, resetAt:now + 60_000 };
    if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 60_000; }
    if (attempt.count >= 8) {
      loginAttempts.set(ip, attempt);
      return res.status(429).render('login', { error:'Too many login attempts. Try again in a minute.' });
    }

    const email = safeText(req.body.email, 180).toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      attempt.count += 1;
      loginAttempts.set(ip, attempt);
      return res.status(401).render('login', { error:'Invalid email or password.' });
    }

    loginAttempts.delete(ip);
    const token = createSessionToken(user, sessionSecret);
    res.setHeader('Set-Cookie', sessionCookie(token, isProduction));
    audit(db, user, 'login', 'session', null, 'Signed in to PeopleOps Console');
    res.redirect('/');
  });

  app.post('/logout', requireAuth, (req, res) => {
    if (req.body.csrf !== req.session.csrf) return res.status(403).send('Invalid CSRF token.');
    audit(db, req.user, 'logout', 'session', null, 'Signed out of PeopleOps Console');
    res.setHeader('Set-Cookie', clearSessionCookie(isProduction));
    res.redirect('/login');
  });

  app.get('/', requireAuth, (req, res) => {
    res.render('dashboard', { user:req.user, csrf:req.session.csrf });
  });

  app.get('/api/session', requireAuth, (req, res) => {
    res.json({ user:req.user, csrf:req.session.csrf });
  });

  app.get('/api/summary', requireAuth, (req, res) => {
    const headcount = Number(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE status != 'offboarded'").get().count);
    const onLeave = Number(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE status = 'leave'").get().count);
    const departments = Number(db.prepare("SELECT COUNT(DISTINCT department) AS count FROM employees WHERE status != 'offboarded'").get().count);
    const recentHires = Number(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE start_date >= date('now','-120 day')").get().count);
    const summary = { headcount, onLeave, departments, recentHires };
    if (req.user.role === 'admin') {
      summary.activePayroll = Number(db.prepare("SELECT COALESCE(SUM(salary),0) AS total FROM employees WHERE status != 'offboarded'").get().total);
    }
    res.json(summary);
  });

  app.get('/api/employees', requireAuth, (req, res) => {
    const search = safeText(req.query.search, 80);
    const department = safeText(req.query.department, 60);
    const status = safeText(req.query.status, 30);
    const clauses = [];
    const params = [];

    if (search) {
      clauses.push("(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR job_title LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (department) { clauses.push('department = ?'); params.push(department); }
    if (status && allowedStatuses.has(status)) { clauses.push('status = ?'); params.push(status); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM employees ${where} ORDER BY last_name, first_name`).all(...params);
    res.json({
      employees: rows.map(row => serializeEmployee(row, req.user.role)),
      departments: db.prepare('SELECT DISTINCT department FROM employees ORDER BY department').all().map(row => row.department)
    });
  });

  app.get('/api/employees/:id', requireAuth, (req, res) => {
    const row = getEmployee(req.params.id);
    if (!row) return res.status(404).json({ error:'Employee not found.' });
    res.json(serializeEmployee(row, req.user.role));
  });

  app.post('/api/employees', requireAuth, requireRole('admin'), requireCsrf, (req, res) => {
    const body = req.body || {};
    const employee = {
      first_name:safeText(body.first_name, 60),
      last_name:safeText(body.last_name, 60),
      email:safeText(body.email, 180).toLowerCase(),
      department:safeText(body.department, 80),
      job_title:safeText(body.job_title, 100),
      location:safeText(body.location, 100),
      employment_type:allowedEmployment.has(body.employment_type) ? body.employment_type : 'Full-time',
      status:allowedStatuses.has(body.status) ? body.status : 'active',
      manager_name:safeText(body.manager_name, 120) || null,
      start_date:safeText(body.start_date, 20),
      end_date:safeText(body.end_date, 20) || null,
      salary:Number.isFinite(Number(body.salary)) ? Math.max(0, Math.round(Number(body.salary))) : null,
      onboarding_progress:Math.max(0, Math.min(100, Number(body.onboarding_progress) || 0))
    };
    if (!employee.first_name || !employee.last_name || !employee.email || !employee.department || !employee.job_title || !employee.location || !employee.start_date) {
      return res.status(400).json({ error:'First name, last name, email, department, job title, location, and start date are required.' });
    }

    try {
      const result = db.prepare(`
        INSERT INTO employees (
          first_name,last_name,email,department,job_title,location,employment_type,status,
          manager_name,start_date,end_date,salary,onboarding_progress
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        employee.first_name,employee.last_name,employee.email,employee.department,employee.job_title,
        employee.location,employee.employment_type,employee.status,employee.manager_name,
        employee.start_date,employee.end_date,employee.salary,employee.onboarding_progress
      );
      const id = Number(result.lastInsertRowid);
      audit(db, req.user, 'create', 'employee', id, `Created ${employee.first_name} ${employee.last_name}`);
      res.status(201).json(serializeEmployee(getEmployee(id), req.user.role));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error:'An employee with that email already exists.' });
      throw error;
    }
  });

  app.patch('/api/employees/:id', requireAuth, requireRole('admin','manager'), requireCsrf, (req, res) => {
    const existing = getEmployee(req.params.id);
    if (!existing) return res.status(404).json({ error:'Employee not found.' });
    if (req.user.role !== 'admin' && Object.prototype.hasOwnProperty.call(req.body || {}, 'salary')) {
      return res.status(403).json({ error:'Only admins can change compensation.' });
    }

    const editable = ['first_name','last_name','email','department','job_title','location','employment_type','status','manager_name','start_date','end_date','onboarding_progress'];
    if (req.user.role === 'admin') editable.push('salary');

    const next = { ...existing };
    for (const field of editable) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, field)) continue;
      if (field === 'salary') next.salary = Number.isFinite(Number(req.body[field])) ? Math.max(0, Math.round(Number(req.body[field]))) : null;
      else if (field === 'onboarding_progress') next.onboarding_progress = Math.max(0, Math.min(100, Number(req.body[field]) || 0));
      else if (field === 'status') next.status = allowedStatuses.has(req.body[field]) ? req.body[field] : next.status;
      else if (field === 'employment_type') next.employment_type = allowedEmployment.has(req.body[field]) ? req.body[field] : next.employment_type;
      else if (field === 'email') next.email = safeText(req.body[field], 180).toLowerCase();
      else next[field] = safeText(req.body[field], field === 'job_title' ? 100 : 120) || (['manager_name','end_date'].includes(field) ? null : next[field]);
    }

    db.prepare(`
      UPDATE employees SET
        first_name=?, last_name=?, email=?, department=?, job_title=?, location=?, employment_type=?,
        status=?, manager_name=?, start_date=?, end_date=?, salary=?, onboarding_progress=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      next.first_name,next.last_name,next.email,next.department,next.job_title,next.location,next.employment_type,
      next.status,next.manager_name,next.start_date,next.end_date,next.salary,next.onboarding_progress,existing.id
    );
    audit(db, req.user, 'update', 'employee', existing.id, `Updated ${next.first_name} ${next.last_name}`);
    res.json(serializeEmployee(getEmployee(existing.id), req.user.role));
  });

  app.post('/api/employees/:id/archive', requireAuth, requireRole('admin'), requireCsrf, (req, res) => {
    const existing = getEmployee(req.params.id);
    if (!existing) return res.status(404).json({ error:'Employee not found.' });
    db.prepare("UPDATE employees SET status='offboarded', end_date=COALESCE(end_date,date('now')), updated_at=CURRENT_TIMESTAMP WHERE id=?").run(existing.id);
    audit(db, req.user, 'archive', 'employee', existing.id, `Offboarded ${existing.first_name} ${existing.last_name}`);
    res.json(serializeEmployee(getEmployee(existing.id), req.user.role));
  });

  app.get('/api/audit', requireAuth, requireRole('admin','manager'), (req, res) => {
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 50').all();
    res.json(rows);
  });

  app.use('/api', (req, res) => res.status(404).json({ error:'API route not found.' }));
  app.use((req, res) => res.status(404).send('Not found'));
  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    if (req.path.startsWith('/api/')) return res.status(500).json({ error:'Unexpected server error.' });
    res.status(500).send('Unexpected server error.');
  });

  app.locals.db = db;
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`PeopleOps Console running at http://localhost:${PORT}`);
    if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set; sessions will reset when the server restarts.');
    if (process.env.NODE_ENV !== 'production') {
      console.log('Local demo accounts: admin@peopleops.local / AdminDemo2026!, manager@peopleops.local / ManagerDemo2026!, viewer@peopleops.local / ViewerDemo2026!');
    }
  });
}

module.exports = { createApp };
