/**
 * Preparing films for offline viewing.
 *
 * The catalogue cannot simply be copied to a phone: four fifths of it
 * carries AC3 or E-AC3 audio, which the server fixes on the fly during
 * playback and which nothing on a phone will decode on its own. So a
 * download is remuxed to MP4 with AAC audio first. The picture is copied
 * untouched, so the work is bound by the provider's throughput rather than
 * the processor -- measured at about 47 Mb/s, which puts a three gigabyte
 * film at roughly nine minutes.
 *
 * The file is prepared in full before it is offered, rather than remuxed
 * into the response. That costs the wait, and buys a known size, a
 * resumable transfer and an index at the front of the file so the player
 * can seek. Someone downloading a film for a flight is doing it over hotel
 * wifi; starting again from zero at eighty per cent is the failure worth
 * designing against.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getDb } = require('../db/sqlite');
const db = require('../db');
const cache = require('./cache');
const xtreamApi = require('./xtreamApi');

const DIR = path.join(__dirname, '..', '..', 'data', 'downloads');

// How many films may be held at once. Two of them already take six to ten
// gigabytes of the fifteen this server has free.
const MAX_FILMS = 2;

// Refuse to start when finishing would leave the disk this close to full.
// A full disk does not just fail the download: it takes the database and
// the transcoding cache with it.
const FREE_FLOOR_BYTES = 2 * 1024 ** 3;

// What a film is assumed to weigh when the provider never told us.
const ASSUMED_SIZE_BYTES = 4 * 1024 ** 3;

// A signed link lives long enough to start a download and be retried, not
// long enough to be worth passing around.
const LINK_TTL_MS = 6 * 3600 * 1000;

let running = false;

function ensureDir() {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    return DIR;
}

function secret() {
    return process.env.JWT_SECRET || 'nodecast-tv-secret-key-change-in-production';
}

// ----------------------------------------------------------
// Signed links
// ----------------------------------------------------------

/**
 * A phone's download manager does not send the Authorization header -- the
 * app adds it from JavaScript, and a plain link leaves without it. So the
 * link carries its own proof instead.
 */
function signLink(itemId, ttlMs = LINK_TTL_MS) {
    const expires = Date.now() + ttlMs;
    return { expires, signature: sign(itemId, expires) };
}

function sign(itemId, expires) {
    return crypto.createHmac('sha256', secret())
        .update(`${itemId}:${expires}`).digest('hex');
}

function verifyLink(itemId, expires, signature) {
    const n = Number(expires);
    if (!Number.isFinite(n) || n < Date.now()) return false;

    const expected = Buffer.from(sign(itemId, n));
    const given = Buffer.from(String(signature || ''));
    // Lengths must match before the constant-time compare will look at them
    return expected.length === given.length
        && crypto.timingSafeEqual(expected, given);
}

// ----------------------------------------------------------
// Bookkeeping
// ----------------------------------------------------------

function list() {
    return getDb().prepare(
        'SELECT * FROM downloads ORDER BY requested_at DESC').all();
}

function get(itemId) {
    return getDb().prepare('SELECT * FROM downloads WHERE item_id = ?')
        .get(itemId) || null;
}

/** Everything that holds disk space or is about to. */
function heldCount() {
    return getDb().prepare(`SELECT COUNT(*) c FROM downloads
        WHERE status IN ('ready', 'queued', 'running')`).get().c;
}

function freeBytes() {
    try {
        const s = fs.statfsSync(ensureDir());
        return s.bsize * s.bavail;
    } catch {
        return Infinity;   // cannot tell; the ffmpeg run will fail honestly
    }
}

/**
 * What the finished file is likely to weigh, from what the provider said
 * about the source. The audio shrinks a little and the picture is copied,
 * so the source size is a fair upper bound.
 */
async function estimateBytes(item) {
    try {
        const info = await vodInfo(item);
        const br = Number(info?.info?.bitrate);
        const secs = Number(info?.info?.duration_secs);
        if (br > 0 && secs > 0) return (br * 1000 * secs) / 8;
    } catch { /* fall through */ }
    return ASSUMED_SIZE_BYTES;
}

async function vodInfo(item) {
    const source = await db.sources.getById(item.source_id);
    if (!source || source.type !== 'xtream') return null;
    const key = `vod_info_${item.item_id}`;
    const cached = cache.get('xtream', source.id, key, 30 * 24 * 3600 * 1000);
    if (cached) return cached;
    const api = xtreamApi.createFromSource(source);
    const data = await api.getVodInfo(item.item_id);
    cache.set('xtream', source.id, key, data);
    return data;
}

// ----------------------------------------------------------
// The queue
// ----------------------------------------------------------

/**
 * Ask for a film. Returns { ok } or { ok: false, reason, ... } -- a refusal
 * is an answer, not an error, and the caller shows it.
 */
async function request(itemId) {
    const item = getDb().prepare(`SELECT id, source_id, item_id, name, type,
        container_extension FROM playlist_items WHERE id = ?`).get(itemId);
    if (!item) return { ok: false, reason: 'unknown' };
    if (item.type !== 'movie') return { ok: false, reason: 'not-a-film' };

    const existing = get(itemId);
    if (existing && existing.status !== 'failed') {
        return { ok: true, already: existing.status };
    }

    // The quota is refused rather than enforced by eviction. Silently
    // deleting the film someone was keeping for a flight is the worst
    // thing this could do.
    if (!existing && heldCount() >= MAX_FILMS) {
        return {
            ok: false, reason: 'quota', max: MAX_FILMS,
            held: list().filter(d => d.status !== 'failed')
                .map(d => ({ item_id: d.item_id, name: d.name, status: d.status }))
        };
    }

    const estimate = await estimateBytes(item);
    if (freeBytes() - estimate < FREE_FLOOR_BYTES) {
        return { ok: false, reason: 'disk', needed: Math.round(estimate) };
    }

    const info = await vodInfo(item).catch(() => null);
    getDb().prepare(`
        INSERT INTO downloads (item_id, name, status, duration, requested_at)
        VALUES (?, ?, 'queued', ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
            status = 'queued', error = NULL, progress = 0,
            requested_at = excluded.requested_at
    `).run(itemId, item.name, Number(info?.info?.duration_secs) || null, Date.now());

    pump();
    return { ok: true, already: null };
}

function remove(itemId) {
    const row = get(itemId);
    if (!row) return false;
    // A running job is not interrupted here: killing ffmpeg mid-write and
    // deleting under it invites a half-file that looks finished. It is
    // marked instead and cleaned up when it ends.
    if (row.status === 'running') {
        getDb().prepare(`UPDATE downloads SET status='failed', error='cancelled'
            WHERE item_id = ?`).run(itemId);
        return true;
    }
    if (row.path) { try { fs.unlinkSync(row.path); } catch { /* already gone */ } }
    getDb().prepare('DELETE FROM downloads WHERE item_id = ?').run(itemId);
    return true;
}

/** One film at a time: two pulls share the provider's throughput and gain nothing. */
function pump() {
    if (running) return;
    const next = getDb().prepare(
        `SELECT * FROM downloads WHERE status = 'queued'
         ORDER BY requested_at LIMIT 1`).get();
    if (!next) return;

    running = true;
    prepare(next)
        .catch(err => {
            console.error('[Downloads] Failed:', err.message);
            getDb().prepare(`UPDATE downloads SET status='failed', error=?
                WHERE item_id = ?`).run(String(err.message).slice(0, 300), next.item_id);
        })
        .finally(() => { running = false; pump(); });
}

async function prepare(row) {
    const item = getDb().prepare(`SELECT id, source_id, item_id, name,
        container_extension FROM playlist_items WHERE id = ?`).get(row.item_id);
    if (!item) throw new Error('no longer in the catalogue');

    const source = await db.sources.getById(item.source_id);
    if (!source) throw new Error('source is gone');

    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    const url = `${source.url.replace(/\/+$/, '')}/movie/`
        + `${source.username}/${source.password}/`
        + `${item.item_id}.${item.container_extension || 'mp4'}`;

    const detail = getDb().prepare(
        'SELECT audio_codec FROM item_details WHERE item_id = ?').get(row.item_id);
    // Already something a phone decodes: copy it and leave it alone.
    const audioOk = ['aac', 'mp3'].includes(
        String(detail?.audio_codec || '').toLowerCase());

    const out = path.join(ensureDir(), `${row.item_id.replace(/[^\w.-]/g, '_')}.mp4`);
    getDb().prepare(`UPDATE downloads SET status='running', path=?, progress=0
        WHERE item_id = ?`).run(out, row.item_id);
    console.log(`[Downloads] Preparing ${item.name}${audioOk ? ' (copy)' : ' (audio to aac)'}`);

    await runFfmpeg(url, out, userAgent, audioOk, row);

    // A job cancelled while it ran leaves its row marked; honour that
    // rather than announcing a file nobody asked for any more.
    const after = get(row.item_id);
    if (!after || after.status === 'failed') {
        try { fs.unlinkSync(out); } catch { /* nothing to remove */ }
        return;
    }

    const size = fs.statSync(out).size;
    getDb().prepare(`UPDATE downloads SET status='ready', size=?, progress=1,
        ready_at=? WHERE item_id = ?`).run(size, Date.now(), row.item_id);
    console.log(`[Downloads] Ready: ${item.name} (${(size / 1024 ** 3).toFixed(1)}GB)`);
}

function runFfmpeg(url, out, userAgent, audioOk, row) {
    return new Promise((resolve, reject) => {
        const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
        const args = [
            '-hide_banner', '-loglevel', 'error',
            // Without a browser's user agent this provider closes the
            // connection after ten megabytes of a three gigabyte file.
            '-user_agent', userAgent,
            '-i', url,
            '-map', '0:v:0', '-map', '0:a:0?',
            '-c:v', 'copy',
            ...(audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
            // The index goes at the front, or the player cannot seek
            '-movflags', '+faststart',
            '-progress', 'pipe:1', '-nostats',
            '-y', out
        ];

        const proc = spawn(ffmpegPath, args);
        let stderr = '';
        let lastWrite = 0;

        proc.stdout.on('data', chunk => {
            const m = /out_time_ms=(\d+)/.exec(String(chunk));
            if (!m || !row.duration) return;
            const done = Math.min(1, Number(m[1]) / 1e6 / row.duration);
            // Written at most once a second: this runs for minutes
            if (Date.now() - lastWrite < 1000) return;
            lastWrite = Date.now();
            getDb().prepare('UPDATE downloads SET progress=? WHERE item_id=?')
                .run(done, row.item_id);
        });
        proc.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });

        proc.on('error', reject);
        proc.on('close', code => code === 0
            ? resolve()
            : reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`)));
    });
}

/**
 * A job that was running when the server stopped left a partial file that
 * would otherwise pass for a finished one.
 */
function recoverInterrupted() {
    const stale = getDb().prepare(
        `SELECT * FROM downloads WHERE status = 'running'`).all();
    for (const row of stale) {
        if (row.path) { try { fs.unlinkSync(row.path); } catch { /* gone */ } }
        getDb().prepare(`UPDATE downloads SET status='failed',
            error='interrupted by a restart' WHERE item_id = ?`).run(row.item_id);
    }
    if (stale.length) console.log(`[Downloads] ${stale.length} interrupted, marked failed`);
    pump();
}

module.exports = {
    list, get, request, remove, recoverInterrupted,
    signLink, verifyLink, freeBytes,
    MAX_FILMS, DIR
};
