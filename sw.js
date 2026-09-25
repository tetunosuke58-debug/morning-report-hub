/* Static files only. No record, settings or backup is sent or cached here. */
'use strict';
const CACHE = 'morning-report-hub-shell-v1';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
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
