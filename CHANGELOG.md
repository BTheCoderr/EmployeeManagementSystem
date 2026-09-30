
# Changelog

## Unreleased

### Added
- native Node test coverage reporting with enforced line/function/branch floors
- dedicated security regression suite for sessions, RBAC, CSRF, headers, and sensitive-field leakage
- separate CI dependency-audit security job
- preview-first CSV employee import with row-level validation
- manager-by-email resolution for bulk imports
- all-or-nothing transactional import with lifecycle and audit records
- CSV import validation and RBAC integration coverage
- validate-first JSON backup restore with relational integrity checks and transactional writes
- restore preserves authentication users/password hashes while replacing employee workflow data
- restore authorization, validation, rollback-safe behavior, and round-trip coverage
- structured before/after field diffs in the employee timeline
- compensation-redaction coverage for historical change payloads
- admin-only sanitized JSON backup export for the complete local workspace
- admin-only employee CSV export for portable directory data
- export RBAC and sensitive-field tests
- interactive manager/direct-report team structure view backed by the existing org API
- reporting-relationship integration coverage

## 2.1.0 — 2026-09-30

### Added
- versioned embedded-SQLite migrations
- employee-to-manager relationships
- onboarding and offboarding task workflows
- task-driven onboarding progress
- structured employee timeline
- workforce analytics
- directory pagination and allow-listed sorting
- optimistic concurrency for employee and task updates
- OpenAPI 3.1 contract and in-app API documentation
- request IDs and structured error logging
- production-safe demo credential handling
- expanded integration/security tests

## 2.0.0 — 2026-09-30

### Rebuilt
- replaced the original MySQL form demo with PeopleOps Console
- added scrypt password hashing and signed HttpOnly sessions
- added Admin / Manager / Viewer RBAC
- added compensation-field isolation
- added CSRF protection, login throttling, security headers, embedded SQLite, audit history, tests, and CI
