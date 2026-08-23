const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth');
const enricher = require('../services/tmdbEnricher');

router.use(requireAuth);

/**
 * GET /api/tmdb/status
 * How much of the catalogue has been identified, and what is left.
 */
router.get('/status', (req, res) => {
    try {
        res.json(enricher.getStatus());
    } catch (err) {
        console.error('[TMDB] Status failed:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/tmdb/item/:itemId
 * The metadata for one catalogue entry, or 404. itemId is the composite
 * "sourceId:itemId" key used throughout playlist_items.
 */
router.get('/item/:itemId', (req, res) => {
    try {
        const row = enricher.getForItem(req.params.itemId);
        if (!row) return res.status(404).json({ error: 'Not enriched' });
        res.json({ ...row, data: row.data ? JSON.parse(row.data) : null,
            genres: row.genres ? JSON.parse(row.genres) : [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/tmdb/run
 * Run a pass now instead of waiting for the timer. Answers immediately:
 * a full pass takes minutes, which is far longer than a request should
 * ever be held open, and the status endpoint reports the progress.
 */
router.post('/run', requireAdmin, (req, res) => {
    if (!enricher.isEnabled()) {
        return res.status(409).json({ error: 'TMDB_API_KEY is not set' });
    }
    const limit = Number(req.body?.limit) || undefined;
    enricher.runPass({ limit })
        .catch(err => console.error('[TMDB] Manual pass failed:', err));
    res.json({ started: true });
});

module.exports = router;
