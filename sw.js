/* Static files only. No record, settings or backup is sent or cached here. */
'use strict';
const CACHE = 'morning-report-hub-shell-v02-1';
const ASSETS = ['./','./index.html','./styles.css','./config.js','./google-drive-sync.js','./app.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install', event => {
  // Wait for old tabs to close; do not claim a running v0.1 page with v0.2 assets.
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(path=>new Request(path,{cache:'reload'})))));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('morning-report-hub-shell-') && k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url=new URL(event.request.url);
  const allowed=ASSETS.map(path=>new URL(path,self.registration.scope).href);
  if(event.request.method !== 'GET' || !allowed.includes(url.href)) return;
  event.respondWith(caches.open(CACHE).then(cache=>cache.match(event.request)).then(response=>response || fetch(event.request)));
});
