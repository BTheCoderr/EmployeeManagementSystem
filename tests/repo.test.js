'use strict';

const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const assert=require('node:assert/strict');

const root=path.join(__dirname,'..');

test('Docker image uses Node 24, non-root runtime, and embedded SQLite path',() => {
  const dockerfile=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
  assert.match(dockerfile,/FROM node:24-/);
  assert.match(dockerfile,/USER node/);
  assert.match(dockerfile,/DATABASE_PATH=\/app\/data\/peopleops\.sqlite/);
  assert.match(dockerfile,/HEALTHCHECK/);
});

test('Compose keeps SQLite data on a named volume and exposes the app port',() => {
  const compose=fs.readFileSync(path.join(root,'docker-compose.yml'),'utf8');
  assert.match(compose,/peopleops-data:\/app\/data/);
  assert.match(compose,/"3000:3000"/);
  assert.match(compose,/DATABASE_PATH: \/app\/data\/peopleops\.sqlite/);
});

test('Docker context excludes local databases and repository internals',() => {
  const ignore=fs.readFileSync(path.join(root,'.dockerignore'),'utf8');
  assert.match(ignore,/node_modules/);
  assert.match(ignore,/\.git/);
  assert.match(ignore,/data/);
  assert.match(ignore,/\*\.sqlite/);
});
