import { supabase } from "./supabaseClient.js";
import { VAPID_PUBLIC_KEY } from "./config.js";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

// Asks for notification permission (once per browser) and registers this
// device for push, saving the subscription against the logged-in user so
// the send-push Edge Function knows where to deliver. Safe to call on every
// login/session-restore — getSubscription() short-circuits once already
// subscribed, and the upsert on `endpoint` keeps re-saves harmless.
export async function subscribeToPush(currentUser) {
  if (!currentUser?.user_name) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (Notification.permission === "denied") return;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const { endpoint } = subscription;
    const p256dh = bufferToBase64(subscription.getKey("p256dh"));
    const auth = bufferToBase64(subscription.getKey("auth"));

    const { error } = await supabase
      .from("push_subscriptions")
      .upsert({ user_name: currentUser.user_name, endpoint, p256dh, auth }, { onConflict: "endpoint" });
    if (error) console.warn("push subscription save failed:", error.message);
  } catch (err) {
    console.warn("push subscribe failed:", err.message);
  }
}
