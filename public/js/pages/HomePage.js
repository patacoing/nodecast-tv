/**
 * Home Dashboard Page
 * Features "Continue Watching" and "Recently Added" content
 */
class HomePage {
    constructor(app) {
        this.app = app;
        this.container = null;
        this.isLoading = false;
        this.movieFavIds = new Set();
        this.seriesFavIds = new Set();
        this.movieWlIds = new Set();
        this.seriesWlIds = new Set();
    }

    async init() {
        // Initialization if needed
    }

    async show() {
        this.renderLayout();
        await this.loadDashboardData();
    }

    hide() {
        // Cleanup if needed
        if (this.container) {
            this.container.innerHTML = '';
        }
    }

    renderLayout() {
        const pageHome = document.getElementById('page-home');
        if (!pageHome) return;

        pageHome.innerHTML = `
            <div class="dashboard-content" id="home-content">
                <section class="dashboard-section" id="favorite-channels-section">
                    <div class="section-header">
                        <h2>Favorite Channels</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll channel-tiles" id="favorite-channels-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading favorites...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section" id="continue-watching-section">
                    <div class="section-header">
                        <h2>Continue Watching</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="continue-watching-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading history...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section" id="watchlist-section">
                    <div class="section-header">
                        <h2>Ma Watchlist</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="watchlist-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Chargement de la watchlist...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section">
                    <div class="section-header">
                        <h2>Recently Added Movies</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="recent-movies-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading recently added...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>

                <section class="dashboard-section">
                    <div class="section-header">
                        <h2>Recently Added Series</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll" id="recent-series-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading recently added...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>
            </div>
        `;
        this.container = document.getElementById('home-content');

        // Attach scroll arrow handlers
        this.initScrollArrows();
    }

    initScrollArrows() {
        this.container.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            const scrollContainer = wrapper.querySelector('.horizontal-scroll');
            const leftBtn = wrapper.querySelector('.scroll-left');
            const rightBtn = wrapper.querySelector('.scroll-right');

            if (!scrollContainer || !leftBtn || !rightBtn) return;

            const scrollAmount = 300; // pixels to scroll per click

            leftBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            });

            rightBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            });

            // Update arrow visibility based on scroll position
            const updateArrows = () => {
                const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
                leftBtn.classList.toggle('hidden', scrollLeft <= 0);
                rightBtn.classList.toggle('hidden', scrollLeft + clientWidth >= scrollWidth - 5);
            };

            // Store reference for later updates
            wrapper._updateArrows = updateArrows;

            scrollContainer.addEventListener('scroll', updateArrows);
            // Initial check after content loads
            setTimeout(updateArrows, 100);
        });
    }

    /**
     * Re-check scroll arrow visibility for all sections
     * Call this after dynamically loading content
     */
    updateScrollArrows() {
        this.container?.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            if (wrapper._updateArrows) {
                wrapper._updateArrows();
            }
        });
    }


    async loadDashboardData() {
        if (this.isLoading) return;
        this.isLoading = true;

        try {
            // 0. Load Favorite Channels (first section)
            await this.renderFavoriteChannels();

            // 1. Load user favorites & watchlist sets for quick lookup
            await this.loadUserLists();

            // 2. Load Watch History
            const history = await window.API.request('GET', '/history?limit=12');
            if (history && Array.isArray(history)) {
                this.renderHistory(history);
            }

            // 3. Load Watchlist section
            this.renderWatchlist();

            // 4. Load Recent Items
            this.renderRecentMovies();
            this.renderRecentSeries();

        } catch (err) {
            console.error('[Dashboard] Error loading data:', err);
        } finally {
            this.isLoading = false;
        }
    }

    async loadUserLists() {
        try {
            const [movieFavs, seriesFavs, movieWl, seriesWl] = await Promise.all([
                window.API.favorites.getAll(null, 'movie').catch(() => []),
                window.API.favorites.getAll(null, 'series').catch(() => []),
                window.API.watchlist.getAll(null, 'movie').catch(() => []),
                window.API.watchlist.getAll(null, 'series').catch(() => []),
            ]);
            this.movieFavIds = new Set(movieFavs.map(f => `${f.source_id}:${f.item_id}`));
            this.seriesFavIds = new Set(seriesFavs.map(f => `${f.source_id}:${f.item_id}`));
            this.movieWlIds = new Set(movieWl.map(w => `${w.source_id}:${w.item_id}`));
            this.seriesWlIds = new Set(seriesWl.map(w => `${w.source_id}:${w.item_id}`));
        } catch (err) {
            console.error('[Dashboard] Error loading user lists:', err);
        }
    }

    async renderWatchlist() {
        const list = document.getElementById('watchlist-list');
        const section = document.getElementById('watchlist-section');
        if (!list || !section) return;

        try {
            const items = await window.API.watchlist.items();
            if (!items || items.length === 0) {
                section.classList.add('hidden');
                return;
            }

            section.classList.remove('hidden');
            list.innerHTML = items.map(item => this.createWatchlistCard(item)).join('');

            list.querySelectorAll('.dashboard-card').forEach(card => {
                const removeBtn = card.querySelector('.wl-remove-btn');
                if (removeBtn) {
                    removeBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        try {
                            const { sourceId: sid, id: iid, type: itype } = card.dataset;
                            await window.API.watchlist.remove(sid, iid, itype);

                            // Sync local Set
                            const wlKey = `${sid}:${iid}`;
                            (itype === 'movie' ? this.movieWlIds : this.seriesWlIds).delete(wlKey);

                            // Update button on the corresponding recent card
                            const recentListId = itype === 'movie' ? 'recent-movies-list' : 'recent-series-list';
                            const recentCard = document.getElementById(recentListId)
                                ?.querySelector(`.dashboard-card[data-id="${iid}"][data-source-id="${sid}"]`);
                            if (recentCard) {
                                const wlBtn = recentCard.querySelector('.card-wl-btn');
                                if (wlBtn) {
                                    wlBtn.classList.remove('active');
                                    wlBtn.title = 'Ajouter à la Watchlist';
                                    const iconSpan = wlBtn.querySelector('.wl-icon');
                                    if (iconSpan) iconSpan.innerHTML = Icons.watchlistOutline;
                                }
                            }

                            card.style.transition = 'opacity 0.3s, transform 0.3s';
                            card.style.opacity = '0';
                            card.style.transform = 'scale(0.85)';
                            setTimeout(() => {
                                card.remove();
                                if (list.querySelectorAll('.dashboard-card').length === 0) {
                                    section.classList.add('hidden');
                                }
                            }, 300);
                        } catch (err) {
                            console.error('[Dashboard] Error removing from watchlist:', err);
                        }
                    });
                }

                card.addEventListener('click', (e) => {
                    if (e.target.closest('.wl-remove-btn')) return;
                    const type = card.dataset.type;
                    const item = items.find(i =>
                        i.item_id === card.dataset.id &&
                        String(i.source_id) === String(card.dataset.sourceId)
                    );
                    if (!item) return;
                    if (type === 'movie') {
                        this.playItem({ ...item, item_type: 'movie' });
                    } else {
                        this.navigateToSeries({ ...item, item_type: 'series' });
                    }
                });
            });

            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading watchlist:', err);
            section.classList.add('hidden');
        }
    }

    createWatchlistCard(item) {
        const poster = item.stream_icon || (item.data && item.data.poster) || '/img/poster-placeholder.jpg';
        const posterUrl = poster.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(poster)}` : poster;
        const title = item.name || (item.data && item.data.title) || 'Unknown Title';
        const type = item.item_type;

        return `
            <div class="dashboard-card" data-id="${item.item_id}" data-source-id="${item.source_id}" data-type="${type}">
                <div class="card-image">
                    <img src="${posterUrl}" alt="${title}" loading="lazy" onerror="this.onerror=null;this.src='/img/poster-placeholder.jpg'">
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                    <button class="wl-remove-btn card-action-btn active" title="Retirer de la Watchlist" aria-label="Retirer de la Watchlist">
                        <span>${Icons.watchlist}</span>
                    </button>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${title}">${title}</div>
                    <div class="card-subtitle">${type === 'movie' ? 'Film' : 'Série'}</div>
                </div>
            </div>
        `;
    }

    async renderFavoriteChannels() {
        const list = document.getElementById('favorite-channels-list');
        const section = document.getElementById('favorite-channels-section');
        if (!list || !section) return;

        try {
            // Fetch favorite channels for current user
            const favorites = await window.API.request('GET', '/favorites?itemType=channel');

            if (!favorites || favorites.length === 0) {
                list.innerHTML = '<div class="empty-state hint">Add channels to favorites from Live TV</div>';
                return;
            }

            // Ensure channel list is loaded to resolve channel details
            const channelList = this.app.channelList;
            if (!channelList.channels || channelList.channels.length === 0) {
                await channelList.loadSources();
                await channelList.loadChannels();
            }

            // Match favorites to channel data
            const channels = [];
            for (const fav of favorites) {
                // Find channel in loaded channel list
                const channel = channelList.channels.find(ch =>
                    String(ch.sourceId) === String(fav.source_id) &&
                    (String(ch.id) === String(fav.item_id) || String(ch.streamId) === String(fav.item_id))
                );
                if (channel) {
                    channels.push({ ...channel, favoriteId: fav.id });
                }
            }

            if (channels.length === 0) {
                list.innerHTML = '<div class="empty-state hint">Add channels to favorites from Live TV</div>';
                return;
            }

            // Render channel tiles
            list.innerHTML = channels.map(ch => this.createChannelTile(ch)).join('');

            // Attach click handlers
            list.querySelectorAll('.channel-tile').forEach(tile => {
                tile.addEventListener('click', () => {
                    const channelId = tile.dataset.channelId;
                    const sourceId = tile.dataset.sourceId;
                    this.playChannel(channelId, sourceId);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();

        } catch (err) {
            console.error('[Dashboard] Error loading favorite channels:', err);
            list.innerHTML = '<div class="empty-state hint">Error loading favorites</div>';
        }
    }

    createChannelTile(channel) {
        const logo = channel.tvgLogo || '/img/placeholder.png';
        const logoUrl = logo.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(logo)}` : logo;
        const name = channel.name || 'Unknown';

        return `
            <div class="channel-tile" data-channel-id="${channel.id}" data-source-id="${channel.sourceId}">
                <div class="tile-logo">
                    <img src="${logoUrl}" alt="${name}" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
                </div>
                <div class="tile-name" title="${name}">${name}</div>
            </div>
        `;
    }

    playChannel(channelId, sourceId) {
        // Navigate to Live TV and select the channel
        this.app.navigateTo('live');

        // Small delay to ensure page is ready
        setTimeout(() => {
            const channelList = this.app.channelList;
            if (channelList) {
                // Find and select the channel
                const channel = channelList.channels.find(ch =>
                    String(ch.id) === String(channelId) && String(ch.sourceId) === String(sourceId)
                );
                if (channel) {
                    channelList.selectChannel({
                        channelId: channel.id,
                        sourceId: channel.sourceId,
                        sourceType: channel.sourceType,
                        streamId: channel.streamId || '',
                        url: channel.url || ''
                    });
                }
            }
        }, 100);
    }

    renderHistory(items) {
        const list = document.getElementById('continue-watching-list');
        const section = document.getElementById('continue-watching-section');

        if (!list || !section) return;

        if (items.length === 0) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        list.innerHTML = items.map(item => this.createCard(item)).join('');

        // Attach click listeners
        list.querySelectorAll('.dashboard-card').forEach(card => {
            // Delete button
            const deleteBtn = card.querySelector('.card-delete-btn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.deleteHistoryItem(deleteBtn.dataset.id, card, section, list);
                });
            }

            card.addEventListener('click', () => {
                const id = card.dataset.id;
                const item = items.find(i => i.item_id === id);
                if (item) {
                    const type = item.item_type || item.type;

                    // IF it's a series, checking details is better than blind resume
                    // BUT for "Continue Watching", we ideally want to resume

                    // Prioritize playing directly for resume tiles
                    this.playItem(item, true); // true for resume
                }
            });
        });

        // Update scroll arrows after content renders
        this.updateScrollArrows();
    }

    async deleteHistoryItem(itemId, cardElement, section, list) {
        try {
            await window.API.request('DELETE', `/history/${itemId}`);
            cardElement.style.transition = 'opacity 0.3s, transform 0.3s';
            cardElement.style.opacity = '0';
            cardElement.style.transform = 'scale(0.85)';
            setTimeout(() => {
                cardElement.remove();
                if (list.querySelectorAll('.dashboard-card').length === 0) {
                    section.classList.add('hidden');
                }
            }, 300);
        } catch (err) {
            console.error('[Dashboard] Error deleting history item:', err);
        }
    }

    navigateToSeries(item) {
        if (!this.app.pages.series) return;

        // Prepare the series object as expected by SeriesPage.showSeriesDetails
        const series = {
            series_id: item.item_id,
            sourceId: item.source_id,
            name: item.name || (item.data ? item.data.title : 'Series'),
            cover: item.stream_icon || (item.data ? item.data.poster : null),
            plot: item.data ? item.data.description : '',
            year: item.data ? item.data.year : ''
        };

        // Switch page
        this.app.navigateTo('series');

        // Show details (delay slightly to ensure page is visible)
        setTimeout(() => {
            this.app.pages.series.showSeriesDetails(series);
        }, 100);
    }

    async renderRecentMovies() {
        const list = document.getElementById('recent-movies-list');
        if (!list) return;

        try {
            const movies = await window.API.request('GET', '/channels/recent?type=movie&limit=12');
            if (!movies || movies.length === 0) {
                list.innerHTML = '<div class="empty-state hint">No recently added movies found</div>';
                return;
            }

            list.innerHTML = movies.map(item => {
                const key = `${item.source_id}:${item.item_id}`;
                return this.createRecentCard(item, this.movieFavIds.has(key), this.movieWlIds.has(key));
            }).join('');

            list.querySelectorAll('.dashboard-card').forEach(card => {
                const id = card.dataset.id;
                const sourceId = card.dataset.sourceId;
                const key = `${sourceId}:${id}`;
                const item = movies.find(m => m.item_id === id);

                const favBtn = card.querySelector('.card-fav-btn');
                if (favBtn) {
                    favBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await this.toggleFav(favBtn, sourceId, id, 'movie', this.movieFavIds, key);
                    });
                }

                const wlBtn = card.querySelector('.card-wl-btn');
                if (wlBtn) {
                    wlBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await this.toggleWl(wlBtn, sourceId, id, 'movie', this.movieWlIds, key);
                        this.renderWatchlist();
                    });
                }

                card.addEventListener('click', (e) => {
                    if (e.target.closest('.card-fav-btn') || e.target.closest('.card-wl-btn')) return;
                    if (item) this.playItem(item);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading recent movies:', err);
        }
    }

    async renderRecentSeries() {
        const list = document.getElementById('recent-series-list');
        if (!list) return;

        try {
            const series = await window.API.request('GET', '/channels/recent?type=series&limit=12');
            if (!series || series.length === 0) {
                list.innerHTML = '<div class="empty-state hint">No recently added series found</div>';
                return;
            }

            list.innerHTML = series.map(item => {
                const key = `${item.source_id}:${item.item_id}`;
                return this.createRecentCard(item, this.seriesFavIds.has(key), this.seriesWlIds.has(key));
            }).join('');

            list.querySelectorAll('.dashboard-card').forEach(card => {
                const id = card.dataset.id;
                const sourceId = card.dataset.sourceId;
                const key = `${sourceId}:${id}`;
                const item = series.find(s => s.item_id === id);

                const favBtn = card.querySelector('.card-fav-btn');
                if (favBtn) {
                    favBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await this.toggleFav(favBtn, sourceId, id, 'series', this.seriesFavIds, key);
                    });
                }

                const wlBtn = card.querySelector('.card-wl-btn');
                if (wlBtn) {
                    wlBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await this.toggleWl(wlBtn, sourceId, id, 'series', this.seriesWlIds, key);
                        this.renderWatchlist();
                    });
                }

                card.addEventListener('click', (e) => {
                    if (e.target.closest('.card-fav-btn') || e.target.closest('.card-wl-btn')) return;
                    if (item) this.navigateToSeries(item);
                });
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();
        } catch (err) {
            console.error('[Dashboard] Error loading recent series:', err);
        }
    }

    async toggleFav(btn, sourceId, itemId, itemType, favSet, key) {
        const isFav = favSet.has(key);
        const iconSpan = btn.querySelector('.fav-icon');
        try {
            if (isFav) {
                favSet.delete(key);
                btn.classList.remove('active');
                btn.title = 'Ajouter aux favoris';
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
                await window.API.favorites.remove(sourceId, itemId, itemType);
            } else {
                favSet.add(key);
                btn.classList.add('active');
                btn.title = 'Retirer des favoris';
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
                await window.API.favorites.add(sourceId, itemId, itemType);
            }
        } catch (err) {
            console.error('[Dashboard] Error toggling favorite:', err);
            // Revert on error
            if (isFav) {
                favSet.add(key);
                btn.classList.add('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
            } else {
                favSet.delete(key);
                btn.classList.remove('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
            }
        }
    }

    async toggleWl(btn, sourceId, itemId, itemType, wlSet, key) {
        const isWl = wlSet.has(key);
        const iconSpan = btn.querySelector('.wl-icon');
        try {
            if (isWl) {
                wlSet.delete(key);
                btn.classList.remove('active');
                btn.title = 'Ajouter à la Watchlist';
                if (iconSpan) iconSpan.innerHTML = Icons.watchlistOutline;
                await window.API.watchlist.remove(sourceId, itemId, itemType);
            } else {
                wlSet.add(key);
                btn.classList.add('active');
                btn.title = 'Retirer de la Watchlist';
                if (iconSpan) iconSpan.innerHTML = Icons.watchlist;
                await window.API.watchlist.add(sourceId, itemId, itemType);
            }
        } catch (err) {
            console.error('[Dashboard] Error toggling watchlist:', err);
            // Revert on error
            if (isWl) {
                wlSet.add(key);
                btn.classList.add('active');
                if (iconSpan) iconSpan.innerHTML = Icons.watchlist;
            } else {
                wlSet.delete(key);
                btn.classList.remove('active');
                if (iconSpan) iconSpan.innerHTML = Icons.watchlistOutline;
            }
        }
    }

    createCard(item) {
        const { data, progress, duration, item_id } = item;
        const type = item.item_type || item.type;
        const percent = Math.min(100, Math.round((progress / duration) * 100));

        // Proxy the poster if it's an external URL
        const poster = data.poster || '/img/poster-placeholder.jpg';
        const posterUrl = poster.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(poster)}` : poster;

        return `
            <div class="dashboard-card" data-id="${item_id}" data-type="${type}">
                <div class="card-image">
                    <img src="${posterUrl}" alt="${data.title || item.name}" loading="lazy" onerror="this.onerror=null;this.src='/img/poster-placeholder.jpg'">
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width: ${percent}%"></div>
                    </div>
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                    <button class="card-delete-btn" data-id="${item_id}" title="Remove from Continue Watching" aria-label="Remove from Continue Watching">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${item.name || data.title}">${item.name || data.title || 'Unknown Title'}</div>
                    <div class="card-subtitle">${data.subtitle || (type === 'movie' ? 'Movie' : 'Series')}</div>
                </div>
            </div>
        `;
    }

    createRecentCard(item, isFav, isWl) {
        const { data, item_id } = item;
        const type = item.type || item.item_type;
        const poster = item.stream_icon || (data && data.poster) || '/img/poster-placeholder.jpg';
        const posterUrl = poster.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(poster)}` : poster;

        return `
            <div class="dashboard-card" data-id="${item_id}" data-source-id="${item.source_id}" data-type="${type}">
                <div class="card-image">
                    <img src="${posterUrl}" alt="${item.name}" loading="lazy" onerror="this.onerror=null;this.src='/img/poster-placeholder.jpg'">
                    <div class="play-icon-overlay">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                    <button class="card-fav-btn card-action-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
                        <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                    </button>
                    <button class="card-wl-btn card-action-btn ${isWl ? 'active' : ''}" title="${isWl ? 'Retirer de la Watchlist' : 'Ajouter à la Watchlist'}">
                        <span class="wl-icon">${isWl ? Icons.watchlist : Icons.watchlistOutline}</span>
                    </button>
                </div>
                <div class="card-info">
                    <div class="card-title" title="${item.name || (data && data.title)}">${item.name || (data && data.title) || 'Unknown Title'}</div>
                    <div class="card-subtitle">${(data && data.subtitle) || (type === 'movie' ? 'Film' : 'Série')}</div>
                </div>
            </div>
        `;
    }

    async playItem(item, isResume = false) {
        if (!this.app.pages.watch) return;

        try {
            const type = item.item_type || item.type;
            const streamType = type === 'movie' ? 'movie' : 'series';
            const sourceId = item.source_id || (item.data && item.data.sourceId);
            const streamId = item.item_id;
            const container = item.container_extension || (item.data && (item.data.containerExtension || item.data.container_extension)) || 'mp4';

            const result = await window.API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${streamType}?container=${container}`);

            if (result && result.url) {
                const content = {
                    id: item.item_id,
                    type: type,
                    title: item.name || (item.data && item.data.title),
                    subtitle: (item.data && item.data.subtitle) || (type === 'movie' ? 'Movie' : 'Series'),
                    poster: item.stream_icon || (item.data && item.data.poster),
                    sourceId: sourceId,
                    resumeTime: isResume ? item.progress : 0,
                    containerExtension: container
                };

                // For episodes, try to restore series data for next episode functionality
                if (type === 'episode' && item.data) {
                    content.seriesId = item.data.seriesId || null;
                    content.currentSeason = item.data.currentSeason || null;
                    content.currentEpisode = item.data.currentEpisode || null;

                    // Fetch seriesInfo if we have a seriesId
                    if (content.seriesId && sourceId) {
                        try {
                            const seriesInfo = await window.API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${content.seriesId}`);
                            if (seriesInfo) {
                                content.seriesInfo = seriesInfo;
                            }
                        } catch (e) {
                            console.warn('[Dashboard] Could not fetch seriesInfo for next episode:', e);
                        }
                    }
                }

                // Switch to watch page
                this.app.navigateTo('watch');

                this.app.pages.watch.play(content, result.url);
            }
        } catch (err) {
            console.error('[Dashboard] Playback failed:', err);
        }
    }
}

window.HomePage = HomePage;
