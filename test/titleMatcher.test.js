/**
 * Tests for the TMDB title matcher.
 *
 * The names below are real ones taken from the catalogue, or the shapes
 * they come in. Everything here is pure: no network, no database.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseName, normalize, pickMatch } = require('../server/services/titleMatcher');

const title = n => parseName(n).title;
const year = n => parseName(n).year;

describe('parseName: decoration', () => {
    it('drops a language tag in brackets', () => {
        assert.equal(title('Horizonte (VOSTFR)'), 'Horizonte');
    });

    it('drops a tag padded with spaces', () => {
        // "Toy Story 5 ( FHD )", straight from the catalogue
        assert.equal(title('Toy Story 5 ( FHD )'), 'Toy Story 5');
    });

    it('needs no alternative once a bracket was only decoration', () => {
        assert.deepEqual(parseName('Stay (VOSTFR)').alternatives, []);
    });

    it('drops the trailing full stop some providers add', () => {
        assert.equal(title('Cry Macho.'), 'Cry Macho');
    });

    it('drops a country prefix', () => {
        assert.equal(title('FR - Interstellar'), 'Interstellar');
    });

    it('drops a piped country prefix', () => {
        assert.equal(title('|VF| Drop Game'), 'Drop Game');
    });

    it('drops stacked prefixes', () => {
        assert.equal(title('FR - |VF| Drop Game'), 'Drop Game');
    });

    it('drops bare quality tags', () => {
        assert.equal(title('Interstellar 4K MULTI'), 'Interstellar');
    });

    it('leaves a title that only looks like a tag alone', () => {
        // "Blade" ends in no tag and "Hdlight" is not a word here
        assert.equal(title('Blade Runner'), 'Blade Runner');
    });

    it('leaves punctuation inside the title alone', () => {
        assert.equal(title('Terminator 2 : Le Jugement dernier'),
            'Terminator 2 : Le Jugement dernier');
    });

    it('leaves a comma inside the title alone', () => {
        assert.equal(title('Freud, la dernière confession'),
            'Freud, la dernière confession');
    });
});

describe('parseName: years', () => {
    it('takes a year in brackets', () => {
        assert.equal(year('Interstellar (2014)'), 2014);
        assert.equal(title('Interstellar (2014)'), 'Interstellar');
    });

    it('takes a plausible trailing year', () => {
        assert.equal(year('Cry Macho 2021'), 2021);
        assert.equal(title('Cry Macho 2021'), 'Cry Macho');
    });

    it('leaves a future number as part of the title', () => {
        // The whole reason the plausibility bound exists
        assert.equal(year('Blade Runner 2049'), null);
        assert.equal(title('Blade Runner 2049'), 'Blade Runner 2049');
    });

    it('offers the untouched title as an alternative for a bare year', () => {
        // "Flash Back 2012" is a title, not a film from 2012, and only a
        // failed search can tell us that
        assert.deepEqual(parseName('Flash Back 2012').alternatives,
            ['Flash Back 2012']);
    });

    it('needs no alternative for a bracketed year', () => {
        assert.deepEqual(parseName('Interstellar (2014)').alternatives, []);
    });

    it('handles a name that is nothing but decoration', () => {
        const p = parseName('(VOSTFR)');
        assert.equal(p.title, '');
    });
});

describe('parseName: a bracket that is part of the name', () => {
    // Both of these came back unmatched from a real pass, because every
    // bracket used to be treated as decoration and thrown away.
    it('keeps a parenthetical that is not a tag', () => {
        assert.equal(title("TKT (T'inquiète)"), "TKT (T'inquiète)");
    });

    it('offers the name without it, and it alone', () => {
        assert.deepEqual(parseName("TKT (T'inquiète)").alternatives,
            ['TKT', "T'inquiète"]);
    });

    it('handles a title glossed in another language', () => {
        // The parenthetical is the only part TMDB is likely to know
        const p = parseName('ディスイズアイ (C\'est vraiment moi)');
        assert.ok(p.alternatives.includes("C'est vraiment moi"));
    });

    it('still drops decoration next to a kept parenthetical', () => {
        assert.equal(title("TKT (T'inquiète) (VOSTFR)"), "TKT (T'inquiète)");
    });

    it('offers no alternative equal to the title itself', () => {
        const p = parseName('Un film');
        assert.deepEqual(p.alternatives, []);
    });
});

describe('normalize', () => {
    it('ignores case, accents and punctuation', () => {
        assert.equal(normalize('Terminator 2 : Le Jugement dernier'),
            normalize('terminator 2 - LE JUGEMENT DERNIER'));
    });

    it('collapses accented characters', () => {
        assert.equal(normalize('Coup de théâtre'), 'coup de theatre');
    });

    it('keeps digits', () => {
        assert.equal(normalize('Blade Runner 2049'), 'blade runner 2049');
    });
});

const movie = (id, t, date) => ({ id, title: t, release_date: date });

describe('pickMatch', () => {
    it('takes a single exact title with no year to go on', () => {
        const hit = pickMatch({ title: 'Interstellar', year: null },
            [movie(157336, 'Interstellar', '2014-11-05')]);
        assert.equal(hit.result.id, 157336);
        assert.equal(hit.confidence, 0.8);
    });

    it('is fully confident when the year agrees', () => {
        const hit = pickMatch({ title: 'Interstellar', year: 2014 },
            [movie(157336, 'Interstellar', '2014-11-05')]);
        assert.equal(hit.confidence, 1);
    });

    it('tolerates a year off by one', () => {
        // A catalogue dates a film by its local release, TMDB by its first
        const hit = pickMatch({ title: 'Interstellar', year: 2015 },
            [movie(157336, 'Interstellar', '2014-11-05')]);
        assert.equal(hit.confidence, 1);
    });

    it('refuses a near miss', () => {
        assert.equal(pickMatch({ title: 'Interstellar', year: null },
            [movie(1, 'Interstellar Wars', '2014-01-01')]), null);
    });

    it('refuses several remakes when there is no year', () => {
        assert.equal(pickMatch({ title: 'Dune', year: null }, [
            movie(438631, 'Dune', '2021-09-15'),
            movie(841, 'Dune', '1984-12-14')
        ]), null);
    });

    it('picks the right remake when there is a year', () => {
        const hit = pickMatch({ title: 'Dune', year: 2021 }, [
            movie(438631, 'Dune', '2021-09-15'),
            movie(841, 'Dune', '1984-12-14')
        ]);
        assert.equal(hit.result.id, 438631);
    });

    it('refuses when nothing sits near the year we have', () => {
        assert.equal(pickMatch({ title: 'Dune', year: 2005 },
            [movie(841, 'Dune', '1984-12-14')]), null);
    });

    it('matches on the original title too', () => {
        const hit = pickMatch({ title: 'The Last of Us', year: null },
            [{ id: 100088, name: 'The Last of Us', original_name: 'The Last of Us',
                first_air_date: '2023-01-15' }]);
        assert.equal(hit.result.id, 100088);
    });

    it('matches a series through first_air_date', () => {
        const hit = pickMatch({ title: 'The Last of Us', year: 2023 },
            [{ id: 100088, name: 'The Last of Us', first_air_date: '2023-01-15' }]);
        assert.equal(hit.confidence, 1);
    });

    it('ignores accents and punctuation across the comparison', () => {
        const hit = pickMatch({ title: 'Coup de theatre', year: null },
            [movie(7, 'Coup de théâtre', '2007-01-01')]);
        assert.equal(hit.result.id, 7);
    });

    it('returns nothing for an empty search', () => {
        assert.equal(pickMatch({ title: 'Interstellar', year: null }, []), null);
        assert.equal(pickMatch({ title: '', year: null },
            [movie(1, '', '2020-01-01')]), null);
    });
});
