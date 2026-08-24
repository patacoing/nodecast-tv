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

// Rows pulled from the database at a time. Not the work done in one pass:
// a pass keeps taking batches until the catalogue is clear or it runs out
// of time, because at a fixed 200 entries every six hours the first
// backfill of a 8500-title library would take a week and a half.
const DEFAULT_BATCH = 200;

// How long a pass may spend. Bounds what the enrichment can cost while
// still letting the initial backfill finish in a handful of passes; a day
// of new titles is done in a fraction of it.
const PASS_BUDGET_MS = 15 * 60 * 1000;

// Consecutive errors that mean the problem is not the titles. TMDB being
// down or the key being rejected should stop the pass, not burn the budget
// failing 8500 times.
const MAX_CONSECUTIVE_ERRORS = 10;

const KIND = { movie: 'movie', series: 'tv' };

/**
 * The YouTube id out of whatever a provider chose to put in the field:
 * a bare id, a watch URL, a short link, an embed. Anything else is
 * discarded rather than guessed at -- a wrong id plays someone else's
 * video over the film you are looking at.
 */
function youtubeId(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;

    const patterns = [
        /[?&]v=([A-Za-z0-9_-]{11})/,
        /youtu\.be\/([A-Za-z0-9_-]{11})/,
        /\/embed\/([A-Za-z0-9_-]{11})/,
        /\/shorts\/([A-Za-z0-9_-]{11})/
    ];
    for (const re of patterns) {
        const m = value.match(re);
        if (m) return m[1];
    }
    return null;
}

/**
 * The one video worth autoplaying behind a film's details, out of the
 * dozen TMDB may list: a proper trailer over a teaser, in the viewer's
 * language over any other, official over a fan upload.
 */
function pickTrailer(videos) {
    const all = (videos?.results || [])
        .filter(v => v.site === 'YouTube' && youtubeId(v.key));
    if (!all.length) return null;

    const rank = v => (
        (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 1 : 2) * 100
        + (v.iso_639_1 === 'fr' ? 0 : v.iso_639_1 === 'en' ? 10 : 20)
        + (v.official ? 0 : 5)
    );
    const best = all.slice().sort((a, b) => rank(a) - rank(b))[0];
    // Anything past a teaser is a clip, a featurette or an interview, and
    // is not what someone lingering on a film's page expects to start.
    return rank(best) < 200 ? youtubeId(best.key) : null;
}

/** The TMDB id the provider already put in its own record, if any. */
function declaredTmdbId(info) {
    const raw = String(info?.info?.tmdb_id ?? '').trim();
    return /^[0-9]+$/.test(raw) && raw !== '0' ? Number(raw) : null;
}

// Shared by the batch query and the count behind it, so the number the
// settings page shows can never drift from what the pass will actually do.
const CANDIDATE_FROM = `
    FROM playlist_items p
    LEFT JOIN tmdb_links l ON l.item_id = p.id
    LEFT JOIN item_details d ON d.item_id = p.id
    WHERE p.type IN ('movie', 'series')
      AND (
            l.item_id IS NULL
         OR (l.status = 'unmatched'
             AND l.attempts < ?
             AND (l.matched_name <> p.name OR l.last_attempt_at < ?))
         -- a film already identified but whose own synopsis we have not
         -- stored yet: the provider's words win over TMDB's, so they have
         -- to be in the database for the details panel to show them
         OR (p.type = 'movie' AND d.item_id IS NULL)
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
    /**
     * `afterId` walks the catalogue forward. Paging by offset would not do:
     * an entry that throws is deliberately left unwritten so the next pass
     * retries it, which keeps it in the result set and, sitting at the head
     * of the ordering, it would crowd out the entries behind it.
     */
    candidates(limit = DEFAULT_BATCH, afterId = '') {
        const retryBefore = Date.now() - RETRY_AFTER_DAYS * 24 * 3600 * 1000;
        return getDb().prepare(`
            SELECT p.id, p.source_id, p.item_id, p.type, p.name, p.year
            ${CANDIDATE_FROM}
              AND p.id > ?
            ORDER BY p.id
            LIMIT ?
        `).all(MAX_ATTEMPTS, retryBefore, afterId, limit);
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
    async runPass({ limit = DEFAULT_BATCH, budgetMs = PASS_BUDGET_MS } = {}) {
        if (!this.isEnabled()) return { skipped: 'disabled' };
        if (this._running) return { skipped: 'already running' };

        this._running = true;
        const started = Date.now();
        const deadline = started + budgetMs;
        let matched = 0, unmatched = 0, failed = 0, examined = 0;
        let consecutiveErrors = 0;
        let stopped = null;

        let cursor = '';

        try {
            this.purgeOrphanLinks();

            while (Date.now() < deadline) {
                const items = this.candidates(limit, cursor);
                if (items.length === 0) { stopped = stopped || 'complete'; break; }

                for (const item of items) {
                    if (Date.now() >= deadline) { stopped = 'budget'; break; }
                    cursor = item.id;
                    examined++;
                    try {
                        const hit = await this.enrichOne(item);
                        if (hit) matched++; else unmatched++;
                        consecutiveErrors = 0;
                    } catch (err) {
                        // A single bad entry must not end the pass or --
                        // worse -- be written down as a definitive "not
                        // found". A run of them means something upstream is
                        // broken and there is no point continuing.
                        failed++;
                        console.warn(`[TMDB] ${item.name}: ${err.message}`);
                        if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            stopped = 'errors';
                            break;
                        }
                    }
                }
                if (stopped) break;
            }

            if (examined === 0) {
                console.log('[TMDB] Nothing left to enrich');
            } else {
                console.log(`[TMDB] Pass ${stopped || 'budget'}: ${matched} matched, `
                    + `${unmatched} unmatched, ${failed} errors, ${this.countPending()} left`);
            }

            const result = {
                matched, unmatched, failed, examined,
                stopped: stopped || 'budget', remaining: this.countPending()
            };
            this._lastPass = { ...result, at: Date.now(), tookMs: Date.now() - started };
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

        // The provider's own record for a film carries the TMDB id outright
        // in about 99% of cases. Guessing from the title when the answer is
        // sitting there would be worse in every way: it costs several
        // searches instead of one lookup, and it cannot identify a title
        // that is ambiguous on its own -- Ant-Man, Rocky, Red -- which the
        // strict matching rightly refuses rather than gamble on.
        const info = item.type === 'movie'
            ? await this.vodInfo(item).catch(() => null)
            : null;

        if (info) this.saveDetails(item, info);

        // Already identified -- this entry only came back for its details.
        if (this.isLinked(item.id)) return true;

        const declared = declaredTmdbId(info);
        if (declared && await this.linkByTmdbId(item, kind, declared)) return true;

        const parsed = parseName(item.name);
        if (!parsed.title) {
            this.saveLink(item, null, 'unmatched', null);
            return false;
        }

        const year = parsed.year || this.yearOf(item, info);

        let choice = await this.searchOnce(kind, parsed.title, year);

        // The other readings of the name: the parenthetical kept or dropped,
        // a trailing number read as a year or as part of the title. Capped
        // so a pathological name cannot cost a dozen searches.
        for (const alt of parsed.alternatives.slice(0, 2)) {
            if (choice) break;
            choice = await this.searchOnce(kind, alt, year);
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

    /**
     * Attach a catalogue entry to a TMDB id we were handed rather than one
     * we worked out. Returns false when TMDB does not recognise the id, so
     * the caller can fall back to matching by title.
     */
    async linkByTmdbId(item, kind, tmdbId) {
        if (!this.hasTitle(kind, tmdbId)) {
            let full;
            try {
                full = await tmdb.details(kind, tmdbId);
            } catch (err) {
                if (/TMDB 404/.test(err.message)) return false;
                throw err;
            }
            this.saveTitle(kind, full);
        }
        this.saveLink(item, tmdbId, 'matched', 1, kind);
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
    yearOf(item, info) {
        if (item.year) {
            const y = Number(String(item.year).slice(0, 4));
            if (Number.isFinite(y) && y > 1800) return y;
        }
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

    isLinked(itemId) {
        return !!getDb()
            .prepare(`SELECT 1 FROM tmdb_links WHERE item_id = ? AND status = 'matched'`)
            .get(itemId);
    }

    /** The provider's own description of a film, from its per-item record. */
    saveDetails(item, info) {
        const i = info?.info || {};
        const runtime = Number(i.duration_secs)
            ? Math.round(Number(i.duration_secs) / 60)
            : null;
        const genres = String(i.genre || '')
            .split(/\s*[,\/]\s*/).map(g => g.trim()).filter(Boolean);

        // This provider answers in two shapes depending on the title, and
        // the second one names things differently. Reading both is free and
        // covers the fifth of the catalogue that comes back that way.
        const plot = i.plot || i.description || null;
        const cast = i.cast || i.actors || null;

        // backdrop is a string in one shape and a list in the other
        const backdrop = Array.isArray(i.backdrop_path)
            ? (i.backdrop_path[0] || null)
            : (i.backdrop || i.backdrop_path || null);

        const rating = Number.parseFloat(i.rating);

        getDb().prepare(`
            INSERT INTO item_details (
                item_id, plot, cast_list, director, genres, runtime, year,
                trailer, backdrop, rating, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                plot = excluded.plot,
                cast_list = excluded.cast_list,
                director = excluded.director,
                genres = excluded.genres,
                runtime = excluded.runtime,
                year = excluded.year,
                trailer = excluded.trailer,
                backdrop = excluded.backdrop,
                rating = excluded.rating,
                fetched_at = excluded.fetched_at
        `).run(
            item.id,
            plot,
            cast,
            i.director || null,
            JSON.stringify(genres),
            runtime,
            String(i.releasedate || i.release_date || '').slice(0, 4) || null,
            youtubeId(i.youtube_trailer),
            backdrop,
            Number.isFinite(rating) && rating > 0 ? rating : null,
            Date.now()
        );
    }

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
                status, trailer, data, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                trailer = excluded.trailer,
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
            pickTrailer(full.videos),
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
     * Forget every unmatched entry so the next pass tries again.
     *
     * Failures are written down precisely so they are not retried for a
     * month, which is right while the matching rules stay put and wrong the
     * moment they improve: without this, a better parser would take thirty
     * days to reach the titles it was written for.
     */
    resetUnmatched() {
        const { changes } = getDb()
            .prepare(`DELETE FROM tmdb_links WHERE status = 'unmatched'`).run();
        console.log(`[TMDB] Cleared ${changes} unmatched entries for retry`);
        return changes;
    }

    /**
     * Links whose catalogue entry is gone. Providers renumber their stream
     * ids and purgeStaleItems then drops the row; the id never comes back,
     * so the link is dead weight. The metadata itself is untouched.
     */
    purgeOrphanLinks() {
        const db = getDb();
        let changes = 0;
        for (const table of ['tmdb_links', 'item_details']) {
            changes += db.prepare(`
                DELETE FROM ${table}
                WHERE item_id NOT IN (SELECT id FROM playlist_items)
            `).run().changes;
        }
        if (changes > 0) console.log(`[TMDB] Dropped ${changes} orphan rows`);
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

    /** What the provider itself said about the entry, or null. */
    getDetailsForItem(itemId) {
        return getDb()
            .prepare('SELECT * FROM item_details WHERE item_id = ?')
            .get(itemId) || null;
    }
}

const enricher = new TmdbEnricher();
module.exports = enricher;
// exposed for the tests
module.exports.declaredTmdbId = declaredTmdbId;
module.exports.youtubeId = youtubeId;
module.exports.pickTrailer = pickTrailer;
