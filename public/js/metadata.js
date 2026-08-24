/**
 * Metadata for a catalogue entry, assembled from several sources in order
 * of authority.
 *
 * The provider wins any field it actually filled in. Its data describes the
 * copy you are about to watch -- that poster is the artwork for this
 * release, that synopsis is the one written for this listing -- whereas
 * TMDB describes the work in general. TMDB is there to fill the gaps, and
 * for the handful of things no provider gives at all, such as a backdrop.
 *
 * The provider speaks in two places: the catalogue listing, which carries
 * a name, a poster and a rating, and its per-item record, which carries the
 * synopsis, cast, director and runtime. Both are read from our own
 * database -- the background job is what put them there, so opening a film
 * never reaches outside.
 */

// Every field the details panel knows how to show. Ordered sources are
// consulted for each one in turn, first filled value wins.
const FIELDS = ['title', 'poster', 'backdrop', 'plot', 'year', 'rating',
    'runtime', 'genres', 'cast', 'director', 'trailer'];

const Metadata = {
    /**
     * The stored metadata for a catalogue entry: { provider, tmdb }, either
     * of which may be null. A 404 is the ordinary answer for anything the
     * background job has not reached yet, so this must stay quiet.
     */
    async fetch(itemId) {
        if (!itemId) return null;
        try {
            return await API.tmdb.item(itemId);
        } catch {
            return null;
        }
    },

    /** Treat empty strings, zeroes and empty arrays as "not given". */
    filled(value) {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string') return value.trim() !== '';
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'number') return value !== 0;
        return true;
    },

    /** TMDB's record in the shape the panel uses. */
    fromTmdb(t) {
        if (!t) return null;
        return {
            title: t.title,
            poster: t.poster_path
                ? `https://image.tmdb.org/t/p/w500${t.poster_path}` : null,
            backdrop: t.backdrop_path
                ? `https://image.tmdb.org/t/p/w1280${t.backdrop_path}` : null,
            plot: t.overview,
            year: t.year,
            rating: t.vote_average,
            runtime: t.runtime,
            genres: t.genres,
            cast: null,
            director: null,
            trailer: t.trailer
        };
    },

    /**
     * Combine sources in order of authority: the first one to have filled
     * in a field wins it. Sources must already share the field names above;
     * use fromTmdb() for a TMDB record.
     */
    merge(...sources) {
        const present = sources.filter(Boolean);
        const out = {};
        for (const field of FIELDS) {
            const source = present.find(s => this.filled(s[field]));
            out[field] = source ? source[field] : null;
        }
        return out;
    },

    /**
     * Everything the details panel needs. `listing` is what the catalogue
     * grid already holds; `stored` is what fetch() returned, or null.
     */
    forDisplay(listing, stored) {
        const tmdb = this.fromTmdb(stored?.tmdb);
        const merged = this.merge(listing, stored?.provider, tmdb);

        // Whether the synopsis on screen is TMDB's work, so the panel can
        // say so rather than passing it off as the provider's. Only the
        // description is credited: it is the one field a viewer reads as
        // authored text.
        merged.plotFromTmdb = !!(merged.plot && tmdb
            && merged.plot === tmdb.plot
            && !this.filled(listing?.plot)
            && !this.filled(stored?.provider?.plot));

        return merged;
    },

    /**
     * The YouTube id out of whatever the provider put in the field: a bare
     * id, a watch URL, a short link, an embed. Anything unreadable is
     * discarded rather than guessed at -- a wrong id plays a stranger's
     * video over the film. This mirrors youtubeId() in tmdbEnricher, which
     * does the same job for what the background pass stores.
     */
    youtubeId(raw) {
        const value = String(raw ?? '').trim();
        if (!value) return null;
        if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
        const m = value.match(
            /[?&]v=([A-Za-z0-9_-]{11})|youtu\.be\/([A-Za-z0-9_-]{11})|\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/);
        return m ? (m[1] || m[2] || m[3]) : null;
    },

    /** "2014 · 2 h 49 · Science-Fiction, Drame · ★ 8.4" */
    summaryLine(meta) {
        const bits = [];
        if (meta.year) bits.push(meta.year);
        if (meta.runtime) {
            const h = Math.floor(meta.runtime / 60);
            const m = meta.runtime % 60;
            bits.push(h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`);
        }
        if (meta.genres?.length) bits.push(meta.genres.slice(0, 3).join(', '));
        if (meta.rating) bits.push(`★ ${Number(meta.rating).toFixed(1)}`);
        return bits.join(' · ');
    }
};

window.Metadata = Metadata;
