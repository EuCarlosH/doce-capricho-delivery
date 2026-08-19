// O navegador exige que o fetch seja interceptado para validar o PWA
self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(event.request));
});

self.addEventListener('install', function(event) {
  self.skipWaiting();
  console.log('Service Worker do Doce Capricho instalado!');
});

self.addEventListener('activate', function(event) {
  console.log('Service Worker ativado e pronto.');
});
