/**
 * TMDB enrichment.
 *
 * A periodic pass that lists the catalogue entries which carry no metadata
 * yet and tries to resolve them. That covers both jobs at once: the titles
 * the provider added since the last pass, and the ones a previous pass
 * failed to identify.
 *
 * The point of the design is that nothing is ever fetched twice. Metadata
 * lives in tmdb_titles, keyed by the work rather than by the catalogue
 * entry, and tmdb_links records what each entry resolved to -- including
 * the entries that resolved to nothing, because an unmatched title that is
 * not written down gets searched again on every pass, forever.
 */

const { getDb } = require('../db/sqlite');
const { sources } = require('../db');
const xtreamApi = require('./xtreamApi');
const cache = require('./cache');
const tmdb = require('./tmdbApi');
const { parseName, pickMatch } = require('./titleMatcher');

// How long before an unmatched title is worth another look, and how many
// times in total. A film released last week genuinely does turn up on TMDB
// later; a making-of never will.
const RETRY_AFTER_DAYS = 30;
const MAX_ATTEMPTS = 4;

// A film's own record never changes, so its info is worth keeping for a
// long time. This is the provider's cache, not TMDB's.
const VOD_INFO_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

// Work done in one pass. Enough to clear a day of new titles comfortably,
// small enough that the first backfill is spread over several passes
// instead of hammering both APIs in one go.
const DEFAULT_BATCH = 200;

const KIND = { movie: 'movie', series: 'tv' };

// Shared by the batch query and the count behind it, so the number the
// settings page shows can never drift from what the pass will actually do.
const CANDIDATE_FROM = `
    FROM playlist_items p
    LEFT JOIN tmdb_links l ON l.item_id = p.id
    WHERE p.type IN ('movie', 'series')
      AND (
            l.item_id IS NULL
         OR (l.status = 'unmatched'
             AND l.attempts < ?
             AND (l.matched_name <> p.name OR l.last_attempt_at < ?))
      )`;

class TmdbEnricher {
    constructor() {
        this._timer = null;
        this._running = false;
        this._lastPass = null;
    }

    isEnabled() {
        return tmdb.isEnabled();
    }

    /**
     * Start the periodic pass. Silently does nothing without a key, so a
     * server with no TMDB account behaves exactly as it did before.
     */
    start(intervalHours = 6) {
        if (this._timer) clearInterval(this._timer);
        if (!this.isEnabled()) {
            console.log('[TMDB] No TMDB_API_KEY set, enrichment disabled');
            return;
        }
        const ms = Math.max(1, Number(intervalHours) || 6) * 3600 * 1000;
        this._timer = setInterval(() => {
            this.runPass().catch(err => console.error('[TMDB] Pass failed:', err));
        }, ms);
        console.log(`[TMDB] Enrichment enabled, pass every ${intervalHours}h`);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /**
     * Entries with no metadata yet: never attempted, or attempted without
     * success long enough ago to be worth retrying -- or renamed since,
     * which can fix a match on its own and so skips the waiting period.
     */
    candidates(limit = DEFAULT_BATCH) {
        const retryBefore = Date.now() - RETRY_AFTER_DAYS * 24 * 3600 * 1000;
        return getDb().prepare(`
            SELECT p.id, p.source_id, p.item_id, p.type, p.name, p.year
            ${CANDIDATE_FROM}
            ORDER BY p.type, p.id
            LIMIT ?
        `).all(MAX_ATTEMPTS, retryBefore, limit);
    }

    countPending() {
        const retryBefore = Date.now() - RETRY_AFTER_DAYS * 24 * 3600 * 1000;
        return getDb().prepare(`SELECT COUNT(*) c ${CANDIDATE_FROM}`)
            .get(MAX_ATTEMPTS, retryBefore).c;
    }

    /**
     * One pass. Returns what it did, which is also what the status endpoint
     * reports back to the settings page.
     */
    async runPass({ limit = DEFAULT_BATCH } = {}) {
        if (!this.isEnabled()) return { skipped: 'disabled' };
        if (this._running) return { skipped: 'already running' };

        this._running = true;
        const started = Date.now();
        let matched = 0, unmatched = 0, failed = 0;

        try {
            this.purgeOrphanLinks();

            const items = this.candidates(limit);
            if (items.length === 0) {
                console.log('[TMDB] Nothing left to enrich');
                return { matched: 0, unmatched: 0, failed: 0, examined: 0 };
            }
            console.log(`[TMDB] Enriching ${items.length} entries`);

            for (const item of items) {
                try {
                    const hit = await this.enrichOne(item);
                    if (hit) matched++; else unmatched++;
                } catch (err) {
                    // A single bad entry, or TMDB having a moment, must not
                    // end the pass or -- worse -- be written down as a
                    // definitive "not found".
                    failed++;
                    console.warn(`[TMDB] ${item.name}: ${err.message}`);
                }
            }

            const result = { matched, unmatched, failed, examined: items.length };
            this._lastPass = { ...result, at: Date.now(), tookMs: Date.now() - started };
            console.log(`[TMDB] Pass done: ${matched} matched, ${unmatched} unmatched, ${failed} errors`);
            return result;
        } finally {
            this._running = false;
        }
    }

    /**
     * Resolve one entry. Returns true when it was identified.
     *
     * Anything thrown here means "we do not know yet" -- the caller counts
     * it as an error and leaves the entry for the next pass, rather than
     * recording a failure that would then have to wait out the retry delay.
     */
    async enrichOne(item) {
        const kind = KIND[item.type];
        const parsed = parseName(item.name);
        if (!parsed.title) {
            this.saveLink(item, null, 'unmatched', null);
            return false;
        }

        const year = parsed.year || await this.yearOf(item);

        let choice = await this.searchOnce(kind, parsed.title, year);

        // "Blade Runner 2049" and friends: the trailing number was taken for
        // a release year and probably was not. Ask again the other way.
        if (!choice && parsed.fallbackTitle) {
            choice = await this.searchOnce(kind, parsed.fallbackTitle, null);
        }

        // A title that matched nothing with a year in hand may simply be
        // dated differently by the provider than by TMDB.
        if (!choice && year) {
            choice = await this.searchOnce(kind, parsed.title, null);
        }

        if (!choice) {
            this.saveLink(item, null, 'unmatched', null);
            return false;
        }

        // Only fetch the full record if we do not already hold it: this is
        // where the duplicates in the catalogue stop costing anything.
        if (!this.hasTitle(kind, choice.result.id)) {
            const full = await tmdb.details(kind, choice.result.id);
            this.saveTitle(kind, full);
        }
        this.saveLink(item, choice.result.id, 'matched', choice.confidence, kind);
        return true;
    }

    async searchOnce(kind, title, year) {
        const results = await tmdb.search(kind, title, year);
        return pickMatch({ title, year }, results);
    }

    /**
     * The year, which is the one thing that makes a title unambiguous.
     *
     * Series carry their release date in the catalogue already. Movies do
     * not carry anything -- the list payload is name, icon, rating and
     * container -- so it takes the provider's per-film record, which is
     * cached on disk and only ever fetched once.
     */
    async yearOf(item) {
        if (item.year) {
            const y = Number(String(item.year).slice(0, 4));
            if (Number.isFinite(y) && y > 1800) return y;
        }
        if (item.type !== 'movie') return null;

        const info = await this.vodInfo(item);
        const raw = info?.info?.releasedate || info?.info?.release_date
            || info?.movie_data?.releasedate || '';
        const y = Number(String(raw).slice(0, 4));
        return Number.isFinite(y) && y > 1800 ? y : null;
    }

    async vodInfo(item) {
        const source = await sources.getById(item.source_id);
        if (!source || source.type !== 'xtream') return null;

        const key = `vod_info_${item.item_id}`;
        const cached = cache.get('xtream', source.id, key, VOD_INFO_MAX_AGE_MS);
        if (cached) return cached;

        const api = xtreamApi.createFromSource(source);
        const data = await api.getVodInfo(item.item_id);
        cache.set('xtream', source.id, key, data);
        return data;
    }

    // ----------------------------------------------------------
    // Persistence
    // ----------------------------------------------------------

    hasTitle(kind, tmdbId) {
        const db = getDb();
        return !!db.prepare('SELECT 1 FROM tmdb_titles WHERE kind = ? AND tmdb_id = ?')
            .get(kind, tmdbId);
    }

    saveTitle(kind, full) {
        const db = getDb();
        const date = full.release_date || full.first_air_date || '';
        const runtime = full.runtime
            ?? (Array.isArray(full.episode_run_time) ? full.episode_run_time[0] : null);

        db.prepare(`
            INSERT INTO tmdb_titles (
                kind, tmdb_id, title, original_title, year, overview,
                poster_path, backdrop_path, genres, runtime, vote_average,
                status, data, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, tmdb_id) DO UPDATE SET
                title = excluded.title,
                original_title = excluded.original_title,
                year = excluded.year,
                overview = excluded.overview,
                poster_path = excluded.poster_path,
                backdrop_path = excluded.backdrop_path,
                genres = excluded.genres,
                runtime = excluded.runtime,
                vote_average = excluded.vote_average,
                status = excluded.status,
                data = excluded.data,
                fetched_at = excluded.fetched_at
        `).run(
            kind,
            full.id,
            full.title || full.name || null,
            full.original_title || full.original_name || null,
            date ? String(date).slice(0, 4) : null,
            full.overview || null,
            full.poster_path || null,
            full.backdrop_path || null,
            JSON.stringify((full.genres || []).map(g => g.name)),
            runtime ?? null,
            full.vote_average ?? null,
            full.status || null,
            JSON.stringify(full),
            Date.now()
        );
    }

    saveLink(item, tmdbId, status, confidence, kind = null) {
        const db = getDb();
        db.prepare(`
            INSERT INTO tmdb_links (
                item_id, kind, tmdb_id, status, confidence,
                matched_name, attempts, last_attempt_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                kind = excluded.kind,
                tmdb_id = excluded.tmdb_id,
                status = excluded.status,
                confidence = excluded.confidence,
                -- a rename restarts the count: it is a new question, not
                -- another go at the one that kept failing
                attempts = CASE WHEN tmdb_links.matched_name = excluded.matched_name
                                THEN tmdb_links.attempts + 1 ELSE 1 END,
                matched_name = excluded.matched_name,
                last_attempt_at = excluded.last_attempt_at
        `).run(item.id, kind, tmdbId, status, confidence, item.name, Date.now());
    }

    /**
     * Links whose catalogue entry is gone. Providers renumber their stream
     * ids and purgeStaleItems then drops the row; the id never comes back,
     * so the link is dead weight. The metadata itself is untouched.
     */
    purgeOrphanLinks() {
        const db = getDb();
        const { changes } = db.prepare(`
            DELETE FROM tmdb_links
            WHERE item_id NOT IN (SELECT id FROM playlist_items)
        `).run();
        if (changes > 0) console.log(`[TMDB] Dropped ${changes} orphan links`);
        return changes;
    }

    // ----------------------------------------------------------
    // Reporting
    // ----------------------------------------------------------

    getStatus() {
        const db = getDb();
        const one = sql => db.prepare(sql).get().c;
        return {
            enabled: this.isEnabled(),
            running: this._running,
            lastPass: this._lastPass,
            catalogue: one(`SELECT COUNT(*) c FROM playlist_items
                            WHERE type IN ('movie','series')`),
            matched: one(`SELECT COUNT(*) c FROM tmdb_links WHERE status = 'matched'`),
            unmatched: one(`SELECT COUNT(*) c FROM tmdb_links WHERE status = 'unmatched'`),
            works: one(`SELECT COUNT(*) c FROM tmdb_titles`),
            pending: this.countPending()
        };
    }

    /** The metadata for one catalogue entry, or null. */
    getForItem(itemId) {
        const db = getDb();
        return db.prepare(`
            SELECT t.*, l.confidence
            FROM tmdb_links l
            JOIN tmdb_titles t ON t.kind = l.kind AND t.tmdb_id = l.tmdb_id
            WHERE l.item_id = ? AND l.status = 'matched'
        `).get(itemId) || null;
    }
}

module.exports = new TmdbEnricher();
