'use strict';

const fs = require('fs');
const path = require('path');

// Phase 1: proves the web workspace's test runner is wired up before any
// real frontend logic exists.

test('placeholder: web workspace test runner is wired up', () => {
  expect(1 + 1).toBe(2);
});

test('placeholder: index.html scaffold exists', () => {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  expect(fs.existsSync(htmlPath)).toBe(true);
});
