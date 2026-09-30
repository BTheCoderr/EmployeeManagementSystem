# PeopleOps Console

![CI](https://github.com/BTheCoderr/EmployeeManagementSystem/actions/workflows/ci.yml/badge.svg)

**PeopleOps Console is a secure employee-operations dashboard built to demonstrate backend/API architecture, role-based access control, data persistence, auditability, and production-minded web security.**

The repository began as a small Express/MySQL employee-form exercise. It has been rebuilt around a clearer product model and a more defensible engineering surface: authenticated roles, SQLite persistence, field-level authorization, CSRF protection, audit history, API tests, and CI.

## Engineering highlights

| Area | Implementation |
| --- | --- |
| Runtime | Node.js 24 |
| Web layer | Express 5 + server-rendered EJS |
| Database | Built-in `node:sqlite` / SQLite |
| Authentication | Scrypt password hashing + signed HttpOnly session cookies |
| Authorization | Admin / Manager / Viewer RBAC |
| Field security | Compensation visible/editable only to admins |
| Request security | CSRF validation, secure cookie flags, rate-limited login attempts |
| Auditing | Login, logout, create, update, and offboarding events |
| Employee lifecycle | Active, leave, and offboarded states |
| Quality | Node test runner + GitHub Actions CI |

## Roles

**Admin** can view compensation, create employee records, edit all employee fields, offboard employees, and inspect the audit trail.

**Manager** can view the directory, update operational employee fields, and inspect the audit trail. Compensation remains restricted.

**Viewer** has read-only directory access. Compensation and audit history are not exposed.

## Local demo accounts

Development seeds three local-only demo roles when the database is empty:

```text
admin@peopleops.local   / AdminDemo2026!
manager@peopleops.local / ManagerDemo2026!
viewer@peopleops.local  / ViewerDemo2026!
```

For production-like use, provide passwords through environment variables instead of relying on demo defaults.

## Run locally

Requires Node.js 24+.

```bash
npm install
cp .env.example .env
npm start
```

The application creates `data/peopleops.sqlite` automatically. The database is ignored by Git.

Open:

```text
http://localhost:3000
```

## Tests

```bash
npm run ci
```

The integration tests exercise the actual Express app and SQLite layer, including authentication, RBAC, field-level compensation controls, employee creation, audit logging, and CSRF enforcement.

## Security decisions

Passwords are never stored in plaintext. Credentials are hashed with Node's built-in `scrypt` implementation and a per-password salt.

Session state is signed and stored in an HttpOnly, SameSite cookie. Production mode adds the Secure flag. A CSRF token is embedded in the signed session and required for mutation APIs.

The application removes Express's identifying response header and adds CSP, clickjacking, referrer, MIME-sniffing, and browser-permission headers.

## Persistence

The default database is SQLite and costs nothing to run locally. That makes the repository fully testable without provisioning a paid database or external service.

A future hosted deployment can swap the persistence layer for Postgres/Supabase without changing the product model. The current portfolio version intentionally stays $0-first.

## Project evolution

The original repository was useful as an early Node/MySQL learning exercise, but it exposed beginner patterns such as plaintext password comparisons, a hard-coded session secret, and unstructured routes.

PeopleOps Console replaces those patterns instead of hiding them. The current repository is intended to show the engineering decisions a reviewer should evaluate today: authentication, authorization, validation, database design, auditability, testing, and maintainable separation between UI, security, and persistence.
