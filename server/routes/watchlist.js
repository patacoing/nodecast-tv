const express = require('express');
const router = express.Router();
const { watchlist } = require('../db/sqlite');
const { requireAuth } = require('../auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
    try {
        const { sourceId, itemType } = req.query;
        const items = watchlist.getAll(req.user.id, sourceId || null, itemType || null);
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get watchlist items enriched with full content data (name, poster, etc.)
router.get('/items', async (req, res) => {
    try {
        const items = watchlist.getItemsWithData(req.user.id);
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'movie' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }
        watchlist.add(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'movie' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }
        watchlist.remove(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/check', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'movie' } = req.query;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }
        const inWatchlist = watchlist.isInWatchlist(req.user.id, sourceId, itemId, itemType);
        res.json({ inWatchlist });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
