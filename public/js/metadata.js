/**
 * Metadata for a catalogue entry: what the provider gave us, topped up
 * from TMDB where it gave us nothing.
 *
 * The provider always wins a field it actually filled in. Its data
 * describes the copy you are about to watch -- that poster is the artwork
 * for this release, that rating is the one the rest of the app sorts by --
 * whereas TMDB describes the work in general. Series come through fairly
 * complete; a movie listing carries a name, a poster and a rating and
 * nothing else, so in practice TMDB supplies the synopsis, the year, the
 * runtime and the genres for movies and almost nothing for series.
 */

const Metadata = {
    /**
     * TMDB's record for a catalogue entry, or null. A 404 is the ordinary
     * answer for anything a pass has not identified, and a server without a
     * TMDB key never identifies anything, so this must stay quiet.
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

    /**
     * Merge one field: the provider's value, or TMDB's when the provider
     * has none.
     */
    pick(providerValue, tmdbValue) {
        return this.filled(providerValue) ? providerValue
            : (this.filled(tmdbValue) ? tmdbValue : null);
    },

    /**
     * Everything the details panel needs. `provider` is a plain object of
     * already-extracted fields so that movies and series, whose payloads
     * name things differently, can both use this.
     */
    merge(provider, tmdb) {
        const t = tmdb || {};
        const poster = this.pick(provider.poster, t.poster_path
            ? `https://image.tmdb.org/t/p/w500${t.poster_path}` : null);

        return {
            title: this.pick(provider.title, t.title),
            poster,
            backdrop: t.backdrop_path
                ? `https://image.tmdb.org/t/p/w1280${t.backdrop_path}` : null,
            plot: this.pick(provider.plot, t.overview),
            year: this.pick(provider.year, t.year),
            rating: this.pick(provider.rating, t.vote_average),
            runtime: this.pick(provider.runtime, t.runtime),
            genres: this.pick(provider.genres, t.genres),
            cast: this.pick(provider.cast, null),
            director: this.pick(provider.director, null),
            // What came from where, so the panel can say so rather than
            // passing TMDB's work off as the provider's.
            enriched: !!tmdb
        };
    },

    /** "2014 · 2 h 49 · Science-Fiction, Drame · 8.4" */
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
