'use strict';

// ---------------------------------------------------------------------------
// Config — reads BASE_URL from a global set by the HTML page, or falls back.
// ---------------------------------------------------------------------------
const BASE_URL = (typeof window !== 'undefined' && window.API_BASE_URL) || '';

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function el(id) { return document.getElementById(id); }

function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const panel = el(`panel-${name}`);
  const btn = el(`tab-${name}`);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
}

function setStatus(elId, msg, type = 'info') {
  const el2 = el(elId);
  if (!el2) return;
  el2.textContent = msg;
  el2.className = `status-msg status-${type}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// QR rendering (qrcode.js library loaded in HTML)
// ---------------------------------------------------------------------------
function renderQR(containerId, text) {
  const container = el(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    container.textContent = text;
    return;
  }
  new QRCode(container, {
    text,
    width: 200,
    height: 200,
    colorDark: '#0f172a',
    colorLight: '#f8fafc',
  });
}

// ---------------------------------------------------------------------------
// Polling state
// ---------------------------------------------------------------------------
let pollTimer = null;

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Feature 1 — Invoice creation
// ---------------------------------------------------------------------------
async function handleCreateInvoice(e) {
  e.preventDefault();
  const amount = el('inv-amount').value.trim();
  const description = el('inv-description').value.trim();

  el('inv-submit').disabled = true;
  setStatus('inv-status', 'Creating invoice…', 'info');
  el('inv-result').classList.add('hidden');
  stopPolling();

  try {
    const body = { amount };
    if (description) body.description = description;

    const res = await fetch(`${BASE_URL}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus('inv-status', `Error: ${data.error || res.statusText}`, 'error');
      return;
    }

    // Populate result card
    el('res-address').textContent = data.invoiceAddress;
    el('res-hash').textContent = data.paymentHash;
    el('res-amount').textContent = `${data.amount} RUSD`;
    el('res-expires').textContent = data.expiresAt ? formatDate(data.expiresAt) : 'Default';
    renderQR('res-qr', data.invoiceAddress);
    el('inv-result').classList.remove('hidden');
    setStatus('inv-status', 'Invoice created — waiting for payment…', 'info');

    startPolling(data.paymentHash);
  } catch (err) {
    setStatus('inv-status', `Network error: ${err.message}`, 'error');
  } finally {
    el('inv-submit').disabled = false;
  }
}

function startPolling(paymentHash) {
  stopPolling();
  setStatus('poll-status', 'Polling for payment…', 'info');
  el('poll-section').classList.remove('hidden');
  el('poll-hash').textContent = paymentHash;
  el('poll-download').classList.add('hidden');

  pollTimer = setInterval(() => pollOnce(paymentHash), 3000);
  pollOnce(paymentHash); // immediate first check
}

async function pollOnce(paymentHash) {
  try {
    const res = await fetch(`${BASE_URL}/receipt/${paymentHash}`);

    if (res.status === 202) {
      setStatus('poll-status', 'Waiting for payment… (status: Open)', 'info');
      return;
    }
    if (res.status === 200 && res.headers.get('content-type')?.includes('application/pdf')) {
      stopPolling();
      setStatus('poll-status', '✓ Payment received! Receipt ready.', 'success');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const dl = el('poll-download');
      dl.href = url;
      dl.download = `receipt-${paymentHash.slice(0, 10)}.pdf`;
      dl.classList.remove('hidden');
      return;
    }
    if (res.status === 410) {
      const data = await res.json();
      stopPolling();
      setStatus('poll-status', `Invoice ${data.status} — no payment will arrive.`, 'error');
      return;
    }
    if (res.status === 503) {
      stopPolling();
      setStatus('poll-status', 'Paid! (Signing key not configured — PDF unavailable)', 'success');
      return;
    }

    const data = await res.json().catch(() => ({}));
    setStatus('poll-status', `Unexpected status ${res.status}: ${data.error || ''}`, 'error');
    stopPolling();
  } catch (err) {
    setStatus('poll-status', `Poll error: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Feature 3 — CSV export
// ---------------------------------------------------------------------------
async function handleExport(e) {
  e.preventDefault();
  const from = el('exp-from').value;
  const to = el('exp-to').value;

  if (!from || !to) {
    setStatus('exp-status', 'Both dates are required.', 'error');
    return;
  }

  setStatus('exp-status', 'Exporting…', 'info');
  el('exp-submit').disabled = true;

  try {
    let queryFrom = from;
    let queryTo = to;
    if (queryFrom.length === 10) queryFrom += 'T00:00:00.000Z';
    if (queryTo.length === 10) queryTo += 'T23:59:59.999Z';

    const res = await fetch(`${BASE_URL}/export?from=${encodeURIComponent(queryFrom)}&to=${encodeURIComponent(queryTo)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus('exp-status', `Error: ${data.error || res.statusText}`, 'error');
      return;
    }
    const csv = await res.text();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `settlement-${from}-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('exp-status', 'Download started.', 'success');
  } catch (err) {
    setStatus('exp-status', `Network error: ${err.message}`, 'error');
  } finally {
    el('exp-submit').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Boot — wire up event listeners after DOM is ready
// ---------------------------------------------------------------------------
function boot() {
  el('tab-invoice')?.addEventListener('click', () => showPanel('invoice'));
  el('tab-export')?.addEventListener('click', () => showPanel('export'));
  el('invoice-form')?.addEventListener('submit', handleCreateInvoice);
  el('export-form')?.addEventListener('submit', handleExport);

  // Default to today's date range in the export form
  const today = new Date().toISOString().slice(0, 10);
  if (el('exp-to')) el('exp-to').value = today;
  if (el('exp-from')) el('exp-from').value = today;

  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = el(btn.dataset.copyTarget);
      if (!target) return;
      navigator.clipboard.writeText(target.textContent).then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 1500);
      });
    });
  });

  showPanel('invoice');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

// Export for tests
if (typeof module !== 'undefined') {
  module.exports = { showPanel, setStatus, renderQR, formatDate, handleCreateInvoice, handleExport, startPolling, stopPolling, pollOnce };
}