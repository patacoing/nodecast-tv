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
        document.getElementById('movie-back-btn')
            ?.addEventListener('click', () => history.back());
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
            this.categorySelect.innerHTML = '<option value="">All Categories</option>';

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

            // Populate dropdown
            this.categories.forEach(c => {
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
            const categoryValue = this.categorySelect.value;

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
                    this.showMovieDetails(movie);
                }
            });
            fragment.appendChild(card);
        });

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
        this.container.classList.add('hidden');
        this.detailsPanel.classList.remove('hidden');

        // Its own history entry, so Back closes the film rather than the page
        history.pushState({ page: 'movies', detail: movie.id }, '', '#movies');

        const provider = {
            title: movie.name,
            poster: movie.stream_icon || movie.cover,
            plot: movie.plot,
            year: movie.year || movie.releaseDate?.substring(0, 4),
            rating: movie.rating,
            genres: movie.genre ? movie.genre.split(/\s*[,\/]\s*/) : null,
            cast: movie.cast,
            director: movie.director
        };

        // Draw what the provider gave straight away, then fill the gaps when
        // TMDB answers: the panel must not wait on a network round trip
        // that usually 404s.
        this.renderMovieDetails(Metadata.merge(provider, null));
        document.getElementById('movie-play-btn')?.focus();

        const tmdb = await Metadata.fetch(movie.id);
        // The user may have gone back, or moved on to another film already
        if (tmdb && this.currentMovie === movie) {
            this.renderMovieDetails(Metadata.merge(provider, tmdb));
        }
    }

    renderMovieDetails(meta) {
        document.getElementById('movie-poster').src = meta.poster || '/img/placeholder.png';
        document.getElementById('movie-title').textContent = meta.title || '';
        document.getElementById('movie-meta').textContent = Metadata.summaryLine(meta);
        document.getElementById('movie-plot').textContent =
            meta.plot || 'No description available.';

        const credits = [];
        if (meta.director) credits.push(`Directed by ${meta.director}`);
        if (meta.cast) credits.push(meta.cast);
        document.getElementById('movie-credits').textContent = credits.join(' — ');

        document.getElementById('movie-source').textContent =
            meta.enriched ? 'Description from TMDB' : '';
    }

    hideMovieDetails() {
        this.detailsPanel?.classList.add('hidden');
        this.container.classList.remove('hidden');
        this.currentMovie = null;
    }

    /** Called by the Back key before it leaves the page. */
    closeDetails() {
        if (this.detailsPanel?.classList.contains('hidden') !== false) return false;
        this.hideMovieDetails();
        return true;
    }

    async playMovie(movie) {
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
                        containerExtension: container
                    }, result.url);
                }
            }
        } catch (err) {
            console.error('Error playing movie:', err);
        }
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
