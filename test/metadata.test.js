/**
 * Tests for public/js/metadata.js.
 *
 * The rule the whole file exists to enforce: the provider wins any field it
 * actually filled in, and TMDB only fills the gaps. Getting this backwards
 * would replace the synopsis written for this listing, and the artwork for
 * this release, with ones describing the work in general.
 *
 * The provider speaks twice -- through the catalogue listing and through
 * its per-item record -- so the merge takes ordered sources rather than a
 * pair.
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

// A TMDB row as the endpoint returns it
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

// What an Xtream movie listing actually holds: a name, a poster, a rating
const LISTING = {
    title: 'Interstellar',
    poster: 'http://provider/poster.jpg',
    rating: 7.2,
    plot: '',
    year: null,
    genres: []
};

// What the provider's own per-item record adds
const DETAILS = {
    plot: 'Le synopsis du fournisseur',
    cast: 'Matthew McConaughey',
    director: 'Christopher Nolan',
    genres: ['Aventure'],
    runtime: 165,
    year: '2015'
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

describe("the provider's synopsis wins over TMDB's", () => {
    const meta = Metadata.forDisplay(LISTING, { provider: DETAILS, tmdb: TMDB });

    it('shows the words the provider wrote', () => {
        assert.equal(meta.plot, 'Le synopsis du fournisseur');
    });

    it('does not credit TMDB for words it did not supply', () => {
        assert.equal(meta.plotFromTmdb, false);
    });

    it('takes the cast and director from the provider', () => {
        assert.equal(meta.cast, 'Matthew McConaughey');
        assert.equal(meta.director, 'Christopher Nolan');
    });

    it('takes the runtime and genres from the provider', () => {
        assert.equal(meta.runtime, 165);
        assert.deepEqual(meta.genres, ['Aventure']);
    });
});

describe('the listing outranks the per-item record', () => {
    // Both are the provider speaking; the listing is what the grid shows,
    // so the panel must agree with the card the user just clicked
    const meta = Metadata.forDisplay(
        { ...LISTING, year: '2014' },
        { provider: DETAILS, tmdb: TMDB });

    it('keeps the listing year', () => assert.equal(meta.year, '2014'));
    it('keeps the listing poster', () =>
        assert.equal(meta.poster, 'http://provider/poster.jpg'));
    it('keeps the listing rating', () => assert.equal(meta.rating, 7.2));
});

describe('TMDB fills what neither provider source has', () => {
    const meta = Metadata.forDisplay(LISTING, { provider: null, tmdb: TMDB });

    it('supplies the synopsis', () => assert.equal(meta.plot, 'Un synopsis TMDB'));
    it('credits TMDB for it', () => assert.equal(meta.plotFromTmdb, true));
    it('supplies the year', () => assert.equal(meta.year, '2014'));
    it('supplies the genres', () =>
        assert.deepEqual(meta.genres, ['Science-Fiction', 'Drame']));
    it('supplies the runtime', () => assert.equal(meta.runtime, 169));

    it('still leaves the listing poster and rating alone', () => {
        assert.equal(meta.poster, 'http://provider/poster.jpg');
        assert.equal(meta.rating, 7.2);
    });

    it('supplies the backdrop, which no provider gives', () => {
        assert.equal(meta.backdrop,
            'https://image.tmdb.org/t/p/w1280/tmdb-backdrop.jpg');
    });
});

describe('a record with gaps of its own', () => {
    // The provider's record exists but its synopsis is blank
    const meta = Metadata.forDisplay(
        LISTING, { provider: { ...DETAILS, plot: '' }, tmdb: TMDB });

    it('falls through to TMDB for the missing field only', () => {
        assert.equal(meta.plot, 'Un synopsis TMDB');
        assert.equal(meta.plotFromTmdb, true);
    });

    it('still takes the rest from the provider', () => {
        assert.equal(meta.director, 'Christopher Nolan');
        assert.equal(meta.runtime, 165);
    });
});

describe('nothing stored yet', () => {
    const meta = Metadata.forDisplay(LISTING, null);

    it('renders from the listing alone', () => {
        assert.equal(meta.title, 'Interstellar');
        assert.equal(meta.poster, 'http://provider/poster.jpg');
    });

    it('leaves the gaps empty rather than inventing', () => {
        assert.equal(meta.plot, null);
        assert.equal(meta.year, null);
        assert.equal(meta.backdrop, null);
    });

    it('credits nobody', () => assert.equal(meta.plotFromTmdb, false));
});

describe('poster fallback', () => {
    it('builds the TMDB image URL when no provider artwork exists', () => {
        const meta = Metadata.forDisplay(
            { title: 'x', poster: '' }, { provider: null, tmdb: TMDB });
        assert.equal(meta.poster, 'https://image.tmdb.org/t/p/w500/tmdb-poster.jpg');
    });

    it('leaves the poster empty when neither side has one', () => {
        const meta = Metadata.forDisplay(
            { title: 'x', poster: '' }, { provider: null, tmdb: { title: 'x' } });
        assert.equal(meta.poster, null);
    });
});

describe('summaryLine', () => {
    it('lays out year, runtime, genres and rating', () => {
        const meta = Metadata.forDisplay({ title: 'x' }, { provider: null, tmdb: TMDB });
        assert.equal(Metadata.summaryLine(meta),
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
