/**
 * Series Page Controller
 * Handles TV series browsing and playback
 */

class SeriesPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('series-grid');
        this.sourceSelect = document.getElementById('series-source-select');
        this.categorySelect = document.getElementById('series-category-select');
        this.searchInput = document.getElementById('series-search');
        this.detailsPanel = document.getElementById('series-details');
        this.seasonsContainer = document.getElementById('series-seasons');

        this.seriesList = [];
        this.categories = [];
        this.sources = [];
        this.currentBatch = 0;
        this.batchSize = 24;
        this.filteredSeries = [];
        this.isLoading = false;
        this.observer = null;
        this.hiddenCategoryIds = new Set();
        this.currentSeries = null;
        this.favoriteIds = new Set(); // Track favorite series IDs
        this.showFavoritesOnly = false;
        this.watchlistIds = new Set(); // Track watchlist series IDs
        this.sortMode = null; // null | 'rating' | 'date'

        this.init();
    }

    init() {
        // Source change handler
        this.sourceSelect?.addEventListener('change', async () => {
            await this.loadCategories();
            await this.loadSeries();
        });

        // Category change handler
        this.categorySelect?.addEventListener('change', () => {
            this.loadSeries();
        });

        // Search with debounce
        let searchTimeout;
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.filterAndRender(), 300);
        });

        // Back button
        document.querySelector('.series-back-btn')?.addEventListener('click', () => {
            history.back();
        });

        this.favBtn = document.getElementById('series-fav-btn');
        this.wlBtn = document.getElementById('series-wl-btn');
        this.favBtn?.addEventListener('click', () => {
            if (this.currentSeries) this.toggleFavorite(this.currentSeries, this.favBtn);
        });
        this.wlBtn?.addEventListener('click', () => {
            if (this.currentSeries) this.toggleWatchlist(this.currentSeries, this.wlBtn);
        });

        this.dialog = new MediaDialog({
            root: this.detailsPanel,
            hero: document.getElementById('series-backdrop'),
            trailer: document.getElementById('series-trailer'),
            firstFocus: document.querySelector('.series-back-btn')
        }, () => { this.currentSeries = null; });

        // Set up IntersectionObserver for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        // Favorites filter toggle
        const favBtn = document.getElementById('series-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.filterAndRender();
        });

        // Sort buttons
        const sortRatingBtn = document.getElementById('series-sort-rating-btn');
        const sortDateBtn = document.getElementById('series-sort-date-btn');

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
        // Hide details panel when showing page
        this.hideDetails();

        // Load sources if not loaded
        // Load sources if not loaded
        if (this.sources.length === 0) {
            await this.loadSources();
        }

        // Load favorites and watchlist
        await this.loadFavorites();
        await this.loadWatchlist();

        // Load series if empty
        if (this.seriesList.length === 0) {
            await this.loadCategories();
            await this.loadSeries();
        }
    }

    hide() {
        // Page is hidden
    }

    async loadFavorites() {
        try {
            const favs = await API.favorites.getAll(null, 'series');
            this.favoriteIds = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    async loadWatchlist() {
        try {
            const items = await API.watchlist.getAll(null, 'series');
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
            this.hiddenCategoryIds = new Set();
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
                        if (h.item_type === 'series_category') {
                            this.hiddenCategoryIds.add(`${source.id}:${h.item_id}`);
                        }
                    });
                } catch (err) {
                    console.warn(`Failed to load hidden items from source ${source.id}`);
                }
            }

            for (const source of sourcesToLoad) {
                try {
                    const cats = await API.proxy.xtream.seriesCategories(source.id);
                    if (cats && Array.isArray(cats)) {
                        cats.forEach(c => {
                            // Skip hidden categories
                            if (!this.hiddenCategoryIds.has(`${source.id}:${c.category_id}`)) {
                                this.categories.push({ ...c, sourceId: source.id });
                            }
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load series categories from source ${source.id}:`, err.message);
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

    async loadSeries() {
        this.isLoading = true;
        this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        try {
            this.seriesList = [];

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
                            continue;
                        }
                    }

                    const series = await API.proxy.xtream.series(source.id, catId);
                    console.log(`[Series] Source ${source.id}, Category ${catId || 'ALL'}: Got ${series?.length || 0} series`);
                    if (series && Array.isArray(series)) {
                        series.forEach(s => {
                            // Skip series from hidden categories
                            if (this.hiddenCategoryIds.has(`${source.id}:${s.category_id}`)) {
                                return;
                            }
                            this.seriesList.push({
                                ...s,
                                sourceId: source.id,
                                id: `${source.id}:${s.series_id}`
                            });
                        });
                    }
                } catch (err) {
                    console.warn(`Failed to load series from source ${source.id}:`, err.message);
                }
            }

            console.log(`[Series] Total loaded: ${this.seriesList.length} series`);
            this.filterAndRender();
        } catch (err) {
            console.error('Error loading series:', err);
            this.container.innerHTML = '<div class="empty-state"><p>Error loading series</p></div>';
        } finally {
            this.isLoading = false;
        }
    }

    filterAndRender() {
        const searchTerm = this.searchInput?.value?.toLowerCase() || '';

        this.filteredSeries = this.seriesList.filter(s => {
            const key = `${s.sourceId}:${s.series_id}`;
            if (this.showFavoritesOnly && !this.favoriteIds.has(key)) return false;
            if (searchTerm && !s.name?.toLowerCase().includes(searchTerm)) return false;
            return true;
        });

        // Apply sort
        if (this.sortMode === 'rating') {
            const validRating = r => { const v = parseFloat(r); return (isFinite(v) && v >= 0 && v <= 10) ? v : 0; };
            this.filteredSeries.sort((a, b) => validRating(b.rating) - validRating(a.rating));
        } else if (this.sortMode === 'date') {
            this.filteredSeries.sort((a, b) => (b.added || '').localeCompare(a.added || ''));
        }

        console.log(`[Series] Displaying ${this.filteredSeries.length} of ${this.seriesList.length} series`);

        this.currentBatch = 0;
        this.container.innerHTML = '';

        if (this.filteredSeries.length === 0) {
            this.container.innerHTML = '<div class="empty-state"><p>No series found</p></div>';
            return;
        }

        // Create loader element
        const loader = document.createElement('div');
        loader.className = 'series-loader';
        loader.innerHTML = '<div class="loading-spinner"></div>';
        this.container.appendChild(loader);

        // Render initial batches
        for (let i = 0; i < 5; i++) {
            this.renderNextBatch();
        }

        // Start observing loader
        this.observer.observe(loader);
    }

    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const batch = this.filteredSeries.slice(start, end);

        if (batch.length === 0) {
            const loader = this.container.querySelector('.series-loader');
            if (loader) loader.style.display = 'none';
            return;
        }

        const fragment = document.createDocumentFragment();

        batch.forEach(series => {
            const card = document.createElement('div');
            card.className = 'series-card';
            card.dataset.seriesId = series.series_id;
            card.dataset.sourceId = series.sourceId;

            const poster = series.cover || '/img/placeholder.png';
            const year = series.year || series.releaseDate?.substring(0, 4) || '';
            const rating = series.rating ? `${Icons.star} ${series.rating}` : '';

            const key = `${series.sourceId}:${series.series_id}`;
            const isFav = this.favoriteIds.has(key);
            const isWl = this.watchlistIds.has(key);

            card.innerHTML = `
                <div class="series-poster">
                    <img src="${poster}" alt="${series.name}"
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" loading="lazy">
                    <div class="series-play-overlay">
                        <span class="play-icon">${Icons.play}</span>
                    </div>
                    <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                        <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                    </button>
                    <button class="watchlist-btn ${isWl ? 'active' : ''}" title="${isWl ? 'Remove from Watchlist' : 'Add to Watchlist'}">
                        <span class="wl-icon">${isWl ? Icons.watchlist : Icons.watchlistOutline}</span>
                    </button>
                </div>
                <div class="series-card-info">
                    <div class="series-title">${series.name}</div>
                    <div class="series-meta">
                        ${year ? `<span>${year}</span>` : ''}
                        ${rating ? `<span>${rating}</span>` : ''}
                    </div>
                </div>
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) {
                    this.toggleFavorite(series, e.target.closest('.favorite-btn'));
                    e.stopPropagation();
                } else if (e.target.closest('.watchlist-btn')) {
                    this.toggleWatchlist(series, e.target.closest('.watchlist-btn'));
                    e.stopPropagation();
                } else {
                    this.showSeriesDetails(series);
                }
            });
            fragment.appendChild(card);
        });

        // Insert before loader
        const loader = this.container.querySelector('.series-loader');
        if (loader) {
            this.container.insertBefore(fragment, loader);
        } else {
            this.container.appendChild(fragment);
        }

        this.currentBatch++;

        // Hide loader if done
        if (end >= this.filteredSeries.length && loader) {
            loader.style.display = 'none';
        }
    }

    renderSeriesHeader(meta) {
        document.getElementById('series-title').textContent = meta.title || '';
        document.getElementById('series-meta').textContent = Metadata.summaryLine(meta);
        document.getElementById('series-plot').textContent = meta.plot || '';

        const credits = [];
        if (meta.director) credits.push(`Directed by ${meta.director}`);
        if (meta.cast) credits.push(meta.cast);
        document.getElementById('series-credits').textContent = credits.join(' \u2014 ');
    }

    async showSeriesDetails(series) {
        this.currentSeries = series;
        this.dialog.open(series.id);
        this.syncToggleButtons(series);

        // Its own history entry, so Back closes the series rather than the page
        history.pushState({ page: 'series', detail: series.id }, '', '#series');

        // Set header info. Xtream describes its series fairly well, so this
        // is almost always the provider's own text; TMDB only steps in for
        // the occasional entry that came through bare.
        // A series listing is far richer than a film's: it carries the
        // synopsis, the cast, a run time, several backdrops and a trailer.
        // TMDB has almost nothing left to add.
        const listing = {
            title: series.name,
            poster: series.cover,
            backdrop: Array.isArray(series.backdrop_path)
                ? series.backdrop_path[0] : series.backdrop_path,
            plot: series.plot,
            year: series.year || series.releaseDate?.substring(0, 4),
            rating: series.rating,
            runtime: Number(series.episode_run_time) || null,
            cast: series.cast,
            director: series.director,
            genres: series.genre ? series.genre.split(/\s*[,\/]\s*/) : null,
            trailer: Metadata.youtubeId(series.youtube_trailer)
        };
        const shown = Metadata.forDisplay(listing, null);
        this.renderSeriesHeader(shown);
        this.dialog.setHero(series.id, shown.backdrop, shown.poster);
        this.dialog.armTrailer(series.id, shown.trailer);

        Metadata.fetch(series.id).then(stored => {
            if (!stored || this.currentSeries !== series) return;
            const meta = Metadata.forDisplay(listing, stored);
            this.renderSeriesHeader(meta);
            this.dialog.setHero(series.id, meta.backdrop, meta.poster);
            this.dialog.armTrailer(series.id, meta.trailer);
        });

        // Show loading
        this.seasonsContainer.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        try {
            // Fetch series info (seasons/episodes)
            const info = await API.proxy.xtream.seriesInfo(series.sourceId, series.series_id);

            if (!info || !info.episodes) {
                this.seasonsContainer.innerHTML = '<p class="hint">No episodes found</p>';
                return;
            }

            // Store series info for WatchPage
            this.currentSeriesInfo = info;

            // Render seasons and episodes
            let html = '';
            const seasons = Object.keys(info.episodes).sort((a, b) => parseInt(a) - parseInt(b));

            seasons.forEach(seasonNum => {
                const episodes = info.episodes[seasonNum];
                html += `
                <div class="season-group">
                    <div class="season-header">
                        <span class="season-expander">${Icons.chevronDown}</span>
                        <span class="season-name">Season ${seasonNum} (${episodes.length} episodes)</span>
                    </div>
                    <div class="episode-list">
                        ${episodes.map(ep => `
                            <div class="episode-item" data-episode-id="${ep.id}" data-source-id="${series.sourceId}" data-container="${ep.container_extension || 'mp4'}">
                                <span class="episode-number">E${ep.episode_num}</span>
                                <span class="episode-title">${ep.title || `Episode ${ep.episode_num}`}</span>
                                <span class="episode-duration">${ep.duration || ''}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
            });

            this.seasonsContainer.innerHTML = html;

            // Add click handlers
            this.seasonsContainer.querySelectorAll('.season-header').forEach(header => {
                header.addEventListener('click', () => {
                    header.closest('.season-group').classList.toggle('collapsed');
                });
            });

            this.seasonsContainer.querySelectorAll('.episode-item').forEach(ep => {
                ep.addEventListener('click', () => this.playEpisode(ep));
            });

        } catch (err) {
            console.error('Error loading series info:', err);
            this.seasonsContainer.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading episodes</p>';
        }
    }

    hideDetails() {
        if (!this.dialog.close()) this.dialog.finish();
    }

    /** Called by the Back key before it leaves the page. */
    closeDetails() {
        if (!this.dialog.isOpen() || this.dialog.isClosing()) return false;
        return this.dialog.close();
    }

    async playEpisode(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const sourceId = parseInt(episodeEl.dataset.sourceId);
        const container = episodeEl.dataset.container || 'mp4';

        // Get season and episode number from the episode element context
        const seasonGroup = episodeEl.closest('.season-group');
        const seasonHeader = seasonGroup?.querySelector('.season-name')?.textContent || '';
        const seasonMatch = seasonHeader.match(/Season (\d+)/);
        const seasonNum = seasonMatch ? seasonMatch[1] : '1';
        const episodeNum = episodeEl.querySelector('.episode-number')?.textContent?.replace('E', '') || '1';

        try {
            // Get stream URL for episode (use 'series' type)
            const result = await API.proxy.xtream.getStreamUrl(sourceId, episodeId, 'series', container);

            if (result && result.url) {
                // Play in dedicated Watch page
                if (this.app.pages.watch) {
                    const episodeTitle = episodeEl.querySelector('.episode-title')?.textContent || `Episode ${episodeNum}`;

                    this.app.pages.watch.play({
                        type: 'series',
                        id: episodeId,
                        title: this.currentSeries?.name || 'Series',
                        subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                        poster: this.currentSeries?.cover,
                        description: this.currentSeries?.plot || '',
                        year: this.currentSeries?.year,
                        rating: this.currentSeries?.rating,
                        sourceId: sourceId,
                        seriesId: this.currentSeries?.series_id,
                        seriesInfo: this.currentSeriesInfo,
                        currentSeason: seasonNum,
                        currentEpisode: episodeNum,
                        containerExtension: container
                    }, result.url);
                }
            }
        } catch (err) {
            console.error('Error playing episode:', err);
        }
    }

    /** Reflect what this series' state already is on the dialog's buttons. */
    syncToggleButtons(series) {
        const key = `${series.sourceId}:${series.series_id}`;
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

    async toggleWatchlist(series, btn) {
        const key = `${series.sourceId}:${series.series_id}`;
        const isWl = this.watchlistIds.has(key);
        const iconSpan = btn.querySelector('.wl-icon');

        try {
            if (isWl) {
                this.watchlistIds.delete(key);
                btn.classList.remove('active');
                btn.title = 'Add to Watchlist';
                if (iconSpan) iconSpan.innerHTML = Icons.watchlistOutline;
                await API.watchlist.remove(series.sourceId, series.series_id, 'series');
            } else {
                this.watchlistIds.add(key);
                btn.classList.add('active');
                btn.title = 'Remove from Watchlist';
                if (iconSpan) iconSpan.innerHTML = Icons.watchlist;
                await API.watchlist.add(series.sourceId, series.series_id, 'series');
            }
        } catch (err) {
            console.error('Error toggling watchlist:', err);
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

    async toggleFavorite(series, btn) {
        const favKey = `${series.sourceId}:${series.series_id}`;
        const isFav = this.favoriteIds.has(favKey);
        const iconSpan = btn.querySelector('.fav-icon');

        try {
            // Optimistic update
            if (isFav) {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                btn.title = 'Add to Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
                await API.favorites.remove(series.sourceId, series.series_id, 'series');
            } else {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                btn.title = 'Remove from Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
                await API.favorites.add(series.sourceId, series.series_id, 'series');
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

window.SeriesPage = SeriesPage;
