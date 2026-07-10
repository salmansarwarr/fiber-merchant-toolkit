'use strict';

const request = require('supertest');
const { createApp } = require('../src/index');

// Phase 1: proves the server workspace's test runner and Express app
// factory are wired up correctly before any real routes exist.

test('placeholder: server workspace test runner is wired up', () => {
  expect(1 + 1).toBe(2);
});

test('placeholder: GET /healthz responds 200 with no live fnn node required', async () => {
  const app = createApp();
  const res = await request(app).get('/healthz');

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok' });
});