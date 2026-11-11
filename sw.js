
"use strict";

// Service Worker for is-aroace
const CACHE_NAME = "is-aroace-v1";

// Install
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// Activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
    })()
  );
});

// Receive push notifications
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {};

      // Read notification payload
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        try {
          data = {
            body: event.data ? event.data.text() : ""
          };
        } catch {
          data = {};
        }
      }

      const title = data.title || "is-aroace";

      const options = {
        body: data.body || "You have a new notification.",
        icon: data.icon || "/is-badge.png",
        badge: data.badge || "/is-badge.png",
        tag: data.tag || "is-aroace-notification",
        data: {
          url: data.url || "/",
          ...data.data
        },
        renotify: Boolean(data.renotify),
        timestamp: Date.now()
      };

      await self.registration.showNotification(title, options);
    })()
  );
});

// Notification clicked
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const target = new URL(
        event.notification.data?.url || "/",
        self.location.origin
      );

      // Only allow navigation within this website
      if (target.origin !== self.location.origin) {
        return;
      }

      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });

      for (const client of windows) {
        if ("focus" in client) {
          if (client.url !== target.href && "navigate" in client) {
            await client.navigate(target.href);
          }

          return client.focus();
        }
      }

      return self.clients.openWindow(target.href);
    })()
  );
});
