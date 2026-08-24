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
 *
 * Everything the details panel needs for one catalogue entry, in two
 * clearly separated halves: what the provider said about it, and what TMDB
 * says about the work. The precedence between them is the caller's to
 * apply -- the provider wins any field it filled in.
 *
 * itemId is the composite "sourceId:itemId" key used by playlist_items.
 * A read from SQLite and nothing else: the enrichment that filled these
 * tables is a background job, so opening a film never reaches outside.
 */
router.get('/item/:itemId', (req, res) => {
    try {
        const tmdbRow = enricher.getForItem(req.params.itemId);
        const detailRow = enricher.getDetailsForItem(req.params.itemId);
        if (!tmdbRow && !detailRow) {
            return res.status(404).json({ error: 'Not enriched' });
        }

        res.json({
            provider: detailRow ? {
                plot: detailRow.plot,
                cast: detailRow.cast_list,
                director: detailRow.director,
                genres: detailRow.genres ? JSON.parse(detailRow.genres) : [],
                runtime: detailRow.runtime,
                year: detailRow.year,
                trailer: detailRow.trailer,
                backdrop: detailRow.backdrop,
                rating: detailRow.rating
            } : null,
            tmdb: tmdbRow ? {
                ...tmdbRow,
                data: tmdbRow.data ? JSON.parse(tmdbRow.data) : null,
                genres: tmdbRow.genres ? JSON.parse(tmdbRow.genres) : []
            } : null
        });
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

/**
 * POST /api/tmdb/retry
 * Forget the entries that matched nothing, so the next pass tries them
 * again rather than waiting out the month-long retry delay. This is what
 * makes an improvement to the matching rules take effect now.
 */
router.post('/retry', requireAdmin, (req, res) => {
    try {
        const cleared = enricher.resetUnmatched();
        if (enricher.isEnabled()) {
            enricher.runPass().catch(err =>
                console.error('[TMDB] Retry pass failed:', err));
        }
        res.json({ cleared, started: enricher.isEnabled() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
