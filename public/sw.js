"use strict";

// There is no cached page/API schema to coordinate: let renewed devices adopt
// the coded-notification handler even while an older physician window is open.
self.addEventListener("install", event => { event.waitUntil(self.skipWaiting()); });

// The browser decrypts Web Push before delivering event.data. Accept anonymous
// codes or a generic feedback event, and derive all display text locally.
function codedNotification(event) {
  try {
    const payload = event.data?.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.v !== 1) return null;
    if (payload.type === "feedback") {
      if (Object.keys(payload).sort().join(",") !== "type,v") return null;
      return { body: "Yeni bir uygulama görüşü var.", tag: "revir-feedback", renotify: true, data: { url: "/doktor#doctor-feedback-details" } };
    }
    if (Object.keys(payload).sort().join(",") !== "code,day,type,v"
      || !["new", "waiting", "left", "message"].includes(payload.type)
      || typeof payload.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.day)
      || typeof payload.code !== "string") return null;
    const code = /^(Pzt|Salı|Sal|Çarş|Çar|Perş|Per|Cuma|Cum|Cmt|Pzr|Paz)-([1-9]\d{0,14})$/.exec(payload.code);
    const date = new Date(`${payload.day}T00:00:00.000Z`);
    if (!code || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== payload.day
      || ![["Pzr", "Paz"], ["Pzt"], ["Salı", "Sal"], ["Çarş", "Çar"], ["Perş", "Per"], ["Cuma", "Cum"], ["Cmt"]][date.getUTCDay()].includes(code[1])) return null;
    const label = { new: "yeni geliş bildirdi", waiting: "bekliyor", left: "ayrıldı, sonra gelecek", message: "hekime not iletti" }[payload.type];
    const day = `${payload.day.slice(8, 10)}.${payload.day.slice(5, 7)}`;
    return { body: `${payload.code} ${label}. (${day})`, tag: `revir-${payload.day}-${payload.code}`, renotify: true };
  } catch { return null; }
}

// No fetch handler or offline cache: private physician data stays on the server.
self.addEventListener("push", event => {
  const coded = codedNotification(event);
  event.waitUntil(self.registration.showNotification("Revir Haberleşme", {
    body: "Yeni geliş, mesaj, görüş veya bekleme durumu güncellemesi var.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // Request the device's normal alert sound; iOS notification, Silent and
    // Focus preferences still decide whether it can actually be heard.
    silent: false,
    data: { url: "/doktor" },
    ...(coded || {})
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    // Notification data is untrusted. Only the locally generated feedback
    // anchor may change the default physician destination.
    const destination = event.notification.data?.url === "/doktor#doctor-feedback-details"
      ? "/doktor#doctor-feedback-details" : "/doktor";
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const physicianWindow = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && ["/doktor", "/doktor/"].includes(url.pathname);
    });
    if (physicianWindow) {
      if (destination !== "/doktor") {
        // Keep unsent physician replies/settings in place. Each click asks the
        // open page to refresh feedback, even if that section is already open.
        physicianWindow.postMessage({ type: "revir-open-feedback" });
      }
      return physicianWindow.focus();
    }
    return self.clients.openWindow(destination);
  })());
});
