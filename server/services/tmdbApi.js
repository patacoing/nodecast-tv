/**
 * TMDB client.
 *
 * Deliberately small: search and details, nothing else. The key comes from
 * the environment rather than the settings table because it is a secret and
 * the settings blob is served to the browser.
 *
 * Both credential styles work. A v4 read access token is a JWT and goes in
 * the Authorization header; a v3 key is a bare hex string and goes in the
 * query. People copy whichever one their TMDB page happened to show them.
 */

const BASE = 'https://api.themoviedb.org/3';

// TMDB no longer publishes a hard rate limit, but it used to be 40 requests
// per 10 seconds and there is nothing to gain from going faster: this is a
// background drip, not something a user is waiting on.
const MIN_INTERVAL_MS = 120;

let lastRequestAt = 0;

function credentials() {
    const key = (process.env.TMDB_API_KEY || '').trim();
    if (!key) return null;
    return key.startsWith('eyJ')
        ? { header: `Bearer ${key}` }
        : { query: key };
}

function isEnabled() {
    return credentials() !== null;
}

async function request(path, params = {}) {
    const creds = credentials();
    if (!creds) throw new Error('TMDB_API_KEY is not set');

    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    if (creds.query) url.searchParams.set('api_key', creds.query);

    // Space the requests out without a scheduler: every call goes through
    // here, so holding the last timestamp is enough.
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();

    const res = await fetch(url, {
        headers: creds.header ? { Authorization: creds.header } : {}
    });

    if (res.status === 429) {
        // Retry once, after whatever TMDB asks for.
        const retryAfter = Number(res.headers.get('retry-after') || 2);
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        return request(path, params);
    }
    if (!res.ok) {
        throw new Error(`TMDB ${res.status} on ${path}`);
    }
    return res.json();
}

/** kind is 'movie' or 'tv'. year is optional. */
async function search(kind, title, year, language = 'fr-FR') {
    const params = { query: title, language, include_adult: 'false' };
    if (year) {
        if (kind === 'movie') params.year = year;
        else params.first_air_date_year = year;
    }
    const body = await request(`/search/${kind}`, params);
    return Array.isArray(body?.results) ? body.results : [];
}

async function details(kind, tmdbId, language = 'fr-FR') {
    return request(`/${kind}/${tmdbId}`, { language });
}

module.exports = { isEnabled, search, details, request };
