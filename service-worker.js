const CACHE_NAME = 'doce-capricho-v24';

const APP_SHELL = [
  '/',
  '/manifest.json',
  '/catalogo-padrao.js',
  '/vendor/qrcode.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/img/startup/iphone-640x1136.png',
  '/img/startup/iphone-750x1334.png',
  '/img/startup/iphone-828x1792.png',
  '/img/startup/iphone-1125x2436.png',
  '/img/startup/iphone-1170x2532.png',
  '/img/startup/iphone-1179x2556.png',
  '/img/startup/iphone-1206x2622.png',
  '/img/startup/iphone-1260x2736.png',
  '/img/startup/iphone-1284x2778.png',
  '/img/startup/iphone-1290x2796.png',
  '/img/startup/iphone-1320x2868.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );

  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('doce-capricho-v') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (
          request.mode === 'navigate' &&
          response &&
          response.ok &&
          new URL(request.url).origin === self.location.origin
        ) {
          const copia = response.clone();

          event.waitUntil(
            caches
              .open(CACHE_NAME)
              .then(cache => cache.put(request, copia))
          );
        }

        return response;
      })
      .catch(async () => {
        const respostaEmCache = await caches.match(request);

        if (respostaEmCache) {
          return respostaEmCache;
        }

        if (request.mode === 'navigate') {
          const paginaInicial = await caches.match('/');

          if (paginaInicial) {
            return paginaInicial;
          }
        }

        return Response.error();
      })
  );
});
