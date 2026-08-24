/**
 * Turning an IPTV catalogue name into something TMDB can be asked about,
 * and deciding whether what came back is really the same work.
 *
 * Provider names are written for a list on a set-top box, not for a
 * database: "Horizonte (VOSTFR)", "Cry Macho.", "FR - Terminator 2 : Le
 * Jugement dernier (1991) 4K". Everything here is pure so it can be tested
 * without a network.
 */

// Language, quality and release tags that decorate a title without being
// part of it. Matched as whole words only, so "4K" goes and "Blade" stays.
const TAGS = [
    'vostfr', 'vost', 'vf', 'vfq', 'vo', 'multi', 'truefrench', 'french',
    '4k', 'uhd', 'hdr', 'fhd', 'hd', 'sd', 'hevc', 'x265', 'x264',
    '1080p', '1080', '720p', '720', '480p', '2160p',
    'bluray', 'webrip', 'web-dl', 'webdl', 'hdlight', 'dvdrip', 'remux',
];

// Country/language prefixes: "FR - ", "|FR| ", "[FR] ", "FR: "
const PREFIX_RE = /^\s*[\[|(]?\s*[a-z]{2,3}\s*[\])|]?\s*[-:|]\s*/i;

/** Does a bracket's content consist of nothing but decoration? */
function isDecoration(inner) {
    const words = normalize(inner).split(' ').filter(Boolean);
    return words.length > 0 && words.every(w => TAGS.includes(w));
}

/**
 * Split a catalogue name into the title to search for, the year if the name
 * carries one, and other spellings worth trying if that title finds nothing.
 *
 * Returns { title, year, alternatives }.
 *
 * Two judgement calls, both of which can go either way on a given name,
 * which is why the alternatives exist rather than a single answer:
 *
 *  - A bracket holding only tags is decoration and goes: "Stay (VOSTFR)".
 *    A bracket holding anything else is part of the name and stays, because
 *    dropping it silently loses titles -- "TKT (T'inquiète)" -- and
 *    sometimes loses the only searchable part of them, as in a Japanese
 *    title glossed with its French one. Both readings get tried.
 *  - A year in brackets is almost always a year. A bare trailing one may
 *    well be part of the title, "Blade Runner 2049" being the famous case,
 *    so it is only read as a year when it is plausibly in the past.
 */
function parseName(rawName) {
    let name = String(rawName || '').trim();

    // A leading country marker, possibly repeated: "FR - |VF| Title"
    let previous;
    do {
        previous = name;
        name = name.replace(PREFIX_RE, '');
    } while (name !== previous && name.length > 0);

    // Pull the year out before the brackets around it are considered.
    let year = null;
    const yearMatch = name.match(/[([](19\d{2}|20\d{2})[)\]]/);
    if (yearMatch) {
        year = Number(yearMatch[1]);
        name = name.replace(yearMatch[0], ' ');
    }

    // Decoration goes; anything else in brackets is kept, and noted so it
    // can also be tried on its own and by its absence.
    const kept = [];
    name = name.replace(/[([]([^)\]]*)[)\]]/g, (match, inner) => {
        if (isDecoration(inner)) return ' ';
        kept.push(inner.trim());
        return match;
    });

    // Bare tags, with the surrounding separators
    const tagRe = new RegExp(`(^|[\\s._-])(${TAGS.join('|')})(?=[\\s._-]|$)`, 'gi');
    let stripped;
    do {
        stripped = name;
        name = name.replace(tagRe, ' ');
    } while (name !== stripped);

    const alternatives = [];

    // A trailing bare year: "Cry Macho 2021". Anything set in the future is
    // part of the title, not a release date.
    if (year === null) {
        const trailing = name.match(/[\s._-](19\d{2}|20\d{2})\s*$/);
        const maxYear = new Date().getFullYear() + 1;
        if (trailing && Number(trailing[1]) <= maxYear) {
            year = Number(trailing[1]);
            alternatives.push(clean(name));       // the year read as title
            name = name.slice(0, trailing.index);
        }
    }

    const title = clean(name);

    // The name without its parenthetical, then the parenthetical alone: one
    // of the two is the title TMDB knows it by.
    if (kept.length) {
        alternatives.push(clean(name.replace(/[([][^)\]]*[)\]]/g, ' ')));
        for (const inner of kept) alternatives.push(clean(inner));
    }

    return {
        title,
        year,
        alternatives: [...new Set(alternatives)].filter(a => a && a !== title)
    };
}

/** Collapse whitespace and drop the punctuation left by the stripping,
 *  including the trailing full stop some providers add ("Cry Macho."). */
function clean(name) {
    return name.replace(/\s+/g, ' ')
        .replace(/^[\s.,;:_-]+|[\s.,;:_-]+$/g, '')
        .trim();
}

/**
 * The form two titles are compared in: no case, no accents, no
 * punctuation, single spaces. "Terminator 2 : Le Jugement dernier" and
 * "Terminator 2 - le jugement dernier" collapse to the same string.
 */
function normalize(title) {
    return String(title || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')   // combining accents
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Year of a TMDB result, from whichever date field its kind uses. */
function resultYear(result) {
    const date = result.release_date || result.first_air_date || '';
    const year = Number(String(date).slice(0, 4));
    return Number.isFinite(year) && year > 1800 ? year : null;
}

/**
 * Pick the one result that is certainly the same work, or nothing.
 *
 * Deliberately strict: the title has to match exactly once normalised.
 * A near-miss is not a match, it is a different film with a similar name,
 * and writing it down would put the wrong poster and the wrong synopsis on
 * something the user then has no way to correct.
 *
 * Returns { result, confidence } or null.
 */
function pickMatch(query, results) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const wanted = normalize(query.title);
    if (!wanted) return null;

    const exact = results.filter(r =>
        normalize(r.title || r.name) === wanted ||
        normalize(r.original_title || r.original_name) === wanted);

    if (exact.length === 0) return null;

    // With a year to go on, it decides. A one-year gap is normal: catalogues
    // date a film by its local release, TMDB by its first release anywhere.
    if (query.year) {
        const sameYear = exact.filter(r => {
            const y = resultYear(r);
            return y !== null && Math.abs(y - query.year) <= 1;
        });
        if (sameYear.length === 1) return { result: sameYear[0], confidence: 1 };
        if (sameYear.length > 1) return null;   // genuinely ambiguous
        // No candidate near that year: the title matched something else.
        return null;
    }

    // No year on our side. A single exact title is safe enough; several
    // means remakes, and there is no way to tell which one this is.
    if (exact.length === 1) return { result: exact[0], confidence: 0.8 };
    return null;
}

module.exports = { parseName, normalize, pickMatch, resultYear, TAGS };
