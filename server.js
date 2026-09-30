
'use strict';

const path=require('node:path');
const crypto=require('node:crypto');
const express=require('express');
const {
  createDatabase,seedDatabase,audit,recordEmployeeEvent,createDefaultTasks,recalculateOnboarding
}=require('./src/db');
const {
  COOKIE_NAME,verifyPassword,createSessionToken,readSessionToken,parseCookies,sessionCookie,clearSessionCookie
}=require('./src/security');

const PORT=Number(process.env.PORT || 3000);
const DEFAULT_DB=process.env.DATABASE_PATH || path.join(__dirname,'data','peopleops.sqlite');
const OPENAPI_PATH=path.join(__dirname,'docs','openapi.json');

function createApp(options={}) {
  const app=express();
  const runtimeEnv=options.env || process.env;
  const db=options.db || createDatabase(options.dbPath || DEFAULT_DB);
  const sessionSecret=options.sessionSecret || runtimeEnv.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const isProduction=(options.nodeEnv || runtimeEnv.NODE_ENV) === 'production';
  const demoMode=!isProduction && !runtimeEnv.DEMO_ADMIN_PASSWORD && !runtimeEnv.DEMO_MANAGER_PASSWORD && !runtimeEnv.DEMO_VIEWER_PASSWORD;
  const loginAttempts=new Map();

  seedDatabase(db,runtimeEnv);

  app.disable('x-powered-by');
  app.set('view engine','ejs');
  app.set('views',path.join(__dirname,'views'));
  app.use(express.urlencoded({extended:false,limit:'50kb'}));
  app.use(express.json({limit:'100kb'}));
  app.use('/assets',express.static(path.join(__dirname,'public'),{maxAge:isProduction ? '1h' : 0,etag:true}));

  app.use((req,res,next) => {
    req.requestId=req.get('x-request-id')?.slice(0,80) || crypto.randomUUID();
    res.setHeader('X-Request-ID',req.requestId);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',[
      "default-src 'self'","style-src 'self'","script-src 'self'","img-src 'self' data:",
      "connect-src 'self'","base-uri 'none'","frame-ancestors 'none'","form-action 'self'"
    ].join('; '));

    const token=parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    req.session=readSessionToken(token,sessionSecret);
    req.user=req.session ? db.prepare('SELECT id,email,name,role FROM users WHERE id=?').get(req.session.uid) || null : null;
    res.locals.user=req.user;
    res.locals.csrf=req.session?.csrf || '';
    next();
  });

  const requireAuth=(req,res,next) => {
    if (req.user) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({error:'Authentication required.',requestId:req.requestId});
    return res.redirect('/login');
  };
  const requireRole=(...roles) => (req,res,next) => {
    if (!req.user) return res.status(401).json({error:'Authentication required.',requestId:req.requestId});
    if (!roles.includes(req.user.role)) return res.status(403).json({error:'You do not have permission for this action.',requestId:req.requestId});
    next();
  };
  const requireCsrf=(req,res,next) => {
    if (!req.session || req.get('x-csrf-token') !== req.session.csrf) {
      return res.status(403).json({error:'Invalid or missing CSRF token.',requestId:req.requestId});
    }
    next();
  };

  const safeText=(value,max=120) => String(value ?? '').trim().slice(0,max);
  const allowedStatuses=new Set(['active','leave','offboarded']);
  const allowedEmployment=new Set(['Full-time','Part-time','Contract','Intern']);
  const sortColumns=new Map([
    ['last_name','last_name'],['first_name','first_name'],['department','department'],
    ['job_title','job_title'],['start_date','start_date'],['status','status']
  ]);

  const serializeEmployee=(row,role) => {
    if (!row) return null;
    const employee={...row};
    if (role !== 'admin') delete employee.salary;
    return employee;
  };
  const getEmployee=id => db.prepare('SELECT * FROM employees WHERE id=?').get(Number(id));
  const getManager=managerId => {
    const id=Number(managerId || 0);
    if (!id) return null;
    return db.prepare("SELECT id,first_name,last_name FROM employees WHERE id=? AND status!='offboarded'").get(id) || null;
  };
  const sanitizedChanges=(before,after,fields) => {
    const changes={};
    for (const field of fields) {
      if (String(before[field] ?? '') === String(after[field] ?? '')) continue;
      changes[field]=field === 'salary'
        ? {from:'[restricted]',to:'[restricted]'}
        : {from:before[field] ?? null,to:after[field] ?? null};
    }
    return changes;
  };

  app.get('/health',(req,res) => {
    const version=Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0);
    res.json({ok:true,service:'peopleops-console',schemaVersion:version});
  });
  app.get('/docs',(req,res) => res.render('docs'));
  app.get('/api/openapi.json',(req,res) => res.sendFile(OPENAPI_PATH));

  app.get('/login',(req,res) => {
    if (req.user) return res.redirect('/');
    res.render('login',{error:null,demoMode});
  });
  app.post('/login',(req,res) => {
    const ip=req.ip || req.socket.remoteAddress || 'unknown';
    const now=Date.now();
    const attempt=loginAttempts.get(ip) || {count:0,resetAt:now + 60_000};
    if (attempt.resetAt <= now) { attempt.count=0; attempt.resetAt=now + 60_000; }
    if (attempt.count >= 8) {
      loginAttempts.set(ip,attempt);
      return res.status(429).render('login',{error:'Too many login attempts. Try again in a minute.',demoMode});
    }

    const email=safeText(req.body.email,180).toLowerCase();
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !verifyPassword(String(req.body.password || ''),user.password_hash)) {
      attempt.count += 1;
      loginAttempts.set(ip,attempt);
      return res.status(401).render('login',{error:'Invalid email or password.',demoMode});
    }

    loginAttempts.delete(ip);
    res.setHeader('Set-Cookie',sessionCookie(createSessionToken(user,sessionSecret),isProduction));
    audit(db,user,'login','session',null,'Signed in to PeopleOps Console');
    res.redirect('/');
  });

  app.post('/logout',requireAuth,(req,res) => {
    if (req.body.csrf !== req.session.csrf) return res.status(403).send('Invalid CSRF token.');
    audit(db,req.user,'logout','session',null,'Signed out of PeopleOps Console');
    res.setHeader('Set-Cookie',clearSessionCookie(isProduction));
    res.redirect('/login');
  });

  app.get('/',requireAuth,(req,res) => res.render('dashboard',{user:req.user,csrf:req.session.csrf}));
  app.get('/api/session',requireAuth,(req,res) => res.json({user:req.user,csrf:req.session.csrf}));

  app.get('/api/summary',requireAuth,(req,res) => {
    const summary={
      headcount:Number(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE status!='offboarded'").get().count),
      onLeave:Number(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE status='leave'").get().count),
      departments:Number(db.prepare("SELECT COUNT(DISTINCT department) AS count FROM employees WHERE status!='offboarded'").get().count),
      recentHires:Number(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE start_date>=date('now','-120 day')").get().count),
      openTasks:Number(db.prepare("SELECT COUNT(*) AS count FROM lifecycle_tasks WHERE completed_at IS NULL").get().count)
    };
    if (req.user.role === 'admin') {
      summary.activePayroll=Number(db.prepare("SELECT COALESCE(SUM(salary),0) AS total FROM employees WHERE status!='offboarded'").get().total);
    }
    res.json(summary);
  });

  app.get('/api/analytics',requireAuth,(req,res) => {
    res.json({
      departments:db.prepare("SELECT department AS label,COUNT(*) AS value FROM employees WHERE status!='offboarded' GROUP BY department ORDER BY value DESC,department").all(),
      employmentTypes:db.prepare("SELECT employment_type AS label,COUNT(*) AS value FROM employees WHERE status!='offboarded' GROUP BY employment_type ORDER BY value DESC,employment_type").all(),
      statuses:db.prepare("SELECT status AS label,COUNT(*) AS value FROM employees GROUP BY status ORDER BY value DESC").all()
    });
  });

  app.get('/api/org',requireAuth,(req,res) => {
    res.json(db.prepare(
      'SELECT id,first_name,last_name,job_title,department,status,manager_id,manager_name FROM employees ORDER BY last_name,first_name'
    ).all());
  });

  app.get('/api/employees',requireAuth,(req,res) => {
    const search=safeText(req.query.search,80);
    const department=safeText(req.query.department,60);
    const status=safeText(req.query.status,30);
    const page=Math.max(1,Number.parseInt(req.query.page,10) || 1);
    const limit=Math.max(1,Math.min(100,Number.parseInt(req.query.limit,10) || 20));
    const sort=sortColumns.get(safeText(req.query.sort,30)) || 'last_name';
    const direction=String(req.query.direction || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const clauses=[],params=[];

    if (search) {
      clauses.push('(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR job_title LIKE ?)');
      const like=`%${search}%`;
      params.push(like,like,like,like);
    }
    if (department) { clauses.push('department=?'); params.push(department); }
    if (status && allowedStatuses.has(status)) { clauses.push('status=?'); params.push(status); }

    const where=clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total=Number(db.prepare(`SELECT COUNT(*) AS count FROM employees ${where}`).get(...params).count);
    const rows=db.prepare(
      `SELECT * FROM employees ${where} ORDER BY ${sort} ${direction},id ASC LIMIT ? OFFSET ?`
    ).all(...params,limit,(page - 1) * limit);

    res.json({
      employees:rows.map(row => serializeEmployee(row,req.user.role)),
      departments:db.prepare('SELECT DISTINCT department FROM employees ORDER BY department').all().map(row => row.department),
      pagination:{page,limit,total,pages:Math.max(1,Math.ceil(total / limit))},
      sort:{field:sort,direction:direction.toLowerCase()}
    });
  });

  app.get('/api/employees/:id',requireAuth,(req,res) => {
    const row=getEmployee(req.params.id);
    if (!row) return res.status(404).json({error:'Employee not found.',requestId:req.requestId});
    res.json(serializeEmployee(row,req.user.role));
  });

  app.get('/api/employees/:id/timeline',requireAuth,(req,res) => {
    if (!getEmployee(req.params.id)) return res.status(404).json({error:'Employee not found.',requestId:req.requestId});
    res.json(db.prepare('SELECT * FROM employee_events WHERE employee_id=? ORDER BY id DESC LIMIT 100')
      .all(Number(req.params.id)).map(row => ({
        ...row,
        changes:row.changes_json ? JSON.parse(row.changes_json) : null,
        changes_json:undefined
      })));
  });

  app.get('/api/employees/:id/tasks',requireAuth,(req,res) => {
    if (!getEmployee(req.params.id)) return res.status(404).json({error:'Employee not found.',requestId:req.requestId});
    res.json(db.prepare(
      "SELECT * FROM lifecycle_tasks WHERE employee_id=? ORDER BY CASE phase WHEN 'onboarding' THEN 0 ELSE 1 END,completed_at IS NOT NULL,id"
    ).all(Number(req.params.id)));
  });

  app.post('/api/employees',requireAuth,requireRole('admin'),requireCsrf,(req,res) => {
    const body=req.body || {};
    const manager=getManager(body.manager_id);
    const employee={
      first_name:safeText(body.first_name,60),
      last_name:safeText(body.last_name,60),
      email:safeText(body.email,180).toLowerCase(),
      department:safeText(body.department,80),
      job_title:safeText(body.job_title,100),
      location:safeText(body.location,100),
      employment_type:allowedEmployment.has(body.employment_type) ? body.employment_type : 'Full-time',
      status:allowedStatuses.has(body.status) ? body.status : 'active',
      manager_id:manager ? Number(manager.id) : null,
      manager_name:manager ? `${manager.first_name} ${manager.last_name}` : null,
      start_date:safeText(body.start_date,20),
      end_date:safeText(body.end_date,20) || null,
      salary:Number.isFinite(Number(body.salary)) ? Math.max(0,Math.round(Number(body.salary))) : null
    };
    if (!employee.first_name || !employee.last_name || !employee.email || !employee.department || !employee.job_title || !employee.location || !employee.start_date) {
      return res.status(400).json({error:'First name, last name, email, department, job title, location, and start date are required.',requestId:req.requestId});
    }

    try {
      const result=db.prepare(`
        INSERT INTO employees (
          first_name,last_name,email,department,job_title,location,employment_type,status,
          manager_name,manager_id,start_date,end_date,salary,onboarding_progress
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)
      `).run(
        employee.first_name,employee.last_name,employee.email,employee.department,employee.job_title,
        employee.location,employee.employment_type,employee.status,employee.manager_name,employee.manager_id,
        employee.start_date,employee.end_date,employee.salary
      );
      const id=Number(result.lastInsertRowid);
      createDefaultTasks(db,id,employee.status === 'offboarded' ? 'offboarding' : 'onboarding',req.user);
      audit(db,req.user,'create','employee',id,`Created ${employee.first_name} ${employee.last_name}`);
      recordEmployeeEvent(db,id,req.user,'created',`Employee record created for ${employee.first_name} ${employee.last_name}`);
      res.status(201).json(serializeEmployee(getEmployee(id),req.user.role));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return res.status(409).json({error:'An employee with that email already exists.',requestId:req.requestId});
      throw error;
    }
  });

  app.patch('/api/employees/:id',requireAuth,requireRole('admin','manager'),requireCsrf,(req,res) => {
    const existing=getEmployee(req.params.id);
    if (!existing) return res.status(404).json({error:'Employee not found.',requestId:req.requestId});
    const expectedVersion=Number(req.body?.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(existing.version)) {
      return res.status(409).json({
        error:'This employee changed since you opened the record. Refresh before saving.',
        current:serializeEmployee(existing,req.user.role),
        requestId:req.requestId
      });
    }
    if (req.user.role !== 'admin' && Object.prototype.hasOwnProperty.call(req.body || {},'salary')) {
      return res.status(403).json({error:'Only admins can change compensation.',requestId:req.requestId});
    }

    const editable=['first_name','last_name','email','department','job_title','location','employment_type','status','manager_id','start_date','end_date'];
    if (req.user.role === 'admin') editable.push('salary');
    const next={...existing};

    for (const field of editable) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {},field)) continue;
      if (field === 'salary') next.salary=Number.isFinite(Number(req.body[field])) ? Math.max(0,Math.round(Number(req.body[field]))) : null;
      else if (field === 'status') next.status=allowedStatuses.has(req.body[field]) ? req.body[field] : next.status;
      else if (field === 'employment_type') next.employment_type=allowedEmployment.has(req.body[field]) ? req.body[field] : next.employment_type;
      else if (field === 'email') next.email=safeText(req.body[field],180).toLowerCase();
      else if (field === 'manager_id') {
        const manager=getManager(req.body[field]);
        if (manager && Number(manager.id) === Number(existing.id)) return res.status(400).json({error:'An employee cannot manage themselves.',requestId:req.requestId});
        next.manager_id=manager ? Number(manager.id) : null;
        next.manager_name=manager ? `${manager.first_name} ${manager.last_name}` : null;
      } else next[field]=safeText(req.body[field],field === 'job_title' ? 100 : 120) || (field === 'end_date' ? null : next[field]);
    }

    const changes=sanitizedChanges(existing,next,[...editable,'manager_name']);
    if (!Object.keys(changes).length) return res.json(serializeEmployee(existing,req.user.role));

    const result=db.prepare(`
      UPDATE employees SET
        first_name=?,last_name=?,email=?,department=?,job_title=?,location=?,employment_type=?,
        status=?,manager_name=?,manager_id=?,start_date=?,end_date=?,salary=?,
        updated_at=CURRENT_TIMESTAMP,version=version+1
      WHERE id=? AND version=?
    `).run(
      next.first_name,next.last_name,next.email,next.department,next.job_title,next.location,next.employment_type,
      next.status,next.manager_name,next.manager_id,next.start_date,next.end_date,next.salary,existing.id,expectedVersion
    );
    if (!Number(result.changes)) return res.status(409).json({error:'The record was updated by someone else. Refresh and retry.',requestId:req.requestId});

    if (existing.status !== 'offboarded' && next.status === 'offboarded') createDefaultTasks(db,existing.id,'offboarding',req.user);
    audit(db,req.user,'update','employee',existing.id,`Updated ${next.first_name} ${next.last_name}`);
    recordEmployeeEvent(db,existing.id,req.user,'updated',`Updated ${next.first_name} ${next.last_name}`,changes);
    res.json(serializeEmployee(getEmployee(existing.id),req.user.role));
  });

  app.post('/api/employees/:id/archive',requireAuth,requireRole('admin'),requireCsrf,(req,res) => {
    const existing=getEmployee(req.params.id);
    if (!existing) return res.status(404).json({error:'Employee not found.',requestId:req.requestId});
    db.prepare("UPDATE employees SET status='offboarded',end_date=COALESCE(end_date,date('now')),updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?").run(existing.id);
    createDefaultTasks(db,existing.id,'offboarding',req.user);
    audit(db,req.user,'archive','employee',existing.id,`Offboarded ${existing.first_name} ${existing.last_name}`);
    recordEmployeeEvent(db,existing.id,req.user,'offboarded',`Offboarding started for ${existing.first_name} ${existing.last_name}`);
    res.json(serializeEmployee(getEmployee(existing.id),req.user.role));
  });

  app.post('/api/employees/:id/tasks',requireAuth,requireRole('admin','manager'),requireCsrf,(req,res) => {
    const employee=getEmployee(req.params.id);
    if (!employee) return res.status(404).json({error:'Employee not found.',requestId:req.requestId});
    const phase=req.body?.phase === 'offboarding' ? 'offboarding' : 'onboarding';
    const title=safeText(req.body?.title,180);
    const ownerName=safeText(req.body?.owner_name,120) || req.user.name;
    const dueDate=safeText(req.body?.due_date,20) || null;
    if (!title) return res.status(400).json({error:'Task title is required.',requestId:req.requestId});

    const result=db.prepare(`
      INSERT INTO lifecycle_tasks (employee_id,phase,title,owner_name,due_date,created_by_user_id)
      VALUES (?,?,?,?,?,?)
    `).run(employee.id,phase,title,ownerName,dueDate,req.user.id);
    const id=Number(result.lastInsertRowid);
    audit(db,req.user,'create','task',id,`Added ${phase} task for ${employee.first_name} ${employee.last_name}`);
    recordEmployeeEvent(db,employee.id,req.user,'task_added',`Added ${phase} task: ${title}`);
    res.status(201).json(db.prepare('SELECT * FROM lifecycle_tasks WHERE id=?').get(id));
  });

  app.patch('/api/tasks/:id',requireAuth,requireRole('admin','manager'),requireCsrf,(req,res) => {
    const task=db.prepare('SELECT * FROM lifecycle_tasks WHERE id=?').get(Number(req.params.id));
    if (!task) return res.status(404).json({error:'Task not found.',requestId:req.requestId});
    const expectedVersion=Number(req.body?.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(task.version)) {
      return res.status(409).json({error:'This task changed since you opened it.',requestId:req.requestId});
    }

    const completed=Boolean(req.body?.completed);
    const result=db.prepare(`
      UPDATE lifecycle_tasks
      SET completed_at=?,updated_at=CURRENT_TIMESTAMP,version=version+1
      WHERE id=? AND version=?
    `).run(completed ? new Date().toISOString() : null,task.id,expectedVersion);
    if (!Number(result.changes)) return res.status(409).json({error:'The task was updated by someone else.',requestId:req.requestId});
    if (task.phase === 'onboarding') recalculateOnboarding(db,task.employee_id);

    const employee=getEmployee(task.employee_id);
    audit(db,req.user,completed ? 'complete' : 'reopen','task',task.id,`${completed ? 'Completed' : 'Reopened'} task for ${employee.first_name} ${employee.last_name}`);
    recordEmployeeEvent(db,task.employee_id,req.user,completed ? 'task_completed' : 'task_reopened',`${completed ? 'Completed' : 'Reopened'}: ${task.title}`);
    res.json(db.prepare('SELECT * FROM lifecycle_tasks WHERE id=?').get(task.id));
  });

  const parseCsv=text => {
    const rows=[];
    let row=[],field='',quoted=false;
    const input=String(text || '').replace(/^\uFEFF/,'');
    for (let i=0;i<input.length;i++) {
      const char=input[i];
      if (quoted) {
        if (char === '"' && input[i+1] === '"') { field+='"'; i++; }
        else if (char === '"') quoted=false;
        else field+=char;
      } else if (char === '"') quoted=true;
      else if (char === ',') { row.push(field); field=''; }
      else if (char === '\n') { row.push(field.replace(/\r$/,'')); rows.push(row); row=[]; field=''; }
      else field+=char;
    }
    if (quoted) throw new Error('CSV contains an unterminated quoted field.');
    if (field.length || row.length) { row.push(field.replace(/\r$/,'')); rows.push(row); }
    return rows.filter(values => values.some(value => String(value).trim() !== ''));
  };

  const validateEmployeeCsv=text => {
    let rows;
    try { rows=parseCsv(text); }
    catch (error) { return {valid:false,issues:[error.message],rows:[],summary:{total:0,valid:0,invalid:0}}; }

    if (rows.length < 2) return {valid:false,issues:['CSV needs a header row and at least one employee row.'],rows:[],summary:{total:0,valid:0,invalid:0}};
    const headers=rows[0].map(value => safeText(value,80).toLowerCase());
    const required=['first_name','last_name','email','department','job_title','location','employment_type','status','start_date'];
    const missing=required.filter(name => !headers.includes(name));
    if (missing.length) return {valid:false,issues:[`Missing required columns: ${missing.join(', ')}.`],rows:[],summary:{total:rows.length-1,valid:0,invalid:rows.length-1}};

    const known=new Set([...required,'manager_email','end_date','salary']);
    const existingEmails=new Set(db.prepare('SELECT email FROM employees').all().map(row => String(row.email).toLowerCase()));
    const fileEmails=new Set();
    const output=[];

    for (let index=1;index<rows.length;index++) {
      const values=rows[index],raw={};
      headers.forEach((header,column) => { if (known.has(header)) raw[header]=safeText(values[column] ?? '',header === 'job_title' ? 100 : 180); });
      raw.email=String(raw.email || '').toLowerCase();
      raw.manager_email=String(raw.manager_email || '').toLowerCase();
      const errors=[];
      for (const field of required) if (!raw[field]) errors.push(`${field} is required`);
      if (raw.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw.email)) errors.push('email is invalid');
      if (raw.manager_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw.manager_email)) errors.push('manager_email is invalid');
      if (raw.manager_email && raw.manager_email === raw.email) errors.push('employee cannot manage themselves');
      if (raw.employment_type && !allowedEmployment.has(raw.employment_type)) errors.push('employment_type is invalid');
      if (raw.status && !allowedStatuses.has(raw.status)) errors.push('status is invalid');
      if (raw.salary && (!Number.isFinite(Number(raw.salary)) || Number(raw.salary) < 0)) errors.push('salary must be a non-negative number');
      if (existingEmails.has(raw.email)) errors.push('email already exists');
      if (fileEmails.has(raw.email)) errors.push('email is duplicated in this CSV');
      if (raw.email) fileEmails.add(raw.email);

      output.push({line:index+1,data:raw,errors});
    }

    const importEmails=new Set(output.filter(row => !row.errors.length).map(row => row.data.email));
    for (const row of output) {
      if (row.data.manager_email && !existingEmails.has(row.data.manager_email) && !importEmails.has(row.data.manager_email)) {
        row.errors.push('manager_email does not match an existing or imported employee');
      }
    }

    const validCount=output.filter(row => !row.errors.length).length;
    const invalidCount=output.length-validCount;
    return {
      valid:invalidCount === 0 && output.length > 0,
      issues:invalidCount ? [`${invalidCount} row${invalidCount === 1 ? '' : 's'} need attention before import.`] : [],
      rows:output.slice(0,100),
      summary:{total:output.length,valid:validCount,invalid:invalidCount}
    };
  };

  app.post('/api/import/csv/validate',requireAuth,requireRole('admin'),requireCsrf,(req,res) => {
    const csv=typeof req.body?.csv === 'string' ? req.body.csv : '';
    if (Buffer.byteLength(csv,'utf8') > 1_000_000) return res.status(413).json({error:'CSV import is limited to 1 MB.',requestId:req.requestId});
    const validation=validateEmployeeCsv(csv);
    res.status(validation.valid ? 200 : 400).json(validation);
  });

  app.post('/api/import/csv',requireAuth,requireRole('admin'),requireCsrf,(req,res) => {
    const csv=typeof req.body?.csv === 'string' ? req.body.csv : '';
    if (Buffer.byteLength(csv,'utf8') > 1_000_000) return res.status(413).json({error:'CSV import is limited to 1 MB.',requestId:req.requestId});
    const validation=validateEmployeeCsv(csv);
    if (!validation.valid) return res.status(400).json(validation);

    db.exec('BEGIN IMMEDIATE');
    try {
      const insert=db.prepare(`
        INSERT INTO employees (
          first_name,last_name,email,department,job_title,location,employment_type,status,
          manager_name,manager_id,start_date,end_date,salary,onboarding_progress
        ) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,0)
      `);
      const created=[];
      for (const item of validation.rows) {
        const row=item.data;
        const result=insert.run(
          row.first_name,row.last_name,row.email,row.department,row.job_title,row.location,row.employment_type,row.status,
          row.start_date,row.end_date || null,row.salary ? Math.round(Number(row.salary)) : null
        );
        const id=Number(result.lastInsertRowid);
        created.push({id,email:row.email,manager_email:row.manager_email});
        createDefaultTasks(db,id,row.status === 'offboarded' ? 'offboarding' : 'onboarding',req.user);
        recordEmployeeEvent(db,id,req.user,'imported',`Imported ${row.first_name} ${row.last_name} from CSV`);
      }

      const findByEmail=db.prepare('SELECT id,first_name,last_name FROM employees WHERE email=?');
      const setManager=db.prepare('UPDATE employees SET manager_id=?,manager_name=?,version=version+1 WHERE id=?');
      for (const employee of created) {
        if (!employee.manager_email) continue;
        const manager=findByEmail.get(employee.manager_email);
        if (!manager) throw new Error(`Manager disappeared during import: ${employee.manager_email}`);
        setManager.run(Number(manager.id),`${manager.first_name} ${manager.last_name}`,employee.id);
      }

      audit(db,req.user,'import','employees',null,`Imported ${created.length} employees from CSV`);
      db.exec('COMMIT');
      res.status(201).json({ok:true,imported:created.length,employeeIds:created.map(item => item.id)});
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });

  const csvCell=value => {
    const text=String(value ?? '');
    return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"','""') + '"' : text;
  };

  const validateBackupPayload=backup => {
    const currentSchema=Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0);
    const issues=[];
    if (!backup || typeof backup !== 'object') issues.push('Backup must be a JSON object.');
    if (backup?.format !== 'peopleops-backup') issues.push('Unsupported backup format.');
    if (Number(backup?.version) !== 1) issues.push('Unsupported backup version.');
    if (Number(backup?.schema_version) !== currentSchema) issues.push(`Backup schema must match current schema version ${currentSchema}.`);

    const requiredArrays=['employees','lifecycle_tasks','employee_events','audit_events'];
    for (const key of requiredArrays) {
      if (!Array.isArray(backup?.[key])) issues.push(`${key} must be an array.`);
      else if (backup[key].length > 10000) issues.push(`${key} exceeds the 10,000-record restore limit.`);
    }

    const employees=Array.isArray(backup?.employees) ? backup.employees : [];
    const employeeIds=new Set();
    const emails=new Set();
    for (const employee of employees) {
      const id=Number(employee?.id);
      const email=String(employee?.email || '').trim().toLowerCase();
      if (!Number.isInteger(id) || id < 1) issues.push('Every employee needs a positive integer id.');
      if (employeeIds.has(id)) issues.push(`Duplicate employee id: ${id}.`);
      employeeIds.add(id);
      if (!email) issues.push(`Employee ${id || '?'} is missing an email.`);
      if (emails.has(email)) issues.push(`Duplicate employee email: ${email}.`);
      emails.add(email);
      if (!allowedStatuses.has(employee?.status)) issues.push(`Employee ${id || '?'} has an invalid status.`);
      if (!allowedEmployment.has(employee?.employment_type)) issues.push(`Employee ${id || '?'} has an invalid employment type.`);
    }

    for (const employee of employees) {
      const managerId=Number(employee?.manager_id || 0);
      if (managerId && !employeeIds.has(managerId)) issues.push(`Employee ${employee.id} references missing manager ${managerId}.`);
      if (managerId && managerId === Number(employee.id)) issues.push(`Employee ${employee.id} cannot manage themselves.`);
    }
    for (const task of Array.isArray(backup?.lifecycle_tasks) ? backup.lifecycle_tasks : []) {
      if (!employeeIds.has(Number(task?.employee_id))) issues.push(`Task ${task?.id || '?'} references a missing employee.`);
      if (!['onboarding','offboarding'].includes(task?.phase)) issues.push(`Task ${task?.id || '?'} has an invalid phase.`);
    }
    for (const event of Array.isArray(backup?.employee_events) ? backup.employee_events : []) {
      if (!employeeIds.has(Number(event?.employee_id))) issues.push(`Employee event ${event?.id || '?'} references a missing employee.`);
    }

    return {
      valid:issues.length === 0,
      issues:[...new Set(issues)].slice(0,50),
      summary:{
        employees:employees.length,
        tasks:Array.isArray(backup?.lifecycle_tasks) ? backup.lifecycle_tasks.length : 0,
        timelineEvents:Array.isArray(backup?.employee_events) ? backup.employee_events.length : 0,
        auditEvents:Array.isArray(backup?.audit_events) ? backup.audit_events.length : 0,
        schemaVersion:Number(backup?.schema_version || 0)
      }
    };
  };

  const restoreBackupPayload=backup => {
    const validation=validateBackupPayload(backup);
    if (!validation.valid) return validation;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM lifecycle_tasks; DELETE FROM employee_events; DELETE FROM audit_events; DELETE FROM employees;');

      const insertEmployee=db.prepare(`
        INSERT INTO employees (
          id,first_name,last_name,email,department,job_title,location,employment_type,status,
          manager_name,manager_id,start_date,end_date,salary,onboarding_progress,created_at,updated_at,version
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const employee of backup.employees) {
        insertEmployee.run(
          Number(employee.id),safeText(employee.first_name,60),safeText(employee.last_name,60),
          safeText(employee.email,180).toLowerCase(),safeText(employee.department,80),safeText(employee.job_title,100),
          safeText(employee.location,100),employee.employment_type,employee.status,safeText(employee.manager_name,120) || null,
          null,safeText(employee.start_date,20),safeText(employee.end_date,20) || null,
          employee.salary == null ? null : Math.max(0,Math.round(Number(employee.salary) || 0)),
          Math.max(0,Math.min(100,Number(employee.onboarding_progress) || 0)),
          safeText(employee.created_at,40) || new Date().toISOString(),
          safeText(employee.updated_at,40) || new Date().toISOString(),
          Math.max(1,Number(employee.version) || 1)
        );
      }
      const updateManager=db.prepare('UPDATE employees SET manager_id=?,manager_name=? WHERE id=?');
      for (const employee of backup.employees) {
        const managerId=Number(employee.manager_id || 0);
        updateManager.run(managerId || null,safeText(employee.manager_name,120) || null,Number(employee.id));
      }

      const insertTask=db.prepare(`
        INSERT INTO lifecycle_tasks (
          id,employee_id,phase,title,owner_name,due_date,completed_at,created_by_user_id,version,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const task of backup.lifecycle_tasks) {
        insertTask.run(
          Number(task.id),Number(task.employee_id),task.phase,safeText(task.title,180),safeText(task.owner_name,120) || null,
          safeText(task.due_date,20) || null,safeText(task.completed_at,50) || null,null,Math.max(1,Number(task.version) || 1),
          safeText(task.created_at,50) || new Date().toISOString(),safeText(task.updated_at,50) || new Date().toISOString()
        );
      }

      const insertEvent=db.prepare(`
        INSERT INTO employee_events (id,employee_id,actor_user_id,actor_name,event_type,detail,changes_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      for (const event of backup.employee_events) {
        insertEvent.run(
          Number(event.id),Number(event.employee_id),null,safeText(event.actor_name,120) || 'Imported user',
          safeText(event.event_type,80),safeText(event.detail,500),
          event.changes_json == null ? null : String(event.changes_json).slice(0,10000),
          safeText(event.created_at,50) || new Date().toISOString()
        );
      }

      const insertAudit=db.prepare(`
        INSERT INTO audit_events (id,actor_user_id,actor_name,action,entity_type,entity_id,detail,created_at)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      for (const event of backup.audit_events) {
        insertAudit.run(
          Number(event.id),null,safeText(event.actor_name,120) || 'Imported user',safeText(event.action,80),
          safeText(event.entity_type,80),event.entity_id == null ? null : Number(event.entity_id),
          safeText(event.detail,500),safeText(event.created_at,50) || new Date().toISOString()
        );
      }

      db.exec('COMMIT');
      return validation;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  app.post('/api/restore/validate',requireAuth,requireRole('admin'),requireCsrf,(req,res) => {
    const validation=validateBackupPayload(req.body);
    res.status(validation.valid ? 200 : 400).json(validation);
  });

  app.post('/api/restore',requireAuth,requireRole('admin'),requireCsrf,(req,res) => {
    const validation=restoreBackupPayload(req.body);
    if (!validation.valid) return res.status(400).json(validation);
    audit(db,req.user,'restore','backup',null,`Restored local PeopleOps backup with ${validation.summary.employees} employees`);
    res.json({ok:true,...validation});
  });

  app.get('/api/export',requireAuth,requireRole('admin'),(req,res) => {
    const schemaVersion=Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0);
    const backup={
      format:'peopleops-backup',
      version:1,
      generated_at:new Date().toISOString(),
      schema_version:schemaVersion,
      users:db.prepare('SELECT id,email,name,role,created_at FROM users ORDER BY id').all(),
      employees:db.prepare('SELECT * FROM employees ORDER BY id').all(),
      lifecycle_tasks:db.prepare('SELECT * FROM lifecycle_tasks ORDER BY id').all(),
      employee_events:db.prepare('SELECT * FROM employee_events ORDER BY id').all(),
      audit_events:db.prepare('SELECT * FROM audit_events ORDER BY id').all(),
      schema_migrations:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
    };
    audit(db,req.user,'export','backup',null,'Exported local PeopleOps JSON backup');
    const stamp=new Date().toISOString().slice(0,10);
    res.setHeader('Content-Disposition',`attachment; filename="peopleops-backup-${stamp}.json"`);
    res.json(backup);
  });

  app.get('/api/employees.csv',requireAuth,requireRole('admin'),(req,res) => {
    const rows=db.prepare('SELECT * FROM employees ORDER BY last_name,first_name').all();
    const columns=['id','first_name','last_name','email','department','job_title','location','employment_type','status','manager_name','start_date','end_date','salary','onboarding_progress','version'];
    const csv=[columns.join(','),...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\n');
    audit(db,req.user,'export','employees',null,'Exported employee directory CSV');
    const stamp=new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="peopleops-employees-${stamp}.csv"`);
    res.send(csv);
  });

  app.get('/api/audit',requireAuth,requireRole('admin','manager'),(req,res) => {
    res.json(db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 75').all());
  });

  app.use('/api',(req,res) => res.status(404).json({error:'API route not found.',requestId:req.requestId}));
  app.use((req,res) => res.status(404).send('Not found'));
  app.use((error,req,res,next) => {
    console.error(JSON.stringify({
      level:'error',requestId:req.requestId,method:req.method,path:req.path,
      message:error?.message || 'Unexpected server error'
    }));
    if (res.headersSent) return next(error);
    if (req.path.startsWith('/api/')) return res.status(500).json({error:'Unexpected server error.',requestId:req.requestId});
    res.status(500).send(`Unexpected server error. Request ID: ${req.requestId}`);
  });

  app.locals.db=db;
  return app;
}

if (require.main === module) {
  const app=createApp();
  app.listen(PORT,() => {
    console.log(`PeopleOps Console running at http://localhost:${PORT}`);
    if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set; sessions will reset when the server restarts.');
    if (process.env.NODE_ENV !== 'production' && !process.env.DEMO_ADMIN_PASSWORD && !process.env.DEMO_MANAGER_PASSWORD && !process.env.DEMO_VIEWER_PASSWORD) {
      console.log('Local demo credentials are enabled. See the sign-in page or README.');
    }
  });
}

module.exports={createApp};
