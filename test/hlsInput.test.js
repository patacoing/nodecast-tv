/**
 * Tests for the HLS input options.
 *
 * ffmpeg refuses a playlist segment whose file extension is not on a
 * whitelist. This provider's segments carry no extension at all --
 * /hls/hASHnAxCPf6Q61n6lfr4F65OMK... -- so every segment was refused and
 * the input failed with "Invalid data found when processing input".
 * Playback worked throughout, because hls.js in the browser has no such
 * rule; everything that went through ffmpeg did not.
 *
 * The option belongs to the HLS demuxer, so it is only recognised when the
 * input really is a playlist: passing it for an mkv aborts the command
 * with "Option extension_picky not found". That is what these guard.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hlsInputArgs } = require('../server/services/hlsInput');

describe('hls input options', () => {
    it('loosens the extension check for a playlist', () => {
        assert.deepEqual(hlsInputArgs('http://p.tv:9798/live/u/p/498.m3u8'),
            ['-extension_picky', '0']);
    });

    it('still recognises a playlist carrying a query string', () => {
        assert.deepEqual(hlsInputArgs('http://p.tv/a.m3u8?token=x'),
            ['-extension_picky', '0']);
    });

    it('passes nothing for anything that is not a playlist', () => {
        // The option is unknown outside the HLS demuxer and aborts the run
        for (const url of ['http://p.tv/movie/u/p/1.mkv',
                           'http://p.tv/series/u/p/2.mp4',
                           'http://p.tv/live/u/p/3.ts',
                           '/app/data/downloads/x.mp4']) {
            assert.deepEqual(hlsInputArgs(url), [], url);
        }
    });

    it('survives being given nothing', () => {
        assert.deepEqual(hlsInputArgs(undefined), []);
        assert.deepEqual(hlsInputArgs(null), []);
        assert.deepEqual(hlsInputArgs(''), []);
    });

    it('is applied everywhere ffmpeg is pointed at a stream URL', () => {
        // Five call sites, and the fault only showed up in one of them at
        // first. A missing one is a feature that silently fails on this
        // provider, so the set is checked rather than remembered.
        const files = [
            'server/services/transcodeSession.js',
            'server/routes/transcode.js',
            'server/routes/probe.js',
            'server/routes/remux.js',
            'server/routes/subtitle.js'
        ];
        for (const f of files) {
            const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            assert.match(src, /hlsInputArgs\(/, `${f} does not use it`);
        }
    });
});
