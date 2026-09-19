self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Everything', {
      body: data.body || 'You have a task due.',
      icon: data.icon || undefined
    })
  );
});