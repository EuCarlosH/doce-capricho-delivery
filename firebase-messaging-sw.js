// firebase-messaging-sw.js
// Precisa ficar na RAIZ do site (mesmo nível do index.html), com exatamente esse nome.
// Ele só cuida de notificações push. O cache do app continua no seu service-worker.js normal.

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

// Precisa ser o MESMO objeto de configuração usado no index.html.
firebase.initializeApp({
  apiKey: "AIzaSyCU5CFz3cbrpyk3dsJBR46m-0km3kYkjJA",
  authDomain: "sistema-doce-capricho.firebaseapp.com",
  projectId: "sistema-doce-capricho",
  storageBucket: "sistema-doce-capricho.firebasestorage.app",
  messagingSenderId: "203794333208",
  appId: "1:203794333208:web:4c4bc82f2ebb6032ab0d6d"
});

const messaging = firebase.messaging();

// Chamado quando chega uma notificação e o app/aba NÃO está em primeiro plano.
messaging.onBackgroundMessage(payload => {
  const dados = payload.notification || {};
  const titulo = dados.title || 'Doce Capricho Atelier';
  const opcoes = {
    body: dados.body || 'Você tem uma novidade por aqui!',
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    data: { click_action: (payload.fcmOptions && payload.fcmOptions.link) || payload.data?.link || '/' }
  };
  self.registration.showNotification(titulo, opcoes);
});

// Ao tocar na notificação, abre (ou foca) o app.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destino = (event.notification.data && event.notification.data.click_action) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
      for (const cliente of lista) {
        if ('focus' in cliente) return cliente.focus();
      }
      if (clients.openWindow) return clients.openWindow(destino);
    })
  );
});
