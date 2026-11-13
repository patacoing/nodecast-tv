/**
 * Tests for the telemetry layer.
 *
 * The logger is the part with real logic: 233 console calls were converted
 * mechanically to it, so it has to accept console's call shapes exactly --
 * several arguments, format specifiers, an Error anywhere in the list --
 * and it must never be the thing that throws in a catch block.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const LOGGER = path.join(__dirname, '..', 'server', 'telemetry', 'logger.js');

/** Load the logger afresh with the given environment, capturing its output. */
function load(env = {}) {
    for (const k of ['LOG_LEVEL', 'LOG_FORMAT']) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve(LOGGER)];

    const lines = { out: [], err: [] };
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s) => { lines.out.push(s); return true; };
    process.stderr.write = (s) => { lines.err.push(s); return true; };
    const log = require(LOGGER);
    const restore = () => { process.stdout.write = realOut; process.stderr.write = realErr; };
    return { log, lines, restore };
}

function parse(raw) { return raw.map(s => JSON.parse(s)); }

describe('structured logging', () => {
    let h;
    beforeEach(() => { h = load({ LOG_FORMAT: 'json' }); });
    afterEach(() => h.restore());

    it('writes one JSON object per line', () => {
        h.log.info('hello');
        h.restore();
        assert.equal(h.lines.out.length, 1);
        assert.equal(h.lines.out[0].endsWith('\n'), true);
        const line = JSON.parse(h.lines.out[0]);
        assert.equal(line.msg, 'hello');
        assert.equal(line.level, 'info');
        assert.match(line.ts, /^\d{4}-\d\d-\d\dT/);
    });

    it('joins several arguments the way console does', () => {
        h.log.info('Preparing', 'Le Labyrinthe', 2540);
        h.restore();
        assert.equal(parse(h.lines.out)[0].msg, 'Preparing Le Labyrinthe 2540');
    });

    it('honours format specifiers', () => {
        // The converted calls include printf-style ones
        h.log.info('%s took %d ms', 'sync', 412);
        h.restore();
        assert.equal(parse(h.lines.out)[0].msg, 'sync took 412 ms');
    });

    it('lifts a [Prefix] into a component field', () => {
        // The prefix convention was the closest thing the server had to a
        // component, and it makes every line about one subsystem
        // selectable without matching on message text
        h.log.info('[Downloads] Preparing a film');
        h.restore();
        const line = parse(h.lines.out)[0];
        assert.equal(line.component, 'Downloads');
        assert.equal(line.msg, 'Preparing a film');
    });

    it('leaves a line with no prefix alone', () => {
        h.log.info('Server error: something');
        h.restore();
        const line = parse(h.lines.out)[0];
        assert.equal(line.component, undefined);
        assert.equal(line.msg, 'Server error: something');
    });

    it('merges a trailing object into the line as fields', () => {
        h.log.warn('[HLS] refused', { code: 403, channel: 'TF1' });
        h.restore();
        const line = parse(h.lines.err)[0];
        assert.equal(line.code, 403);
        assert.equal(line.channel, 'TF1');
        assert.equal(line.msg, 'refused');
    });

    it('keeps an error out of the message and in its own field', () => {
        // Splicing a stack through the middle of a message makes both
        // unreadable
        h.log.error('[Sync] failed', new Error('boom'));
        h.restore();
        const line = parse(h.lines.err)[0];
        assert.equal(line.msg, 'failed Error: boom');
        assert.equal(line.error.name, 'Error');
        assert.equal(line.error.message, 'boom');
        assert.match(line.error.stack, /Error: boom/);
    });

    it('sends warnings and errors to stderr, the rest to stdout', () => {
        h.log.info('a'); h.log.warn('b'); h.log.error('c');
        h.restore();
        assert.equal(h.lines.out.length, 1);
        assert.equal(h.lines.err.length, 2);
    });

    it('drops anything below the configured level', () => {
        h.restore();
        const q = load({ LOG_FORMAT: 'json', LOG_LEVEL: 'warn' });
        q.log.debug('x'); q.log.info('y'); q.log.warn('z');
        q.restore();
        assert.equal(q.lines.out.length, 0);
        assert.equal(parse(q.lines.err)[0].msg, 'z');
    });

    it('never throws, whatever it is handed', () => {
        // It is called from catch blocks: throwing here would replace the
        // original failure with its own
        const circular = {}; circular.self = circular;
        assert.doesNotThrow(() => {
            h.log.info(undefined);
            h.log.info(null, 'x');
            h.log.error(circular);
            h.log.info(Symbol('s'));
            h.log.warn([1, 2, 3]);
        });
        h.restore();
    });

    it('writes readable lines when a terminal is attached', () => {
        h.restore();
        const t = load({ LOG_FORMAT: 'text' });
        t.log.info('[Sync] Starting');
        t.restore();
        assert.match(t.lines.out[0], /INFO\s+\[Sync\] Starting/);
        assert.equal(t.lines.out[0].startsWith('{'), false);
    });
});

describe('the prefix split', () => {
    const { splitPrefix } = require('../server/telemetry/logger');

    it('takes the first bracketed word', () => {
        assert.deepEqual(splitPrefix('[Proxy] up'), { component: 'Proxy', message: 'up' });
    });

    it('ignores a bracket that is not at the start', () => {
        assert.deepEqual(splitPrefix('error in [Proxy]'),
            { component: undefined, message: 'error in [Proxy]' });
    });

    it('refuses an implausibly long prefix', () => {
        const long = '[' + 'x'.repeat(60) + '] hello';
        assert.equal(splitPrefix(long).component, undefined);
    });

    it('handles a session id inside the prefix', () => {
        // "[TranscodeSession 75ff1dfc] Stopping" is a real line
        assert.deepEqual(splitPrefix('[TranscodeSession 75ff1dfc] Stopping'),
            { component: 'TranscodeSession 75ff1dfc', message: 'Stopping' });
    });
});

describe('the instruments', () => {
    const m = require('../server/telemetry/metrics');

    it('exposes the ones the call sites use', () => {
        for (const name of ['upstreamRequests', 'upstreamDuration', 'transcodeSessions',
                            'transcodeStarts', 'probeResults', 'downloadsStarted',
                            'downloadsFinished', 'downloadBytes', 'syncRuns',
                            'syncDuration', 'tmdbRequests']) {
            assert.equal(typeof m[name], 'object', `${name} missing`);
        }
    });

    it('records without a collector attached', () => {
        // Nothing is exporting in a test run, and the call sites are not
        // guarded, so recording has to be safe on its own
        assert.doesNotThrow(() => {
            m.upstreamRequests.add(1, { kind: 'stream', outcome: 'refused' });
            m.upstreamDuration.record(0.42, { kind: 'stream' });
            m.transcodeSessions.add(1);
            m.transcodeSessions.add(-1);
            m.downloadBytes.record(2.5 * 1024 ** 3, { kind: 'movie' });
        });
    });

    it('survives a database that cannot be read', () => {
        // The gauges run inside a scrape; a broken query must not take the
        // endpoint down with it
        assert.doesNotThrow(() => m.registerCatalogueGauges(() => {
            throw new Error('no database');
        }));
    });
});
