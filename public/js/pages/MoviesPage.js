/**
 * Movies Page Controller
 * Handles VOD movie browsing and playback
 */

class MoviesPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('movies-grid');
        this.sourceSelect = document.getElementById('movies-source-select');
        this.categorySelect = document.getElementById('movies-category-select');
        this.searchInput = document.getElementById('movies-search');

        this.movies = [];
        this.categories = [];
        this.sources = [];
        this.currentBatch = 0;
        this.batchSize = 24;
        this.filteredMovies = [];
        this.isLoading = false;
        this.observer = null;
        this.favoriteIds = new Set(); // Track favorite movie IDs
        this.showFavoritesOnly = false;
        this.watchlistIds = new Set(); // Track watchlist movie IDs
        this.sortMode = null; // null | 'rating' | 'date'

        this.init();
    }

    init() {
        // Details panel, shown before playback rather than starting it
        this.detailsPanel = document.getElementById('movie-details');
        this.dialog = new MediaDialog({
            root: this.detailsPanel,
            hero: document.getElementById('movie-backdrop'),
            trailer: document.getElementById('movie-trailer'),
            firstFocus: document.getElementById('movie-play-btn')
        }, () => {
            this.currentMovie = null;
            this.currentPlayback = null;
            this.dropWarmedSession();
        });
        document.getElementById('movie-back-btn')
            ?.addEventListener('click', () => history.back());

        // The card's own favourite and watchlist buttons are unreachable
        // with a remote -- they sit on top of the card and the d-pad treats
        // a card as one stop -- so the dialog carries them instead.
        this.dlBtn = document.getElementById('movie-dl-btn');
        this.dlBtn?.addEventListener('click', () => this.requestDownload());

        this.favBtn = document.getElementById('movie-fav-btn');
        this.wlBtn = document.getElementById('movie-wl-btn');
        this.favBtn?.addEventListener('click', () => {
            if (this.currentMovie) this.toggleFavorite(this.currentMovie, this.favBtn);
        });
        this.wlBtn?.addEventListener('click', () => {
            if (this.currentMovie) this.toggleWatchlist(this.currentMovie, this.wlBtn);
        });

        // Clicking the dimmed area around the dialog closes it, the way a
        // dialog behaves everywhere with a mouse or a finger. The check is
        // for the backdrop itself: a click inside the box bubbles up to
        // here too, and closing the film because someone selected a word of
        // the synopsis would be maddening.
        this.detailsPanel?.addEventListener('click', (e) => {
            if (e.target === this.detailsPanel) history.back();
        });
        document.getElementById('movie-play-btn')
            ?.addEventListener('click', () => {
                if (this.currentMovie) this.playMovie(this.currentMovie);
            });

        // Source change handler
        this.sourceSelect?.addEventListener('change', async () => {
            await this.loadCategories();
            await this.loadMovies();
        });

        // Category change handler
        this.categorySelect?.addEventListener('change', () => {
            this.loadMovies();
        });

        // Search with debounce
        let searchTimeout;
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.filterAndRender(), 300);
        });

        // Set up IntersectionObserver for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        // Favorites filter toggle
        const favBtn = document.getElementById('movies-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.filterAndRender();
        });

        // Sort buttons
        const sortRatingBtn = document.getElementById('movies-sort-rating-btn');
        const sortDateBtn = document.getElementById('movies-sort-date-btn');

        sortRatingBtn?.addEventListener('click', () => {
            this.sortMode = this.sortMode === 'rating' ? null : 'rating';
            sortRatingBtn.classList.toggle('active', this.sortMode === 'rating');
            sortDateBtn.classList.remove('active');
            this.filterAndRender();
        });

        sortDateBtn?.addEventListener('click', () => {
            this.sortMode = this.sortMode === 'date' ? null : 'date';
            sortDateBtn.classList.toggle('active', this.sortMode === 'date');
            sortRatingBtn.classList.remove('active');
            this.filterAndRender();
        });

    }

    async show() {
        // Same as the series page: coming back to Movies from the navbar
        // lands on the grid, not on whatever film was open last time.
        this.hideMovieDetails();

        // Load sources if not loaded
        if (this.sources.length === 0) {
            await this.loadSources();
        }

        // Load favorites and watchlist
        await this.loadFavorites();
        await this.loadWatchlist();

        // Load movies if empty
        if (this.movies.length === 0) {
            await this.loadCategories();
            await this.loadMovies();
        }
    }

    hide() {
        // Page is hidden
    }

    async loadFavorites() {
        try {
            const favs = await API.favorites.getAll(null, 'movie');
            this.favoriteIds = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    async loadWatchlist() {
        try {
            const items = await API.watchlist.getAll(null, 'movie');
            this.watchlistIds = new Set(items.map(i => `${i.source_id}:${i.item_id}`));
        } catch (err) {
            console.error('Error loading watchlist:', err);
        }
    }


    async loadSources() {
        try {
            const allSources = await API.sources.getAll();
            this.sources = allSources.filter(s => s.type === 'xtream' && s.enabled);

            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';
            this.sources.forEach(s => {
                const option = document.createElement('option');
                option.value = s.id;
                option.textContent = s.name;
                this.sourceSelect.appendChild(option);
            });
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    async loadCategories() {
        try {
            this.categories = [];
            this.hiddenCategoryIds = new Set(); // Track hidden categories
            if (this.categorySelect) {
                this.categorySelect.innerHTML = '<option value="">All Categories</option>';
            }

            const sourceId = this.sourceSelect.value;
            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            // Fetch hidden items for each source
            for (const source of sourcesToLoad) {
                try {
                    const hiddenItems = await API.channels.getHidden(source.id);
                    hiddenItems.forEach(h => {
                        if (h.item_type === 'vod_category') {
                            this.hiddenCategoryIds.add(`${source.id}:${h.item_id}`);
                        }
                    });
                } catch (err) {
                    console.warn(`Failed to load hidden items from source ${source.id}`);
                }
            }

            for (const source of sourcesToLoad) {
                try {
                    const cats = await API.proxy.xtream.vodCategories(source.id);
                    if (cats && Array.isArray(cats)) {
                        cats.forEach(c => {
                            // Skip hidden categories
                            if (!this.hiddenCategoryIds.has(`${source.id}:${c.category_id}`)) {
                                this.categories.push({ ...c, sourceId: source.id });
                            }
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load categories from source ${source.id}:`, err.message);
                }
            }

            // The dropdown is gone from the television layout -- the
            // catalogue is browsed as rows now -- but it is still filled in
            // wherever the markup keeps it.
            this.categories.forEach(c => {
                if (!this.categorySelect) return;
                const option = document.createElement('option');
                option.value = `${c.sourceId}:${c.category_id}`;
                option.textContent = c.category_name;
                this.categorySelect.appendChild(option);
            });
        } catch (err) {
            console.error('Error loading categories:', err);
        }
    }

    async loadMovies() {
        this.isLoading = true;
        this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        try {
            this.movies = [];

            const sourceId = this.sourceSelect.value;
            const categoryValue = this.categorySelect?.value || '';

            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            for (const source of sourcesToLoad) {
                try {
                    // Parse category if selected
                    let catId = null;
                    if (categoryValue) {
                        const [catSourceId, categoryId] = categoryValue.split(':');
                        if (parseInt(catSourceId) === source.id) {
                            catId = categoryId;
                        } else if (sourceId) {
                            continue; // Skip this source if category is from different source
                        }
                    }

                    const movies = await API.proxy.xtream.vodStreams(source.id, catId);
                    console.log(`[Movies] Source ${source.id}, Category ${catId || 'ALL'}: Got ${movies?.length || 0} movies`);
                    if (movies && Array.isArray(movies)) {
                        movies.forEach(m => {
                            // Skip movies from hidden categories
                            if (this.hiddenCategoryIds && this.hiddenCategoryIds.has(`${source.id}:${m.category_id}`)) {
                                return;
                            }
                            this.movies.push({
                                ...m,
                                sourceId: source.id,
                                id: `${source.id}:${m.stream_id}`
                            });
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load movies from source ${source.id}:`, err.message);
                }
            }

            console.log(`[Movies] Total loaded: ${this.movies.length} movies`);
            this.filterAndRender();
        } catch (err) {
            console.error('Error loading movies:', err);
            this.container.innerHTML = '<div class="empty-state"><p>Error loading movies</p></div>';
        } finally {
            this.isLoading = false;
        }
    }

    filterAndRender() {
        const searchTerm = this.searchInput?.value?.toLowerCase() || '';

        this.filteredMovies = this.movies.filter(m => {
            const key = `${m.sourceId}:${m.stream_id}`;
            if (this.showFavoritesOnly && !this.favoriteIds.has(key)) return false;
            if (searchTerm && !m.name?.toLowerCase().includes(searchTerm)) return false;
            return true;
        });

        // Apply sort
        if (this.sortMode === 'rating') {
            const validRating = r => { const v = parseFloat(r); return (isFinite(v) && v >= 0 && v <= 10) ? v : 0; };
            this.filteredMovies.sort((a, b) => validRating(b.rating) - validRating(a.rating));
        } else if (this.sortMode === 'date') {
            this.filteredMovies.sort((a, b) => (b.added || '').localeCompare(a.added || ''));
        }

        console.log(`[Movies] Displaying ${this.filteredMovies.length} of ${this.movies.length} movies`);

        this.currentBatch = 0;
        this.container.innerHTML = '';
        this.container.classList.remove('showing-rows');

        // Typing searches the whole catalogue, not just this page. Four
        // separate search boxes is three too many with a remote in hand,
        // and a film is as likely to be a series as anything else.
        if (searchTerm) {
            this.renderGlobalSearch(searchTerm);
            return;
        }

        // Otherwise the catalogue is shown as one row per category rather
        // than a flat grid behind a dropdown. Thirty-four categories in a
        // select is no way to browse anything, and a hopeless one with a
        // remote.
        if (!this.showFavoritesOnly && !this.sortMode) {
            this.renderCategoryRows();
            return;
        }

        if (this.filteredMovies.length === 0) {
            this.container.innerHTML = '<div class="empty-state"><p>No movies found</p></div>';
            return;
        }

        // Create loader element
        const loader = document.createElement('div');
        loader.className = 'movies-loader';
        loader.innerHTML = '<div class="loading-spinner"></div>';
        this.container.appendChild(loader);

        // Render initial batches (more to fill viewport)
        for (let i = 0; i < 5; i++) {
            this.renderNextBatch();
        }

        // Start observing loader
        this.observer.observe(loader);
    }

    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const batch = this.filteredMovies.slice(start, end);

        console.log(`[Movies] Rendering batch ${this.currentBatch}: ${batch.length} cards (${start}-${end})`);

        if (batch.length === 0) {
            const loader = this.container.querySelector('.movies-loader');
            if (loader) loader.style.display = 'none';
            return;
        }

        const fragment = document.createDocumentFragment();

        batch.forEach(movie => {
            fragment.appendChild(this.makeCard(movie));
        });
        this.finishBatch(fragment, end);
    }

    /**
     * Results from across the catalogue, laid out in the same rows: films,
     * series, channels. Answered from the database -- the enrichment that
     * filled it is a background job -- so it costs one local query.
     */
    async renderGlobalSearch(term) {
        // Not ++this.searchToken: undefined increments to NaN, and NaN never
        // equals itself, so the guard below would reject every answer.
        const token = this.searchToken = (this.searchToken || 0) + 1;
        let res;
        try {
            res = await API.search(term);
        } catch (err) {
            console.warn('[Movies] Search failed:', err.message);
            this.container.innerHTML =
                '<div class="empty-state"><p>Search unavailable</p></div>';
            return;
        }
        // Typed on, or left the page, while the answer was coming back
        if (token !== this.searchToken) return;

        this.rows = this.rows || new CategoryRows(this.container, m => this.makeCard(m));
        this.rows.render([
            { title: `Movies (${res.movies.length})`, items: res.movies.map(r => this.fromSearch(r)) },
            { title: `Series (${res.series.length})`, items: res.series.map(r => this.fromSearch(r)) },
            { title: `Channels (${res.channels.length})`, items: res.channels.map(r => this.fromSearch(r)) }
        ]);
    }

    /**
     * A card can now hold a series or a channel, because the search returns
     * all three. Each opens where it belongs rather than in a film's
     * dialog.
     */
    async openResult(item) {
        if (item.type === 'series') {
            await this.app.navigateTo('series');
            const sp = this.app.pages.series;
            const match = sp.seriesList.find(x => x.id === item.id)
                || { ...item, series_id: item.item_id, cover: item.stream_icon };
            return sp.showSeriesDetails(match);
        }
        if (item.type === 'live') {
            await this.app.navigateTo('live');
            return this.app.channelList.selectChannel({
                channelId: item.id, sourceId: item.source_id
            });
        }
        return this.showMovieDetails(item);
    }

    /**
     * A search row speaks the database's language; the card and everything
     * downstream speak the provider's.
     */
    fromSearch(row) {
        return {
            ...row,
            sourceId: row.source_id,
            stream_id: row.item_id,
            series_id: row.item_id,
            id: row.id,
            container_extension: row.container_extension,
            category_id: row.category_id
        };
    }

    /** The catalogue as one horizontal row per category. */
    renderCategoryRows() {
        this.rows = this.rows || new CategoryRows(this.container, m => this.makeCard(m));

        const byCategory = new Map();
        for (const movie of this.filteredMovies) {
            const key = `${movie.sourceId}:${movie.category_id}`;
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key).push(movie);
        }

        // Category order as the provider gave it, which is how the numbered
        // and themed groups it builds are meant to read.
        const groups = this.categories
            .map(c => ({
                title: CategoryRows.cleanTitle(c.category_name),
                items: byCategory.get(`${c.sourceId}:${c.category_id}`) || []
            }))
            .filter(g => g.items.length);

        this.rows.render(groups);
    }

    /** One film's card, used by the grid and by the category rows alike. */
    makeCard(movie) {
        {
            const card = document.createElement('div');
            card.className = 'movie-card';
            card.dataset.movieId = movie.stream_id;
            card.dataset.sourceId = movie.sourceId;

            const poster = movie.stream_icon || movie.cover || '/img/placeholder.png';
            const year = movie.year || movie.releaseDate?.substring(0, 4) || '';
            const rating = movie.rating ? `${Icons.star} ${movie.rating}` : '';

            const key = `${movie.sourceId}:${movie.stream_id}`;
            const isFav = this.favoriteIds.has(key);
            const isWl = this.watchlistIds.has(key);

            card.innerHTML = `
                <div class="movie-poster">
                    <img src="${poster}" alt="${movie.name}"
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" loading="lazy">
                    <div class="movie-play-overlay">
                        <span class="play-icon">${Icons.play}</span>
                    </div>
                    <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                        <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                    </button>
                    <button class="watchlist-btn ${isWl ? 'active' : ''}" title="${isWl ? 'Remove from Watchlist' : 'Add to Watchlist'}">
                        <span class="wl-icon">${isWl ? Icons.watchlist : Icons.watchlistOutline}</span>
                    </button>
                </div>
                <div class="movie-info">
                    <div class="movie-title">${movie.name}</div>
                    <div class="movie-meta">
                        ${year ? `<span>${year}</span>` : ''}
                        ${rating ? `<span>${rating}</span>` : ''}
                    </div>
                </div>
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) {
                    this.toggleFavorite(movie, e.target.closest('.favorite-btn'));
                    e.stopPropagation();
                } else if (e.target.closest('.watchlist-btn')) {
                    this.toggleWatchlist(movie, e.target.closest('.watchlist-btn'));
                    e.stopPropagation();
                } else {
                    this.openResult(movie);
                }
            });
            return card;
        }
    }

    finishBatch(fragment, end) {

        // Insert before loader
        const loader = this.container.querySelector('.movies-loader');
        if (loader) {
            this.container.insertBefore(fragment, loader);
        } else {
            this.container.appendChild(fragment);
        }

        this.currentBatch++;

        // Hide loader if done
        if (end >= this.filteredMovies.length && loader) {
            loader.style.display = 'none';
        }
    }

    /**
     * The card opens the film rather than starting it. On a remote there is
     * no way back out of a stream that began on its own, and a movie
     * listing carries no synopsis at all -- this is the only place the
     * TMDB-filled description has to show.
     */
    async showMovieDetails(movie) {
        this.currentMovie = movie;
        this.dialog.open(movie.id);
        this.syncToggleButtons(movie);

        // Its own history entry, so Back closes the film rather than the page
        history.pushState({ page: 'movies', detail: movie.id }, '', '#movies');

        const listing = {
            title: movie.name,
            poster: movie.stream_icon || movie.cover,
            plot: movie.plot,
            year: movie.year || movie.releaseDate?.substring(0, 4),
            rating: movie.rating,
            genres: movie.genre ? movie.genre.split(/\s*[,\/]\s*/) : null,
            cast: movie.cast,
            director: movie.director
        };

        // Text from the listing straight away: the dialog must not wait on a
        // round trip, even one that only reads our own database. The hero
        // deliberately stays empty until we know which image to use --
        // showing the poster and swapping it for the backdrop a moment
        // later reads as the dialog loading twice.
        this.renderMovieDetails(Metadata.forDisplay(listing, null));

        const stored = await Metadata.fetch(movie.id);
        // The user may have gone back, or moved on to another film already
        if (this.currentMovie !== movie) return;

        const meta = Metadata.forDisplay(listing, stored);
        this.renderMovieDetails(meta);
        this.dialog.setHero(movie.id, meta.backdrop, meta.poster);
        this.dialog.armTrailer(movie.id, meta.trailer);

        // Carried into the player so it does not have to probe the stream to
        // learn what the provider already told us.
        this.currentPlayback = stored?.playback || null;
        this.warmUpPlayback(movie, this.currentPlayback);
    }

    /**
     * Start the transcode session while the viewer reads the synopsis.
     *
     * 71% of this catalogue has a soundtrack the browser cannot decode, and
     * for those films ffmpeg has to be running before a single frame
     * arrives. That wait used to begin when Play was pressed; it can just
     * as well begin when the dialog opens, since the codecs are already
     * known from the provider and nothing has to be probed to find out.
     *
     * `playback` is null whenever we cannot tell, and then nothing is
     * warmed and the player probes exactly as before.
     */
    async warmUpPlayback(movie, playback) {
        if (!playback?.needsTranscode) return;

        // Playing from this grid always starts at the beginning -- only the
        // dashboard's Continue Watching passes a resume point -- so the
        // session warmed here at offset zero is the one that gets joined.
        try {
            const container = movie.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(
                movie.sourceId, movie.stream_id, 'movie', container);
            if (!result?.url || this.currentMovie !== movie) return;

            const session = await API.transcode.createSession({
                url: result.url,
                videoMode: playback.videoMode,
                videoCodec: playback.video,
                audioCodec: playback.audio,
                audioChannels: playback.audioChannels
            });

            // Closed while it was starting: shut it down rather than leave
            // ffmpeg running for a film nobody is watching.
            if (this.currentMovie !== movie) {
                this.dropWarmedSession(session?.sessionId);
                return;
            }
            this.warmedSession = { id: session?.sessionId, url: result.url };
        } catch (err) {
            // Warming is an optimisation. Playback works without it.
            console.warn('[Movies] Could not warm up playback:', err.message);
        }
    }

    /**
     * Stop a warmed session that was never used. Playing the film does not
     * come through here: the session is reused by URL, so it has to stay.
     */
    dropWarmedSession(sessionId) {
        const id = sessionId ?? this.warmedSession?.id;
        this.warmedSession = null;
        if (!id) return;
        API.transcode.removeSession(id)
            .catch(err => console.warn('[Movies] Could not drop session:', err.message));
    }

    renderMovieDetails(meta) {
        document.getElementById('movie-title').textContent = meta.title || '';
        document.getElementById('movie-meta').textContent = Metadata.summaryLine(meta);
        document.getElementById('movie-plot').textContent =
            meta.plot || 'No description available.';

        const credits = [];
        if (meta.director) credits.push(`Directed by ${meta.director}`);
        if (meta.cast) credits.push(meta.cast);
        document.getElementById('movie-credits').textContent = credits.join(' — ');

        document.getElementById('movie-source').textContent =
            meta.plotFromTmdb ? 'Description from TMDB' : '';
    }

    hideMovieDetails() {
        // finish() also covers "was never open", so callers need not care
        if (!this.dialog.close()) this.dialog.finish();
    }

    /** Called by the Back key before it leaves the page. */
    closeDetails() {
        if (!this.dialog.isOpen() || this.dialog.isClosing()) return false;
        return this.dialog.close();
    }

    async playMovie(movie) {
        // The warmed session is about to be joined by the player, which
        // finds it by URL, so it must not be torn down on the way out.
        this.warmedSession = null;
        this.dialog.stopTrailer();

        try {
            // Get stream URL for movie using the actual container extension from API
            // Xtream API returns container_extension (e.g., 'mp4', 'mkv', 'avi')
            const container = movie.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(movie.sourceId, movie.stream_id, 'movie', container);

            if (result && result.url) {
                // Play in dedicated Watch page
                if (this.app.pages.watch) {
                    this.app.pages.watch.play({
                        type: 'movie',
                        id: movie.stream_id,
                        title: movie.name,
                        poster: movie.stream_icon || movie.cover,
                        description: movie.plot || '',
                        year: movie.year || movie.releaseDate?.substring(0, 4),
                        rating: movie.rating,
                        sourceId: movie.sourceId,
                        categoryId: movie.category_id,
                        containerExtension: container,
                        playback: this.currentPlayback
                    }, result.url);
                }
            }
        } catch (err) {
            console.error('Error playing movie:', err);
        }
    }
    /**
     * Ask the server to prepare this film for offline viewing. The refusals
     * are the interesting part: the quota is deliberately not enforced by
     * eviction, so a full quota comes back as an answer naming what is
     * already held rather than quietly deleting one.
     */
    async requestDownload() {
        const movie = this.currentMovie;
        if (!movie || !this.dlBtn) return;

        const label = this.dlBtn.querySelector('.dl-label');
        const say = text => { if (label) label.textContent = text; };

        this.dlBtn.disabled = true;
        try {
            const res = await API.downloads.request(movie.id);
            say(res.already === 'ready' ? 'Already downloaded' : 'Preparing…');
        } catch (err) {
            // The server phrases its own refusals -- a full quota, a full
            // disk -- and they arrive here as the thrown message.
            say(err.message || 'Could not start');
        } finally {
            setTimeout(() => {
                this.dlBtn.disabled = false;
                say('Download');
            }, 4000);
        }
    }

    /** Reflect what this film's state already is on the dialog's buttons. */
    syncToggleButtons(movie) {
        const key = `${movie.sourceId}:${movie.stream_id}`;
        const set = (btn, on, icon, icons, label) => {
            if (!btn) return;
            btn.classList.toggle('active', on);
            btn.title = on ? `Remove from ${label}` : `Add to ${label}`;
            const span = btn.querySelector(icon);
            if (span) span.innerHTML = on ? icons.on : icons.off;
        };
        set(this.favBtn, this.favoriteIds.has(key), '.fav-icon',
            { on: Icons.favorite, off: Icons.favoriteOutline }, 'Favorites');
        set(this.wlBtn, this.watchlistIds.has(key), '.wl-icon',
            { on: Icons.watchlist, off: Icons.watchlistOutline }, 'Watchlist');
    }

    async toggleWatchlist(movie, btn) {
        const key = `${movie.sourceId}:${movie.stream_id}`;
        const isWl = this.watchlistIds.has(key);
        const iconSpan = btn.querySelector('.wl-icon');

        try {
            if (isWl) {
                this.watchlistIds.delete(key);
                btn.classList.remove('active');
                btn.title = 'Add to Watchlist';
                if (iconSpan) iconSpan.innerHTML = Icons.watchlistOutline;
                await API.watchlist.remove(movie.sourceId, movie.stream_id, 'movie');
            } else {
                this.watchlistIds.add(key);
                btn.classList.add('active');
                btn.title = 'Remove from Watchlist';
                if (iconSpan) iconSpan.innerHTML = Icons.watchlist;
                await API.watchlist.add(movie.sourceId, movie.stream_id, 'movie');
            }
        } catch (err) {
            console.error('Error toggling watchlist:', err);
            // Revert on error
            if (isWl) {
                this.watchlistIds.add(key);
                btn.classList.add('active');
                if (iconSpan) iconSpan.innerHTML = Icons.watchlist;
            } else {
                this.watchlistIds.delete(key);
                btn.classList.remove('active');
                if (iconSpan) iconSpan.innerHTML = Icons.watchlistOutline;
            }
        }
    }

    async toggleFavorite(movie, btn) {
        const favKey = `${movie.sourceId}:${movie.stream_id}`;
        const isFav = this.favoriteIds.has(favKey);
        const iconSpan = btn.querySelector('.fav-icon');

        try {
            // Optimistic update
            if (isFav) {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                btn.title = 'Add to Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
                await API.favorites.remove(movie.sourceId, movie.stream_id, 'movie');
            } else {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                btn.title = 'Remove from Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
                await API.favorites.add(movie.sourceId, movie.stream_id, 'movie');
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (isFav) {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
            } else {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
            }
        }
    }
}

window.MoviesPage = MoviesPage;
