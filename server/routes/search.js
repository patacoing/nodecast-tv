const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { getDb } = require('../db/sqlite');

router.use(requireAuth);

// Enough to fill a row of results per kind without shipping the catalogue.
const PER_KIND = 24;

/**
 * Matching the way someone types on a remote: accents off, case off,
 * punctuation off. "cine" has to find "Ciné+", and "tf1" has to find
 * "FR || TF1 [SD]", so the comparison runs on a stripped form of the name
 * rather than the name itself.
 *
 * SQLite has no unaccent, so the folding is done here and the query works
 * on LIKE over the folded needle. The catalogue is small enough -- 16k
 * rows -- that a scan costs a couple of milliseconds; an index on a
 * normalised column would be the next step if it ever stopped being true.
 */
function fold(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * GET /api/search?q=...&limit=
 *
 * One query across everything the catalogue holds, grouped by kind. Four
 * separate search boxes is three too many with a remote in your hand.
 */
router.get('/', (req, res) => {
    const q = fold(req.query.q);
    if (q.length < 2) return res.json({ query: q, movies: [], series: [], channels: [] });

    const limit = Math.min(Number(req.query.limit) || PER_KIND, 60);

    try {
        const rows = getDb().prepare(`
            SELECT id, source_id, item_id, type, name, stream_icon, rating,
                   year, container_extension, category_id
            FROM playlist_items
            WHERE type IN ('movie', 'series', 'live') AND is_hidden = 0
        `).all();

        const words = q.split(' ').filter(Boolean);
        const scored = [];

        for (const row of rows) {
            const folded = fold(row.name);
            if (!words.every(w => folded.includes(w))) continue;

            // A title that starts with what was typed is what was meant far
            // more often than one that merely contains it somewhere.
            const score = folded === q ? 0
                : folded.startsWith(q) ? 1
                    : folded.includes(q) ? 2 : 3;
            scored.push({ score, len: folded.length, row });
        }

        scored.sort((a, b) => a.score - b.score || a.len - b.len);

        const out = { movie: [], series: [], live: [] };
        for (const { row } of scored) {
            const bucket = out[row.type];
            if (bucket && bucket.length < limit) bucket.push(row);
        }

        res.json({
            query: q,
            total: scored.length,
            movies: out.movie,
            series: out.series,
            channels: out.live
        });
    } catch (err) {
        console.error('[Search] Failed:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
module.exports.fold = fold;
