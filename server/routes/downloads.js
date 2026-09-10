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
            budget: manager.BUDGET_BYTES,
            used: manager.heldBytes(),
            freeBytes: manager.freeBytes()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Ask for one. A refusal is an answer with a reason, not a 500. */
// A refusal has to arrive as a sentence: the client throws on a 409 and
// only carries `error` across, so the reason has to travel in it.
const gb = n => (n / 1024 ** 3).toFixed(1);

const REFUSALS = {
    quota: r => `Not enough of the ${gb(r.budget)} GB left`
        + ` — ${gb(r.used)} GB held, this needs ${gb(r.needed)} GB.`
        + ' Remove something first',
    disk: () => 'Not enough space left on the server',
    unknown: () => 'That is no longer in the catalogue',
    'unknown-episode': () => 'The provider no longer lists that episode',
    'not-a-film': () => 'Only films and episodes can be downloaded'
};

function answer(res, result) {
    if (result.ok) return res.status(202).json(result);
    const say = REFUSALS[result.reason] || (() => 'Could not start');
    res.status(409).json({ ...result, error: say(result) });
}

router.post('/:itemId', async (req, res) => {
    try {
        answer(res, await manager.request(req.params.itemId));
    } catch (err) {
        console.error('[Downloads] Request failed:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * One episode. The series is addressed by its catalogue row and the episode
 * by the provider's stream id; the server looks the rest up itself rather
 * than taking a URL from the client.
 */
router.post('/series/:seriesItemId/episode/:episodeId', async (req, res) => {
    try {
        answer(res, await manager.requestEpisode(
            req.params.seriesItemId, req.params.episodeId));
    } catch (err) {
        console.error('[Downloads] Episode request failed:', err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:itemId', (req, res) => {
    res.json({ removed: manager.remove(req.params.itemId) });
});

module.exports = router;
