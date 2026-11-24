/* global SHELL, self, caches, URL, fetch */

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL.cache).then(cache => cache.addAll(SHELL.files)))
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const obsolete = (await caches.keys()).filter(key => key.startsWith('fluxparcel-shell-') && key !== SHELL.cache)
    await Promise.all(obsolete.map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search) return

  const navigation = event.request.mode === 'navigate'
  if (navigation && !/^\/(?:login|register|chats(?:\/[A-Za-z0-9_-]+)?|transfers|settings)?\/?$/.test(url.pathname)) return
  if (!navigation && !SHELL.files.includes(url.pathname)) return

  event.respondWith((async () => {
    const cache = await caches.open(SHELL.cache)
    return (await cache.match(navigation ? '/index.html' : url.pathname)) ?? fetch(event.request)
  })())
})
