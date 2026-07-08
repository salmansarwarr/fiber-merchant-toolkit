'use strict';

const fs = require('fs');
const path = require('path');

// 1. Load HTML into JSDOM before requiring app.js so `document` exists
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)[1];

// 2. Load the app module
const app = require('../app');

// 3. Mock global fetch and timers
global.fetch = jest.fn();
jest.useFakeTimers();

beforeEach(() => {
  // Reset DOM state
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('inv-status').textContent = '';
  document.getElementById('poll-status').textContent = '';
  document.getElementById('exp-status').textContent = '';
  document.getElementById('inv-result').classList.add('hidden');
  document.getElementById('poll-section').classList.add('hidden');
  document.getElementById('poll-download').classList.add('hidden');
  document.getElementById('inv-submit').disabled = false;
  document.getElementById('exp-submit').disabled = false;

  // Clear fetch mock
  fetch.mockClear();
  app.stopPolling();
});

describe('UI Navigation & Utilities', () => {
  test('showPanel switches active class', () => {
    app.showPanel('export');
    expect(document.getElementById('panel-export').classList.contains('active')).toBe(true);
    expect(document.getElementById('tab-export').classList.contains('active')).toBe(true);

    expect(document.getElementById('panel-invoice').classList.contains('active')).toBe(false);
    expect(document.getElementById('tab-invoice').classList.contains('active')).toBe(false);
  });

  test('setStatus updates text and class', () => {
    app.setStatus('inv-status', 'Hello World', 'success');
    const el = document.getElementById('inv-status');
    expect(el.textContent).toBe('Hello World');
    expect(el.className).toBe('status-msg status-success');
  });

  test('formatDate formats ISO string or returns placeholder', () => {
    expect(app.formatDate(null)).toBe('—');
    expect(app.formatDate('2026-07-08T12:00:00Z')).toContain('2026');
  });
});

describe('Invoice Creation (handleCreateInvoice)', () => {
  test('successfully creates invoice and starts polling', async () => {
    // Setup form
    document.getElementById('inv-amount').value = '10.5';
    document.getElementById('inv-description').value = 'Test order';

    // Mock successful fetch
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        invoiceAddress: 'fibt1...',
        paymentHash: '0x123...',
        amount: '10.5',
        expiresAt: '2026-07-08T12:00:00Z'
      })
    });

    const event = { preventDefault: jest.fn() };
    await app.handleCreateInvoice(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '10.5', description: 'Test order' })
    });

    // Check DOM updates
    expect(document.getElementById('res-amount').textContent).toBe('10.5 RUSD');
    expect(document.getElementById('res-hash').textContent).toBe('0x123...');
    expect(document.getElementById('inv-result').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('poll-section').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('inv-submit').disabled).toBe(false);
  });

  test('displays error on failed creation', async () => {
    document.getElementById('inv-amount').value = 'bad';

    fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'invalid amount' })
    });

    await app.handleCreateInvoice({ preventDefault: jest.fn() });

    expect(document.getElementById('inv-status').textContent).toContain('invalid amount');
    expect(document.getElementById('inv-result').classList.contains('hidden')).toBe(true);
  });
});

describe('Receipt Polling (pollOnce)', () => {
  const hash = '0xabc...';

  test('status 202 (Open) keeps polling', async () => {
    fetch.mockResolvedValueOnce({ status: 202 });
    await app.pollOnce(hash);
    expect(document.getElementById('poll-status').textContent).toContain('Waiting');
    // Timer should still be active if started via startPolling, but pollOnce is direct here
  });

  test('status 200 (Paid) shows download link and stops polling', async () => {
    // Need to mock startPolling first so there's a timer to stop
    app.startPolling(hash);

    // The immediate first poll in startPolling happened, clear that mock
    fetch.mockClear();

    // Now mock the next poll to return 200 PDF
    fetch.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      blob: async () => new Blob(['fake pdf'], { type: 'application/pdf' })
    });

    // JSDOM doesn't implement URL.createObjectURL or revokeObjectURL natively
    global.URL.createObjectURL = jest.fn(() => 'blob:url');
    global.URL.revokeObjectURL = jest.fn();

    await app.pollOnce(hash);

    expect(document.getElementById('poll-status').textContent).toContain('Payment received');
    expect(document.getElementById('poll-download').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('poll-download').href).toContain('blob:url');
  });

  test('status 410 (Terminal) shows error and stops polling', async () => {
    fetch.mockResolvedValueOnce({
      status: 410,
      json: async () => ({ status: 'Expired' })
    });

    await app.pollOnce(hash);

    expect(document.getElementById('poll-status').textContent).toContain('Expired');
    expect(document.getElementById('poll-status').className).toContain('error');
  });
});

describe('CSV Export (handleExport)', () => {
  test('successfully triggers download', async () => {
    document.getElementById('exp-from').value = '2026-07-01';
    document.getElementById('exp-to').value = '2026-07-08';

    fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'date,hash\n2026,0x1'
    });

    // Mock link clicking
    const clickMock = jest.fn();
    const createElementSpy = jest.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag === 'a') return { click: clickMock };
      return document.createElement(tag);
    });

    await app.handleExport({ preventDefault: jest.fn() });

    expect(fetch).toHaveBeenCalledWith('/export?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-08T23%3A59%3A59.999Z');
    expect(clickMock).toHaveBeenCalled();
    expect(document.getElementById('exp-status').textContent).toContain('Download started');

    createElementSpy.mockRestore();
  });

  test('requires both dates', async () => {
    document.getElementById('exp-from').value = '';

    await app.handleExport({ preventDefault: jest.fn() });

    expect(fetch).not.toHaveBeenCalled();
    expect(document.getElementById('exp-status').textContent).toContain('required');
  });
});
