
# Changelog

## Unreleased

### Added
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
