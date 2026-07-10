'use strict';

const express = require('express');
const { exportCsv } = require('@fiber-merchant-toolkit/core');

/**
 * @param {{ store: {listByDateRange: Function} }} deps
 */
function createExportRouter(deps) {
  const { store } = deps;

  const router = express.Router();

  router.get('/', (req, res) => {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'query params `from` and `to` are required (ISO 8601 date strings)' });
    }

    // Validate that both are parseable dates.
    if (Number.isNaN(Date.parse(from))) {
      return res.status(400).json({ error: '`from` must be a valid ISO 8601 date string' });
    }
    if (Number.isNaN(Date.parse(to))) {
      return res.status(400).json({ error: '`to` must be a valid ISO 8601 date string' });
    }

    // Reject inverted ranges before hitting the store.
    if (from > to) {
      return res.status(400).json({ error: '`from` must not be after `to`' });
    }

    let csv;
    try {
      csv = exportCsv(store, { from, to });
    } catch (err) {
      if (err instanceof RangeError) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: `Export failed: ${err.message}` });
    }

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="settlement.csv"',
    });
    return res.status(200).send(csv);
  });

  return router;
}

module.exports = { createExportRouter };