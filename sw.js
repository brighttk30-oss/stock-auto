// ── StockAI Service Worker ──
const CACHE_VERSION = 'stockai-v4';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;

const STATIC_ASSETS = [
  '/stock-auto/stock-dashboard.html',
  '/stock-auto/manifest.json',
  '/stock-auto/icon-192.png',
  '/stock-auto/icon-512.png',
];

const NO_CACHE_DOMAINS = [
  'api.twelvedata.com','openrouter.ai','firestore.googleapis.com',
  'firebase.googleapis.com','identitytoolkit.googleapis.com',
  'securetoken.googleapis.com','notify-api.line.me','api.sec.or.th',
];

// ── INSTALL ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache =>
      Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(e => console.warn('[SW] Skip:', url))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith('stockai-') && k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if(NO_CACHE_DOMAINS.some(d => url.hostname.includes(d))) return;
  if(event.request.method !== 'GET') return;
  if(url.protocol === 'chrome-extension:') return;

  // HTML: network-first เสมอ ให้ได้ไฟล์ใหม่ทุกครั้ง
  if(url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  // Fonts + icons: cache-first (ไม่เปลี่ยน)
  if(url.hostname.includes('fonts.gstatic.com') ||
     url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  // Static assets: cache-first
  if(STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  event.respondWith(networkFirst(event.request));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if(cached) return cached;
  try {
    const res = await fetch(req);
    if(res.ok){ const c = await caches.open(DYNAMIC_CACHE); c.put(req, res.clone()); }
    return res;
  } catch(e) {
    return caches.match('/stock-auto/stock-dashboard.html') ||
           new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(8000) });
    if(res.ok){ const c = await caches.open(DYNAMIC_CACHE); c.put(req, res.clone()); }
    return res;
  } catch(e) {
    const cached = await caches.match(req);
    return cached || caches.match('/stock-auto/stock-dashboard.html') ||
           new Response('Offline', { status: 503 });
  }
}

// ── PUSH NOTIFICATION ──
self.addEventListener('push', event => {
  if(!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'StockAI', {
        body: data.body || 'StockAI แจ้งเตือน',
        icon: '/stock-auto/icon-192.png',
        badge: '/stock-auto/icon-192.png',
        vibrate: [200,100,200],
        data: { url: data.url || '/stock-auto/stock-dashboard.html' }
      })
    );
  } catch(e) {}
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/stock-auto/stock-dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      for(const c of list){
        if(c.url.includes('stock-dashboard') && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ── MESSAGE ──
self.addEventListener('message', event => {
  if(event.data?.action === 'SKIP_WAITING') self.skipWaiting();
  if(event.data?.action === 'CLEAR_CACHE')
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
});

console.log('[SW] StockAI Service Worker:', CACHE_VERSION);
