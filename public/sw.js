const CACHE_NAME = 'nodecast-shell-v5';

const SHELL_ASSETS = [
    '/',
    '/css/main.css',
    '/js/app.js',
    '/js/api.js',
    '/js/dpad.js',
    '/js/pages/HomePage.js',
    '/js/pages/LivePage.js',
    '/js/pages/MoviesPage.js',
    '/js/pages/SeriesPage.js',
    '/js/pages/WatchPage.js',
    '/js/pages/Settings.js',
    '/js/pages/Guide.js',
    '/js/components/VideoPlayer.js',
    '/js/components/ChannelList.js',
    '/js/components/EpgGuide.js',
    '/js/components/SourceManager.js',
    '/img/poster-placeholder.jpg',
    '/img/icon-192.png',
    '/favicon.svg',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // Ne jamais mettre en cache : API, flux vidéo, transcode, remux, proxy
    if (
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/transcode') ||
        url.pathname.startsWith('/remux') ||
        request.headers.get('range') !== null
    ) {
        return;
    }

    // Cache First pour les assets statiques connus
    if (SHELL_ASSETS.includes(url.pathname) || url.pathname.startsWith('/img/')) {
        event.respondWith(
            caches.match(request).then(cached => cached || fetch(request))
        );
        return;
    }

    // Network First pour tout le reste (login.html, etc.)
    event.respondWith(
        fetch(request).catch(() => caches.match(request))
    );
});
