const SHARE_CACHE = 'roll-score-shared-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept share target POST requests
  if (event.request.method === 'POST' && url.pathname === '/index.html' && url.searchParams.has('shared')) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // All other requests pass through
  event.respondWith(fetch(event.request));
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const cache = await caches.open(SHARE_CACHE);

    const entries = [];
    for (const value of formData.values()) {
      if (value instanceof File && value.type.startsWith('image/')) {
        const key = '/_sw_share/file-' + entries.length;
        const response = new Response(value, {
          headers: {
            'Content-Type': value.type,
            'Content-Disposition': `inline; filename="${encodeURIComponent(value.name)}"`,
          },
        });
        await cache.put(key, response);
        entries.push({ name: value.name, type: value.type, key });
      }
    }

    if (entries.length > 0) {
      await cache.put(
        '/_sw_share/meta',
        new Response(JSON.stringify(entries), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
      return Response.redirect('/index.html?shared=1', 303);
    }

    return Response.redirect('/index.html?shared-empty=1', 303);
  } catch (err) {
    console.error('SW share target error:', err);
    return Response.redirect('/index.html?shared-error=1', 303);
  }
}
