
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
    if (!Object.keys(changes).length return res.json(serializeEmployee(existing,req.user.role));

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
