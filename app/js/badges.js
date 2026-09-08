import { refreshDashboardBadge as refreshMyCallsBadge } from "./caller.js";
import { refreshDashboardBadge as refreshCoreCultivationBadge } from "./coreCultivation.js";

// Refreshes both dashboard-card pending dots and the OS app-icon badge
// (Badging API) from their sum. Safe to call anytime the preaching dashboard
// exists in the DOM (login, session restore, or re-entering the dashboard).
export async function refreshAllBadges(user) {
  const [myCalls, coreCultivation] = await Promise.all([
    refreshMyCallsBadge(user),
    refreshCoreCultivationBadge(user),
  ]);

  setAppBadge(myCalls + coreCultivation);
}

export function setAppBadge(total) {
  if (!("setAppBadge" in navigator)) return;
  if (total > 0) navigator.setAppBadge(total).catch(() => {});
  else navigator.clearAppBadge?.().catch(() => {});
}
