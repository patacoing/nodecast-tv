/**
 * What a reconnection leaves behind.
 *
 * ffmpeg's delete_segments only removes what the process now running
 * wrote. A reconnected process inherits the playlist but not the
 * bookkeeping, so the previous one's segments stay on disk for as long as
 * the session lives -- a channel that drops often keeps accumulating
 * files nobody will ever ask for.
 *
 * Real files in a real temporary directory, since the point of the thing
 * is which ones are on disk afterwards.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { TranscodeSession } = require('../server/services/transcodeSession');

let dir, session;

/** An ffmpeg-shaped playlist listing exactly these segments. */
function writePlaylist(names) {
    const body = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const n of names) body.push('#EXTINF:4.000000,', n);
    fs.writeFileSync(path.join(dir, 'stream.m3u8'), body.join('\n') + '\n');
}

/** A segment file, aged by backdating its mtime. */
function writeSegment(name, ageMs = 0) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    if (ageMs) {
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(file, when, when);
    }
}

const onDisk = () => fs.readdirSync(dir).filter(n => n.endsWith('.ts')).sort();

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-'));
    session = new TranscodeSession('http://p.tv/live/u/p/471.m3u8', { isLive: true });
    session.dir = dir;
    session.playlistPath = path.join(dir, 'stream.m3u8');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('pruning the segments a reconnection left behind', () => {
    it('removes what the playlist no longer lists', async () => {
        writePlaylist(['seg0079.ts', 'seg0080.ts']);
        writeSegment('seg0079.ts');
        writeSegment('seg0080.ts');
        writeSegment('seg0001.ts', 5 * 60 * 1000);   // from a dead process
        writeSegment('seg0014.ts', 5 * 60 * 1000);

        assert.equal(await session.pruneOrphanSegments(), 2);
        assert.deepEqual(onDisk(), ['seg0079.ts', 'seg0080.ts']);
    });

    it('keeps what the playlist still lists, however old', async () => {
        writePlaylist(['seg0001.ts']);
        writeSegment('seg0001.ts', 60 * 60 * 1000);
        assert.equal(await session.pruneOrphanSegments(), 0);
        assert.deepEqual(onDisk(), ['seg0001.ts']);
    });

    it('leaves a freshly dropped segment alone for the grace period', async () => {
        // A player holds the playlist it last loaded, so a segment can
        // still be asked for just after it stopped being listed.
        writePlaylist(['seg0080.ts']);
        writeSegment('seg0080.ts');
        writeSegment('seg0079.ts');   // left the window a moment ago
        assert.equal(await session.pruneOrphanSegments(), 0);
        assert.deepEqual(onDisk(), ['seg0079.ts', 'seg0080.ts']);
    });

    it('takes it once the grace period has passed', async () => {
        writePlaylist(['seg0080.ts']);
        writeSegment('seg0080.ts');
        writeSegment('seg0079.ts', 90 * 1000);
        assert.equal(await session.pruneOrphanSegments(), 1);
        assert.deepEqual(onDisk(), ['seg0080.ts']);
    });

    it('touches nothing when there is no playlist to judge against', async () => {
        // Mid-start, or after a cleanup: the files are not litter just
        // because nothing lists them yet.
        writeSegment('seg0000.ts', 5 * 60 * 1000);
        assert.equal(await session.pruneOrphanSegments(), 0);
        assert.deepEqual(onDisk(), ['seg0000.ts']);
    });

    it('leaves files that are not segments', async () => {
        writePlaylist([]);
        fs.writeFileSync(path.join(dir, 'session.json'), '{}');
        const when = new Date(Date.now() - 5 * 60 * 1000);
        fs.utimesSync(path.join(dir, 'session.json'), when, when);
        assert.equal(await session.pruneOrphanSegments(), 0);
        assert.ok(fs.existsSync(path.join(dir, 'session.json')));
    });

    it('survives a directory that has gone away', async () => {
        writePlaylist(['seg0000.ts']);
        const playlist = await fsp.readFile(session.playlistPath, 'utf8');
        assert.ok(playlist.includes('seg0000.ts'));
        fs.rmSync(dir, { recursive: true, force: true });
        assert.equal(await session.pruneOrphanSegments(), 0);
        fs.mkdirSync(dir, { recursive: true });   // for afterEach
    });

    it('is run after a reconnection takes hold', () => {
        const SRC = fs.readFileSync(
            path.join(__dirname, '../server/services/transcodeSession.js'), 'utf8');
        const at = SRC.indexOf('scheduleLiveRestart() {');
        assert.notEqual(at, -1);
        assert.match(SRC.slice(at, at + 1400), /pruneOrphanSegments/);
    });

    it('is run again by the periodic sweep, which is a generation ahead', () => {
        const SRC = fs.readFileSync(
            path.join(__dirname, '../server/services/transcodeSession.js'), 'utf8');
        const at = SRC.indexOf('async function cleanupStaleSessions()');
        assert.notEqual(at, -1);
        assert.match(SRC.slice(at, at + 700), /pruneOrphanSegments/);
    });
});
