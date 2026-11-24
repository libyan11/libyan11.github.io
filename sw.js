/* Game Night hub offline helper. Saves the hub page so it opens without internet.
   Each game has its own helper once it has been opened; a game that was never opened on this phone
   gets a short note instead of the browser's error page when there's no internet. */
const CACHE = 'gn-hub-v1';
const HOME = new URL('./', self.registration.scope).href;
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add(HOME)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('gn-hub-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const NOT_SAVED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No internet · Game Night</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14121F;color:#F4F2FA;font:16px/1.5 system-ui,sans-serif;padding:24px;text-align:center}
main{max-width:360px}h1{font-size:1.5rem;margin:0 0 8px}p{color:#A9A4C2}a{color:#F2B33D;font-weight:700}</style></head>
<body><main><h1>No internet right now</h1><p>This game isn't saved on this phone yet. Open it once while you're online and it will work offline after that, against the computer.</p><p><a href="/">Back to Game Night</a></p></main></body></html>`;
function page(req, key) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const saved = () => key ? caches.match(key) : Promise.resolve(null);
    const slow = setTimeout(() => saved().then(finish), 3500);
    fetch(req).then(res => {
      clearTimeout(slow);
      if (key && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}); }
      finish(res);
    }).catch(() => {
      clearTimeout(slow);
      saved().then(r => finish(r || new Response(NOT_SAVED, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    });
  });
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(page(req, url.pathname === '/' ? HOME : null));
});
