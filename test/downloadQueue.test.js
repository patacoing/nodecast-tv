/**
 * Tests for what the download queue accepts and how it addresses it.
 *
 * Two things changed when episodes joined films, and both are the kind of
 * mistake that only shows up as a file on someone's phone: an episode has
 * no catalogue row to look anything up in, and it is served under a
 * different path than a film. The provider does not refuse a film URL
 * carrying an episode id -- it answers with something short and unrelated.
 *
 * The manager is given a real SQLite database in memory rather than a
 * stubbed one, so the SQL is exercised as written.
 */
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');

const GB = 1024 ** 3;

let db, manager;

/** Put a module in the cache under the name the manager will ask for. */
function stub(request, exports) {
    const resolved = require.resolve(
        path.join(__dirname, '..', 'server', 'services', request));
    require.cache[resolved] = { id: resolved, filename: resolved,
        loaded: true, exports };
}

before(() => {
    db = new Database(':memory:');
    db.exec(`
        CREATE TABLE playlist_items (id TEXT PRIMARY KEY, source_id INTEGER,
            item_id TEXT, name TEXT, type TEXT, container_extension TEXT);
        CREATE TABLE item_details (item_id TEXT PRIMARY KEY, audio_codec TEXT);
        CREATE TABLE downloads (item_id TEXT PRIMARY KEY, name TEXT,
            status TEXT NOT NULL, path TEXT, size INTEGER, duration INTEGER,
            progress REAL DEFAULT 0, error TEXT, requested_at INTEGER NOT NULL,
            ready_at INTEGER, kind TEXT, source_id INTEGER, stream_id TEXT,
            container_extension TEXT, audio_codec TEXT, estimate INTEGER);
    `);
    db.prepare(`INSERT INTO playlist_items VALUES
        ('7', 1, '555', 'Le Labyrinthe', 'movie', 'mkv')`).run();
    db.prepare(`INSERT INTO playlist_items VALUES
        ('9', 1, '900', 'Severance', 'series', NULL)`).run();

    stub('../db/sqlite', { getDb: () => db });
    stub('./cache', { get: () => null, set: () => { } });
    stub('./xtreamApi', {
        createFromSource: () => ({
            getSeriesInfo: async () => INFO,
            getVodInfo: async () => null
        })
    });
    stub('../db', {
        sources: {
            getById: async id => ({
                id, type: 'xtream', url: 'http://p.tv:8080',
                username: 'u', password: 'p'
            })
        },
        // Never resolves. prepare() awaits the settings before it marks a
        // job running or spawns anything, so a queued job stays queued and
        // these tests never start an ffmpeg.
        settings: { get: () => new Promise(() => { }) },
        getUserAgent: () => 'test'
    });

    manager = require('../server/services/downloadManager');
});

beforeEach(() => db.prepare('DELETE FROM downloads').run());

/** A season map the way series_info returns one. */
const INFO = {
    episodes: {
        '1': [{ id: 8801, episode_num: 1, title: 'Good News About Hell',
                container_extension: 'mkv',
                info: { duration_secs: 3000, bitrate: 2000,
                        audio: { codec_name: 'aac' } } }],
        '2': [{ id: 8802, episode_num: 3, title: '',
                info: { duration_secs: 2400, bitrate: 4000 } }]
    }
};

describe('addressing an episode', () => {
    it('serves an episode from /series/, not /movie/', () => {
        const source = { url: 'http://p.tv:8080/', username: 'u', password: 'p' };
        assert.equal(manager.streamUrl(source, 'episode', 8801, 'mkv'),
            'http://p.tv:8080/series/u/p/8801.mkv');
        assert.equal(manager.streamUrl(source, 'movie', 555, 'mkv'),
            'http://p.tv:8080/movie/u/p/555.mkv');
    });

    it('defaults the container when the provider named none', () => {
        const source = { url: 'http://p.tv', username: 'u', password: 'p' };
        assert.equal(manager.streamUrl(source, 'episode', 1, null),
            'http://p.tv/series/u/p/1.mp4');
    });

    it('finds an episode under the season it is listed in', () => {
        // The episode object's own `season` field is not always filled in,
        // so the key it was found under is what the label has to come from
        assert.equal(manager.findEpisode(INFO, 8802).season, '2');
        assert.equal(manager.findEpisode(INFO, '8801').episode.episode_num, 1);
        assert.equal(manager.findEpisode(INFO, 9999), null);
        assert.equal(manager.findEpisode(null, 8801), null);
    });
});

describe('estimating what it will weigh', () => {
    it('reads a bitrate in kb/s against a duration in seconds', () => {
        // 2000 kb/s for 3000 s is 750 MB
        assert.equal(manager.sizeFrom(INFO.episodes['1'][0]), 750 * 1000 * 1000);
    });

    it('says nothing rather than zero when the provider was silent', () => {
        assert.equal(manager.sizeFrom({ info: {} }), null);
        assert.equal(manager.sizeFrom(null), null);
    });
});

describe('the budget', () => {
    it('charges a queued job at its estimate, not at nothing', async () => {
        // Otherwise two requests in a row both slip under the budget by
        // being counted as weighing zero until they finish
        await manager.requestEpisode('9', 8801);
        assert.ok(manager.heldBytes() > 0);
        assert.equal(manager.heldBytes(), 750 * 1000 * 1000);
    });

    it('refuses what does not fit and names what is held', async () => {
        db.prepare(`INSERT INTO downloads (item_id, name, status,
            requested_at, size) VALUES ('7', 'Le Labyrinthe', 'ready', 1, ?)`)
            .run(9.5 * GB);

        const res = await manager.requestEpisode('9', 8801);
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'quota');
        assert.deepEqual(res.held.map(h => h.name), ['Le Labyrinthe']);
        // and nothing was queued behind the refusal
        assert.equal(db.prepare('SELECT COUNT(*) c FROM downloads').get().c, 1);
    });

    it('lets a failed job be retried without charging for it twice', async () => {
        db.prepare(`INSERT INTO downloads (item_id, name, status,
            requested_at, estimate) VALUES ('ep:9:8801', 'S01E01', 'failed', 1, ?)`)
            .run(9.9 * GB);
        const res = await manager.requestEpisode('9', 8801);
        assert.equal(res.ok, true);
    });
});

describe('requesting an episode', () => {
    it('stores everything needed to fetch it later', async () => {
        const res = await manager.requestEpisode('9', 8801);
        assert.equal(res.ok, true);

        const row = db.prepare("SELECT * FROM downloads WHERE item_id = 'ep:9:8801'").get();
        assert.equal(row.kind, 'episode');
        assert.equal(row.source_id, 1);
        assert.equal(row.stream_id, '8801');
        assert.equal(row.container_extension, 'mkv');
        assert.equal(row.audio_codec, 'aac');
        assert.equal(row.duration, 3000);
        assert.equal(row.name, 'Severance S01E01 Good News About Hell');
    });

    it('names an untitled episode by its number alone', async () => {
        await manager.requestEpisode('9', 8802);
        const row = db.prepare("SELECT name FROM downloads WHERE item_id = 'ep:9:8802'").get();
        assert.equal(row.name, 'Severance S02E03');
    });

    it('refuses an episode the provider does not list', async () => {
        const res = await manager.requestEpisode('9', 4242);
        assert.equal(res.reason, 'unknown-episode');
    });

    it('refuses a film addressed as a series', async () => {
        const res = await manager.requestEpisode('7', 8801);
        assert.equal(res.reason, 'not-a-film');
    });

    it('refuses a series that is no longer in the catalogue', async () => {
        const res = await manager.requestEpisode('404', 8801);
        assert.equal(res.reason, 'unknown');
    });
});

/**
 * The name the file arrives under. \w is ASCII-only in JavaScript, so the
 * obvious sanitiser quietly deletes every accent in a French catalogue --
 * "Le bon côté de l'enfer" came out as "Le bon ct de lenfer".
 */
describe('the filename offered to the phone', () => {
    const { disposition } = require('../server/routes/downloads');

    it('keeps accents, in the parameter that can carry them', () => {
        const d = disposition("Severance S01E01 Le bon côté de l'enfer");
        assert.match(d, /filename\*=UTF-8''Severance%20S01E01%20Le%20bon%20c%C3%B4t%C3%A9/);
    });

    it('leaves a folded ASCII name behind for whatever cannot read that', () => {
        assert.match(disposition("Le bon côté de l'enfer"),
            /filename="Le bon cote de l'enfer\.mp4"/);
    });

    it('drops what could break out of the header or the path', () => {
        const d = disposition('a/b\\c"d\re\nf');
        assert.match(d, /filename="abcdef\.mp4"/);
        assert.equal(d.includes('\r'), false);
        assert.equal(d.includes('\n'), false);
    });

    it('does not let a name climb out of the downloads folder', () => {
        assert.match(disposition('../../etc/passwd'), /filename="\.\.\.\.etcpasswd\.mp4"/);
    });

    it('never yields an empty name', () => {
        assert.match(disposition('///'), /filename="film\.mp4"/);
        assert.match(disposition(''), /filename="film\.mp4"/);
        // Nothing survives the ASCII fold here, but the UTF-8 name does
        const d = disposition('日本');
        assert.match(d, /filename="film\.mp4"/);
        assert.match(d, /filename\*=UTF-8''%E6%97%A5%E6%9C%AC/);
    });
});
