/**
 * Tests for public/js/metadata.js.
 *
 * The rule the whole file exists to enforce: the provider wins any field it
 * actually filled in, and TMDB only fills the gaps. Getting this backwards
 * would replace artwork and ratings that describe the copy being watched
 * with ones that describe the work in general.
 *
 * metadata.js is a browser script that hangs itself off window, so it is
 * evaluated inside a jsdom window rather than required.
 */
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'metadata.js'), 'utf8');

const { window } = new JSDOM('<body></body>', { runScripts: 'outside-only' });
window.eval(SRC);
const Metadata = window.Metadata;

const TMDB = {
    title: 'Interstellar',
    year: '2014',
    overview: 'Un synopsis TMDB',
    poster_path: '/tmdb-poster.jpg',
    backdrop_path: '/tmdb-backdrop.jpg',
    genres: ['Science-Fiction', 'Drame'],
    runtime: 169,
    vote_average: 8.4
};

describe('filled', () => {
    it('treats blank strings as missing', () => {
        assert.equal(Metadata.filled(''), false);
        assert.equal(Metadata.filled('   '), false);
        assert.equal(Metadata.filled('x'), true);
    });

    it('treats null and undefined as missing', () => {
        assert.equal(Metadata.filled(null), false);
        assert.equal(Metadata.filled(undefined), false);
    });

    it('treats an empty list as missing', () => {
        assert.equal(Metadata.filled([]), false);
        assert.equal(Metadata.filled(['Drame']), true);
    });

    it('treats a zero rating as missing', () => {
        // Providers write 0 for "no rating", not for "rated zero"
        assert.equal(Metadata.filled(0), false);
        assert.equal(Metadata.filled(7.2), true);
    });
});

describe('merge: the provider wins what it filled in', () => {
    const provider = {
        title: 'Interstellar VF',
        poster: 'http://provider/poster.jpg',
        plot: 'Le synopsis du fournisseur',
        year: '2015',
        rating: 7.2,
        genres: ['Aventure'],
        cast: 'Matthew McConaughey',
        director: 'Christopher Nolan'
    };
    const meta = Metadata.merge(provider, TMDB);

    it('keeps the provider title', () => assert.equal(meta.title, 'Interstellar VF'));
    it('keeps the provider poster', () =>
        assert.equal(meta.poster, 'http://provider/poster.jpg'));
    it('keeps the provider synopsis', () =>
        assert.equal(meta.plot, 'Le synopsis du fournisseur'));
    it('keeps the provider year', () => assert.equal(meta.year, '2015'));
    it('keeps the provider rating', () => assert.equal(meta.rating, 7.2));
    it('keeps the provider genres', () =>
        assert.deepEqual(meta.genres, ['Aventure']));

    it('still takes what the provider never has', () => {
        // No provider field carries a runtime
        assert.equal(meta.runtime, 169);
    });

    it('always takes the backdrop, which no provider gives', () => {
        assert.equal(meta.backdrop,
            'https://image.tmdb.org/t/p/w1280/tmdb-backdrop.jpg');
    });
});

describe('merge: TMDB fills the gaps', () => {
    // What an Xtream movie listing actually looks like: a name, a poster,
    // a rating, and nothing else at all
    const bare = {
        title: 'Interstellar',
        poster: 'http://provider/poster.jpg',
        rating: 7.2,
        plot: '',
        year: null,
        genres: []
    };
    const meta = Metadata.merge(bare, TMDB);

    it('takes the synopsis', () => assert.equal(meta.plot, 'Un synopsis TMDB'));
    it('takes the year', () => assert.equal(meta.year, '2014'));
    it('takes the genres', () =>
        assert.deepEqual(meta.genres, ['Science-Fiction', 'Drame']));
    it('takes the runtime', () => assert.equal(meta.runtime, 169));
    it('still keeps the provider poster and rating', () => {
        assert.equal(meta.poster, 'http://provider/poster.jpg');
        assert.equal(meta.rating, 7.2);
    });
    it('flags the result as enriched', () => assert.equal(meta.enriched, true));
});

describe('merge: no TMDB record', () => {
    const meta = Metadata.merge({ title: 'Un film', poster: null, plot: '' }, null);

    it('survives without one', () => assert.equal(meta.title, 'Un film'));
    it('leaves the gaps empty rather than inventing', () => {
        assert.equal(meta.plot, null);
        assert.equal(meta.poster, null);
        assert.equal(meta.backdrop, null);
    });
    it('is not flagged as enriched', () => assert.equal(meta.enriched, false));
});

describe('merge: poster fallback', () => {
    it('builds the TMDB image URL when the provider has no artwork', () => {
        const meta = Metadata.merge({ title: 'x', poster: '' }, TMDB);
        assert.equal(meta.poster, 'https://image.tmdb.org/t/p/w500/tmdb-poster.jpg');
    });

    it('leaves the poster empty when neither side has one', () => {
        const meta = Metadata.merge({ title: 'x', poster: '' }, { title: 'x' });
        assert.equal(meta.poster, null);
    });
});

describe('summaryLine', () => {
    it('lays out year, runtime, genres and rating', () => {
        assert.equal(
            Metadata.summaryLine(Metadata.merge({ title: 'x' }, TMDB)),
            '2014 · 2 h 49 · Science-Fiction, Drame · ★ 8.4');
    });

    it('writes a short runtime in minutes', () => {
        assert.equal(Metadata.summaryLine({ runtime: 45 }), '45 min');
    });

    it('keeps at most three genres', () => {
        assert.equal(
            Metadata.summaryLine({ genres: ['a', 'b', 'c', 'd'] }), 'a, b, c');
    });

    it('is empty when there is nothing to say', () => {
        assert.equal(Metadata.summaryLine({}), '');
    });
});
