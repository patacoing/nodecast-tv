/**
 * Tests for catalogue identity.
 *
 * The id used to be `source:providerId`, and the provider numbers each
 * kind of content from its own sequence: measured on this account, 6410
 * of 6524 series shared an id with a live channel. Both landed on the same
 * row, and the upsert updated the name and payload but not the `type`
 * column -- so series were written into channels' rows and kept calling
 * themselves channels. The sync reported saving 6519 series; the table
 * held 401, and 6082 rows carried a type contradicting their contents.
 */
const fs = require('fs');
const path = require('path');
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { itemId, parseItemId } = require('../server/services/itemId');

describe('catalogue identity', () => {
    it('keeps a series and a live channel of the same number apart', () => {
        // The whole bug in one assertion
        assert.notEqual(itemId(10, 'live', 8117), itemId(10, 'series', 8117));
    });

    it('reads one back apart', () => {
        assert.deepEqual(parseItemId('10:series:8117'),
            { sourceId: '10', type: 'series', providerId: '8117' });
    });

    it('refuses the old two-part form, which is how a migration spots it', () => {
        assert.equal(parseItemId('10:8117'), null);
    });

    it('survives a provider id that contains a colon', () => {
        // EPG channel ids are names, not numbers: "13emerue.fr"
        const id = itemId(10, 'epg_channel', 'a:b');
        assert.deepEqual(parseItemId(id),
            { sourceId: '10', type: 'epg_channel', providerId: 'a:b' });
    });

    it('is the only place the format is written', () => {
        // It drifted once between the sync that writes ids and the pages
        // that ask for them; a grep is the cheapest guard against a third
        // copy appearing
        const sync = fs.readFileSync(path.join(__dirname, '..', 'server',
            'services', 'syncService.js'), 'utf8');
        assert.equal(/`\$\{sourceId\}:\$\{itemId\}`/.test(sync), false,
            'syncService must not build an id itself');
        assert.match(sync, /makeItemId\(/);
    });
});

describe('migrating stored ids', () => {
    let db;
    const migrate = (() => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'sqlite.js'), 'utf8');
        const body = src.slice(src.indexOf('function migrateItemIdsToTyped'));
        const end = body.indexOf('\n}\n');
        return new Function('log', 'return ' + body.slice(0, end + 2))(
            { info() { }, warn() { } });
    })();

    beforeEach(() => {
        db = new Database(':memory:');
        db.exec(`
            CREATE TABLE playlist_items (id TEXT PRIMARY KEY, source_id INTEGER,
                item_id TEXT, type TEXT, name TEXT);
            CREATE TABLE tmdb_links (item_id TEXT PRIMARY KEY, kind TEXT, tmdb_id INTEGER);
            CREATE TABLE item_details (item_id TEXT PRIMARY KEY, plot TEXT);
            CREATE TABLE downloads (item_id TEXT PRIMARY KEY, kind TEXT, name TEXT);
        `);
    });

    it('renames the catalogue using each row\'s own type', () => {
        db.prepare(`INSERT INTO playlist_items VALUES ('10:8117', 10, '8117', 'live', 'TF1')`).run();
        db.prepare(`INSERT INTO playlist_items VALUES ('10:42', 10, '42', 'movie', 'Anora')`).run();
        migrate(db);
        assert.deepEqual(db.prepare('SELECT id FROM playlist_items ORDER BY id').all()
            .map(r => r.id), ['10:live:8117', '10:movie:42']);
    });

    it('remaps the expensive tables from the kind they recorded', () => {
        // Thirteen thousand rows that took days of TMDB calls; rebuilding
        // them was not an option
        db.prepare(`INSERT INTO playlist_items VALUES ('10:42', 10, '42', 'movie', 'x')`).run();
        db.prepare(`INSERT INTO tmdb_links VALUES ('10:42', 'movie', 999)`).run();
        db.prepare(`INSERT INTO item_details VALUES ('10:42', 'a plot')`).run();
        migrate(db);
        assert.equal(db.prepare('SELECT item_id FROM tmdb_links').get().item_id, '10:movie:42');
        assert.equal(db.prepare('SELECT item_id FROM item_details').get().item_id, '10:movie:42');
    });

    it("translates TMDB's word for a series into the catalogue's", () => {
        db.prepare(`INSERT INTO playlist_items VALUES ('10:7', 10, '7', 'series', 'x')`).run();
        db.prepare(`INSERT INTO tmdb_links VALUES ('10:7', 'tv', 1)`).run();
        migrate(db);
        assert.equal(db.prepare('SELECT item_id FROM tmdb_links').get().item_id, '10:series:7');
    });

    it('drops enrichment rows whose kind was never recorded', () => {
        // Negative cache, cheaper to forget than to guess wrong and strand
        db.prepare(`INSERT INTO playlist_items VALUES ('10:9', 10, '9', 'movie', 'x')`).run();
        db.prepare(`INSERT INTO tmdb_links VALUES ('10:9', NULL, NULL)`).run();
        migrate(db);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM tmdb_links').get().n, 0);
    });

    it('keeps a film already on disk pointing at the film', () => {
        db.prepare(`INSERT INTO playlist_items VALUES ('10:61610', 10, '61610', 'movie', 'x')`).run();
        db.prepare(`INSERT INTO downloads VALUES ('10:61610', 'movie', 'Le Labyrinthe')`).run();
        migrate(db);
        assert.equal(db.prepare('SELECT item_id FROM downloads').get().item_id, '10:movie:61610');
    });

    it('leaves an episode download alone, it has its own scheme', () => {
        db.prepare(`INSERT INTO downloads VALUES ('ep:10:368:28595', 'episode', 'S02E01')`).run();
        migrate(db);
        assert.equal(db.prepare('SELECT item_id FROM downloads').get().item_id, 'ep:10:368:28595');
    });

    it('does nothing the second time it runs', () => {
        db.prepare(`INSERT INTO playlist_items VALUES ('10:42', 10, '42', 'movie', 'x')`).run();
        db.prepare(`INSERT INTO tmdb_links VALUES ('10:42', 'movie', 1)`).run();
        migrate(db);
        const after = db.prepare('SELECT id FROM playlist_items').all();
        migrate(db);
        assert.deepEqual(db.prepare('SELECT id FROM playlist_items').all(), after);
        assert.equal(db.prepare('SELECT item_id FROM tmdb_links').get().item_id, '10:movie:42');
    });

    it('leaves a fresh database untouched', () => {
        assert.doesNotThrow(() => migrate(db));
    });
});
