/**
 * Tests for public/js/channelMatcher.js.
 *
 * Only about 5% of the channels in an Xtream catalogue state an EPG id, so
 * everything else is matched on a name written for a set-top box list:
 * "FR || TF1 [SD]" and "TF1" are the same channel and share not one
 * character of spelling.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChannel, indexByName, matchChannel } =
    require('../public/js/channelMatcher');

describe('normalizeChannel', () => {
    it('strips a country prefix', () => {
        assert.equal(normalizeChannel('FR || TF1'), 'tf1');
        assert.equal(normalizeChannel('|FR| TF1'), 'tf1');
        assert.equal(normalizeChannel('FR: TF1'), 'tf1');
    });

    it('strips a bracketed quality tag', () => {
        assert.equal(normalizeChannel('TF1 [SD]'), 'tf1');
        assert.equal(normalizeChannel('TF1 (HD)'), 'tf1');
    });

    it('strips a bare quality tag', () => {
        assert.equal(normalizeChannel('M6 HD'), 'm6');
        assert.equal(normalizeChannel('RMC Story 4K'), 'rmc story');
    });

    it('handles the two spellings of the same channel', () => {
        assert.equal(normalizeChannel('FR || TF1 [SD]'), normalizeChannel('[#] TF1'));
        assert.equal(normalizeChannel('FR || TF1 [SD]'), normalizeChannel('TF1'));
    });

    it('keeps a number that is part of the name', () => {
        assert.equal(normalizeChannel('France 2'), 'france 2');
        assert.equal(normalizeChannel('beIN SPORTS 1 HD'), 'bein sports 1');
    });

    it('does not collapse two different channels', () => {
        assert.notEqual(normalizeChannel('FR || TF1 [SD]'),
            normalizeChannel('FR || TF1 SERIES / FILMS [SD]'));
        assert.notEqual(normalizeChannel('France 2'), normalizeChannel('France 3'));
    });

    it('ignores accents and case', () => {
        assert.equal(normalizeChannel('ARTÉ'), normalizeChannel('arte'));
    });

    it('survives a name that is nothing but decoration', () => {
        assert.equal(normalizeChannel('[SD]'), '');
        assert.equal(normalizeChannel(''), '');
        assert.equal(normalizeChannel(null), '');
    });
});

describe('indexByName', () => {
    it('indexes by the normalised name', () => {
        const idx = indexByName([{ id: 'tf1.fr', name: 'TF1' }]);
        assert.equal(idx.get('tf1').id, 'tf1.fr');
    });

    it('drops a name two indistinguishable channels share', () => {
        // Guessing here puts one channel's schedule against another's, and
        // nothing on screen would say it is wrong
        const idx = indexByName([
            { id: 'a', name: 'Sport HD' },
            { id: 'b', name: 'Sport' }
        ]);
        assert.equal(idx.has('sport'), false);
    });

    it('keeps the one with a schedule when two sources carry a channel', () => {
        // The provider's own EPG and an external XMLTV both carry TF1.
        // Dropping both is how the guide said "No data" against TF1 while
        // holding seventy thousand programmes.
        const weigh = ch => ({ thin: 2, full: 900 })[ch.id] || 0;
        const idx = indexByName([
            { id: 'thin', name: '[#] TF1' },
            { id: 'full', name: 'FR || TF1 [HEVC]' }
        ], weigh);
        assert.equal(idx.get('tf1').id, 'full');
    });

    it('picks the heavier one whichever order they arrive in', () => {
        const weigh = ch => ({ thin: 2, full: 900 })[ch.id] || 0;
        const idx = indexByName([
            { id: 'full', name: 'TF1' },
            { id: 'thin', name: 'TF1 HD' }
        ], weigh);
        assert.equal(idx.get('tf1').id, 'full');
    });

    it('still drops when three collide and two tie at the top', () => {
        const weigh = ch => ({ a: 5, b: 5, c: 1 })[ch.id] || 0;
        const idx = indexByName([
            { id: 'a', name: 'Sport' }, { id: 'c', name: 'Sport HD' },
            { id: 'b', name: 'Sport SD' }
        ], weigh);
        assert.equal(idx.has('sport'), false);
    });

    it('keeps a name repeated by the same channel', () => {
        const idx = indexByName([
            { id: 'a', name: 'TF1' },
            { id: 'a', name: 'TF1 HD' }
        ]);
        assert.equal(idx.get('tf1').id, 'a');
    });

    it('ignores a channel with no usable name', () => {
        assert.equal(indexByName([{ id: 'a', name: '[HD]' }]).size, 0);
    });
});

describe('matchChannel', () => {
    const epg = [{ id: 'tf1.fr', name: 'TF1' }, { id: 'm6.fr', name: 'M6' }];
    const byId = new Map(epg.map(c => [c.id, c]));
    const byName = indexByName(epg);

    it('prefers the stated id', () => {
        const hit = matchChannel({ tvgId: 'tf1.fr', name: 'Nothing Like It' }, byId, byName);
        assert.equal(hit.id, 'tf1.fr');
    });

    it('falls back to the name', () => {
        assert.equal(matchChannel({ name: 'FR || TF1 [SD]' }, byId, byName).id, 'tf1.fr');
    });

    it('reads epg_channel_id as well as tvgId', () => {
        assert.equal(matchChannel({ epg_channel_id: 'm6.fr', name: 'x' }, byId, byName).id, 'm6.fr');
    });

    it('returns nothing rather than a guess', () => {
        assert.equal(matchChannel({ name: 'Some Channel' }, byId, byName), null);
        assert.equal(matchChannel({ name: '' }, byId, byName), null);
    });

    it('falls back to the name when the stated id is unknown', () => {
        assert.equal(matchChannel({ tvgId: 'ghost', name: 'M6 HD' }, byId, byName).id, 'm6.fr');
    });
});
