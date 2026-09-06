const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { requireAuth } = require('../auth');
const manager = require('../services/downloadManager');

/**
 * GET /api/downloads/:itemId/file?e=&s=
 *
 * Deliberately before requireAuth: a phone's download manager does not send
 * the Authorization header, so this link proves itself instead, with a
 * signature over the item and an expiry.
 */
router.get('/:itemId/file', (req, res) => {
    const { itemId } = req.params;
    if (!manager.verifyLink(itemId, req.query.e, req.query.s)) {
        return res.status(403).send('Link expired or invalid');
    }
    const row = manager.get(itemId);
    if (!row || row.status !== 'ready' || !row.path || !fs.existsSync(row.path)) {
        return res.status(404).send('Not ready');
    }

    // A name the phone can file away, rather than the composite id
    const safe = String(row.name || 'film').replace(/[^\w \-.]/g, '').trim() || 'film';
    res.setHeader('Content-Disposition',
        `attachment; filename="${safe}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    // sendFile answers range requests, which is what makes a transfer
    // resumable after the hotel wifi drops it
    res.sendFile(path.resolve(row.path));
});

router.use(requireAuth);

/** Everything prepared or being prepared, plus what the quota allows. */
router.get('/', (req, res) => {
    try {
        const items = manager.list().map(row => ({
            ...row,
            link: row.status === 'ready'
                ? (() => {
                    const { expires, signature } = manager.signLink(row.item_id);
                    return `/api/downloads/${encodeURIComponent(row.item_id)}/file`
                        + `?e=${expires}&s=${signature}`;
                })()
                : null
        }));
        res.json({
            items,
            max: manager.MAX_FILMS,
            freeBytes: manager.freeBytes()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Ask for one. A refusal is an answer with a reason, not a 500. */
// A refusal has to arrive as a sentence: the client throws on a 409 and
// only carries `error` across, so the reason has to travel in it.
const REFUSALS = {
    quota: r => `Only ${r.max} films at a time — remove one first`,
    disk: () => 'Not enough space left on the server',
    unknown: () => 'That film is no longer in the catalogue',
    'not-a-film': () => 'Only films can be downloaded'
};

router.post('/:itemId', async (req, res) => {
    try {
        const result = await manager.request(req.params.itemId);
        if (result.ok) return res.status(202).json(result);
        const say = REFUSALS[result.reason] || (() => 'Could not start');
        res.status(409).json({ ...result, error: say(result) });
    } catch (err) {
        console.error('[Downloads] Request failed:', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:itemId', (req, res) => {
    res.json({ removed: manager.remove(req.params.itemId) });
});

module.exports = router;
