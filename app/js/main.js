import { supabase } from "./supabaseClient.js";
import { getSession, setSession, login, logout, refreshSession } from "./auth.js";
import { showToast } from "./utils.js";
import { initActivityLog, logEvent } from "./activityLog.js";
import * as Admin from "./admin.js";
import * as Caller from "./caller.js";
import * as Reception from "./reception.js";
import * as OneToOne from "./oneToOne.js";
import * as CoreCultivation from "./coreCultivation.js";
import * as Collection from "./collection.js";
import * as BookDistribution from "./bookDistribution.js";
import * as Sadhana from "./sadhana.js";
import * as Donations from "./donations.js";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const homeDashboard = document.getElementById("home-dashboard");
const preachingDashboard = document.getElementById("preaching-dashboard");
const bookDistUserDashboard = document.getElementById("book-distribution-user-dashboard");
const adminModuleDashboard = document.getElementById("admin-module-dashboard");
const adminTabs = document.getElementById("admin-tabs");
const bookTabs = document.getElementById("book-tabs");
const sadhanaTabs = document.getElementById("sadhana-tabs");
const donationsTabs = document.getElementById("donations-tabs");
const backBtn = document.getElementById("back-btn");
const headerTitle = document.getElementById("header-title");
const userNameEl = document.getElementById("user-name");
const roleBadgeEl = document.getElementById("role-badge");

const PAGE_TITLES = {
  "admin-users-section": "Users & Assignment",
  "admin-contacts-section": "Master Contact",
  "admin-new-contacts-section": "New Contacts",
  "admin-message-section": "Message",
  "admin-analytics-section": "Analytics",
  "admin-reception-analytics-section": "Reception Analytics",
  "admin-one-to-one-section": "One to One",
  "book-dashboard-section": "FNRG Srila Prabhupada Book Distribution",
  "book-inward-section": "FNRG Srila Prabhupada Book Distribution",
  "book-outward-section": "FNRG Srila Prabhupada Book Distribution",
  "book-places-section": "FNRG Srila Prabhupada Book Distribution",
  "book-events-section": "FNRG Srila Prabhupada Book Distribution",
  "book-requests-section": "FNRG Srila Prabhupada Book Distribution",
  "book-analytics-section": "FNRG Srila Prabhupada Book Distribution",
  "book-expenses-section": "FNRG Srila Prabhupada Book Distribution",
  "admin-sadhana-section": "FNRG Sadhana",
  "sadhana-users-section": "FNRG Sadhana",
  "sadhana-analytics-section": "FNRG Sadhana",
  "donations-dashboard-section": "Donations",
  "donations-transactions-section": "Donations",
  "donations-events-section": "Donations",
  "donations-analytics-section": "Donations",
  "caller-section": "My Calls",
  "reception-section": "Reception",
  "one-to-one-user-section": "One to One with Prabhu",
  "core-cultivation-section": "Core Cultivation",
  "contact-collection-section": "Contact Collection",
  "book-stock-entry-section": "Book Distribution",
  "book-requests-user-section": "Book Requests",
  "book-savings-user-section": "Tīrtha Nidhi",
  "book-places-user-section": "Add Places",
  "book-events-user-section": "Add Events",
  "commander-section": "Commander",
  "fnrg-sadhana-user-section": "FNRG Sadhana",
};

let currentUser = null;
let adminActionsWired = false;
// Which regular-user sub-dashboard the back button should return to
// (null when the current section was entered straight from home-dashboard).
let homeContext = null;

// Admin/Book-Distribution/Sadhana tabs load heavy tables on every visit even
// though the underlying data barely changes minute to minute. Skip re-fetching
// when hopping back to one of these within CACHE_TTL_MS of its last load; the
// refresh button (forceRefresh) always bypasses this. Regular-user sections are
// left out on purpose — their data (assigned calls, etc.) needs to stay live.
// New Contacts already keeps itself fresh via its own 10s poll, so it's excluded too.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHEABLE_SECTIONS = new Set([
  "admin-users-section",
  "admin-contacts-section",
  "admin-message-section",
  "admin-analytics-section",
  "admin-reception-analytics-section",
  "admin-one-to-one-section",
  "admin-sadhana-section",
  "sadhana-users-section",
  "sadhana-analytics-section",
  "donations-dashboard-section",
  "donations-transactions-section",
  "donations-events-section",
  "donations-analytics-section",
  "book-dashboard-section",
  "book-inward-section",
  "book-outward-section",
  "book-places-section",
  "book-events-section",
  "book-requests-section",
  "book-analytics-section",
  "book-expenses-section",
]);
const sectionLastLoaded = new Map();

function shouldSkipLoad(id, forceRefresh) {
  if (forceRefresh || !CACHEABLE_SECTIONS.has(id)) return false;
  const last = sectionLastLoaded.get(id);
  return last != null && Date.now() - last < CACHE_TTL_MS;
}

function showScreen(id, { forceRefresh = false } = {}) {
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
  headerTitle.textContent = PAGE_TITLES[id] || "FNRG Preaching";

  const skipLoad = shouldSkipLoad(id, forceRefresh);
  // `loaded` distinguishes an actual backend fetch from a cache hit, so the
  // weekly review can see both how often a screen is visited and how much
  // the caching added in this session is actually cutting real loads.
  logEvent("nav_section", { section: id, meta: { loaded: !skipLoad, forceRefresh } });

  if (!skipLoad) {
    if (CACHEABLE_SECTIONS.has(id)) sectionLastLoaded.set(id, Date.now());

    if (id === "caller-section") Caller.init(currentUser, { forceRefresh });
    if (id === "reception-section") Reception.init(currentUser);
    if (id === "admin-users-section") Admin.initUsers(currentUser);
    if (id === "admin-contacts-section") Admin.initContacts(currentUser);
    if (id === "admin-new-contacts-section") Admin.initNewContacts(currentUser);
    if (id === "admin-message-section") Admin.initMessage(currentUser);
    if (id === "admin-analytics-section") Admin.initAnalytics(currentUser);
    if (id === "admin-reception-analytics-section") Admin.initReceptionAnalytics();
    if (id === "admin-one-to-one-section") OneToOne.initAdminOneToOne(currentUser);
    if (id === "one-to-one-user-section") OneToOne.initUserOneToOne(currentUser);
    if (id === "core-cultivation-section") CoreCultivation.init(currentUser, { forceRefresh });
    if (id === "contact-collection-section") Collection.init(currentUser);
    if (id === "book-dashboard-section") BookDistribution.initDashboard(currentUser);
    if (id === "book-places-section") BookDistribution.initPlaces(currentUser);
    if (id === "book-events-section") BookDistribution.initBookEvents(currentUser);
    if (id === "book-requests-section") BookDistribution.initBookRequests(currentUser);
    if (id === "book-inward-section") BookDistribution.initInwardTable(currentUser);
    if (id === "book-outward-section") BookDistribution.initOutwardTable();
    if (id === "book-analytics-section") BookDistribution.initAnalytics();
    if (id === "book-expenses-section") BookDistribution.initExpenses(currentUser);
    if (id === "book-stock-entry-section") BookDistribution.initStockEntry(currentUser);
    if (id === "book-requests-user-section") BookDistribution.initRequestPanel(currentUser);
    if (id === "book-savings-user-section") BookDistribution.initSavingsPanel(currentUser);
    if (id === "book-places-user-section") BookDistribution.initPlacesUser();
    if (id === "book-events-user-section") BookDistribution.initEventsUser();
    if (id === "commander-section") BookDistribution.initCommander();
    if (id === "admin-sadhana-section") Sadhana.initSadhana(currentUser);
    if (id === "sadhana-users-section") Sadhana.initSadhanaUsers(currentUser);
    if (id === "sadhana-analytics-section") Sadhana.initSadhanaAnalytics();
    if (id === "fnrg-sadhana-user-section") Sadhana.initFnrgSadhanaUser(currentUser);
    if (id === "donations-dashboard-section") Donations.initDonationsDashboard(currentUser);
    if (id === "donations-transactions-section") Donations.initDonationsTransactions(currentUser);
    if (id === "donations-events-section") Donations.initDonationsEvents(currentUser);
    if (id === "donations-analytics-section") Donations.initDonationsAnalytics();
  }

  if (id !== "admin-new-contacts-section") Admin.stopNewContactsPolling();
}

function goHome() {
  homeContext = null;
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  preachingDashboard.classList.add("hidden");
  bookDistUserDashboard.classList.add("hidden");
  homeDashboard.classList.remove("hidden");
  headerTitle.textContent = "FNRG Preaching";
  backBtn.classList.add("hidden");
}

function enterPreachingDashboard() {
  homeContext = "preaching";
  homeDashboard.classList.add("hidden");
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  preachingDashboard.classList.remove("hidden");
  headerTitle.textContent = "Preaching";
  backBtn.classList.remove("hidden");
  Caller.refreshDashboardBadge(currentUser);
}

function enterBookDistUserDashboard() {
  homeContext = "book-distribution";
  homeDashboard.classList.add("hidden");
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  bookDistUserDashboard.classList.remove("hidden");
  headerTitle.textContent = "Book Distribution";
  backBtn.classList.remove("hidden");
}

function enterSection(id) {
  homeDashboard.classList.add("hidden");
  preachingDashboard.classList.add("hidden");
  bookDistUserDashboard.classList.add("hidden");
  backBtn.classList.remove("hidden");
  showScreen(id);
}

function enterHomeSection(target) {
  if (target === "preaching") enterPreachingDashboard();
  else if (target === "book-distribution") enterBookDistUserDashboard();
  else if (target === "contact-collection") {
    homeContext = null;
    enterSection("contact-collection-section");
  } else if (target === "fnrg-sadhana") {
    homeContext = null;
    enterSection("fnrg-sadhana-user-section");
  }
}

// download-all-db exports core contact/user data only, so it's hidden
// whenever the Book Distribution module is open. bulk-delete now also covers
// book data (see admin.js getBulkDeleteConfig), so it stays available there.
function setAdminWideActionsVisible(visible) {
  document.getElementById("download-all-db-btn").classList.toggle("hidden", !visible);
  document.getElementById("bulk-delete-btn").classList.toggle("hidden", !visible);
}

function goAdminModules() {
  adminTabs.classList.add("hidden");
  bookTabs.classList.add("hidden");
  sadhanaTabs.classList.add("hidden");
  donationsTabs.classList.add("hidden");
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  adminModuleDashboard.classList.remove("hidden");
  backBtn.classList.add("hidden");
  headerTitle.textContent = "FNRG Preaching";
  setAdminWideActionsVisible(true);
}

function enterAdminModule(module) {
  adminModuleDashboard.classList.add("hidden");
  backBtn.classList.remove("hidden");
  if (module === "book-distribution") {
    adminTabs.classList.add("hidden");
    sadhanaTabs.classList.add("hidden");
    donationsTabs.classList.add("hidden");
    bookTabs.classList.remove("hidden");
    bookTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    bookTabs.querySelector(".admin-tab").classList.add("active");
    document.getElementById("download-all-db-btn").classList.add("hidden");
    document.getElementById("bulk-delete-btn").classList.remove("hidden");
    showScreen("book-dashboard-section");
  } else if (module === "sadhana") {
    adminTabs.classList.add("hidden");
    bookTabs.classList.add("hidden");
    donationsTabs.classList.add("hidden");
    sadhanaTabs.classList.remove("hidden");
    sadhanaTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    sadhanaTabs.querySelector(".admin-tab").classList.add("active");
    document.getElementById("download-all-db-btn").classList.add("hidden");
    document.getElementById("bulk-delete-btn").classList.remove("hidden");
    showScreen("admin-sadhana-section");
  } else if (module === "donations") {
    adminTabs.classList.add("hidden");
    bookTabs.classList.add("hidden");
    sadhanaTabs.classList.add("hidden");
    donationsTabs.classList.remove("hidden");
    donationsTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    donationsTabs.querySelector(".admin-tab").classList.add("active");
    document.getElementById("download-all-db-btn").classList.add("hidden");
    document.getElementById("bulk-delete-btn").classList.remove("hidden");
    showScreen("donations-dashboard-section");
  } else {
    bookTabs.classList.add("hidden");
    sadhanaTabs.classList.add("hidden");
    donationsTabs.classList.add("hidden");
    adminTabs.classList.remove("hidden");
    adminTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    adminTabs.querySelector(".admin-tab").classList.add("active");
    setAdminWideActionsVisible(true);
    showScreen("admin-users-section");
  }
}

function wireDashboardCards(container, onSelect) {
  container.querySelectorAll(".dashboard-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (card.classList.contains("disabled")) return;
      card.classList.add("clicked");
      container.classList.add("leaving");
      setTimeout(() => {
        card.classList.remove("clicked");
        container.classList.remove("leaving");
        onSelect(card.dataset.target);
      }, 240);
    });
  });
}

function wireNav() {
  wireDashboardCards(homeDashboard, enterHomeSection);
  wireDashboardCards(preachingDashboard, enterSection);
  wireDashboardCards(bookDistUserDashboard, enterSection);
  wireDashboardCards(adminModuleDashboard, enterAdminModule);

  backBtn.addEventListener("click", () => {
    if (currentUser.role === "Admin") {
      goAdminModules();
      return;
    }
    if (currentUser.role === "Reception") return;
    const onPreachingDashboard = !preachingDashboard.classList.contains("hidden");
    const onBookDistDashboard = !bookDistUserDashboard.classList.contains("hidden");
    if (onPreachingDashboard || onBookDistDashboard) {
      goHome();
    } else if (homeContext === "preaching") {
      enterPreachingDashboard();
    } else if (homeContext === "book-distribution") {
      enterBookDistUserDashboard();
    } else {
      goHome();
    }
  });

  adminTabs.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      adminTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      showScreen(tab.dataset.target);
    });
  });

  bookTabs.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      bookTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      showScreen(tab.dataset.target);
    });
  });

  sadhanaTabs.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      sadhanaTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      showScreen(tab.dataset.target);
    });
  });

  donationsTabs.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      donationsTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      showScreen(tab.dataset.target);
    });
  });
}

function renderForRole(user) {
  userNameEl.textContent = user.user_name;
  document.getElementById("commander-dashboard-card").classList.toggle("hidden", !user.commander);
  if (user.role !== "Coordinator") {
    roleBadgeEl.textContent = user.role;
    roleBadgeEl.classList.remove("hidden");
  } else {
    roleBadgeEl.classList.add("hidden");
  }

  if (user.role === "Admin") {
    adminTabs.classList.add("hidden");
    bookTabs.classList.add("hidden");
    sadhanaTabs.classList.add("hidden");
    donationsTabs.classList.add("hidden");
    homeDashboard.classList.add("hidden");
    preachingDashboard.classList.add("hidden");
    bookDistUserDashboard.classList.add("hidden");
    backBtn.classList.add("hidden");
    // Show download-all-db and bulk-delete buttons for admin
    document.getElementById("download-all-db-btn").classList.remove("hidden");
    document.getElementById("bulk-delete-btn").classList.remove("hidden");
    if (!adminActionsWired) {
      adminActionsWired = true;
      document.getElementById("download-all-db-btn").addEventListener("click", () => Admin.downloadAllDbData());
      document.getElementById("bulk-delete-btn").addEventListener("click", () => Admin.openBulkDeleteModal(currentUser));
      Admin.maybeRunWeeklyDbExport();
      Admin.maybeRunWeeklyActivityReport();
    }
    goAdminModules();
  } else if (user.role === "Reception") {
    adminTabs.classList.add("hidden");
    bookTabs.classList.add("hidden");
    sadhanaTabs.classList.add("hidden");
    donationsTabs.classList.add("hidden");
    homeDashboard.classList.add("hidden");
    preachingDashboard.classList.add("hidden");
    bookDistUserDashboard.classList.add("hidden");
    backBtn.classList.add("hidden");
    showScreen("reception-section");
  } else {
    adminTabs.classList.add("hidden");
    bookTabs.classList.add("hidden");
    sadhanaTabs.classList.add("hidden");
    donationsTabs.classList.add("hidden");
    goHome();
  }
}

async function boot() {
  wireNav();

  const existing = getSession();
  if (existing) {
    currentUser = existing;
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    initActivityLog(currentUser);
    renderForRole(existing);

    currentUser = await refreshSession(existing);
    initActivityLog(currentUser);
    renderForRole(currentUser);
  }

  // Global click-to-copy handler for phone numbers
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.closest("button") || target.closest("a")) return;
    const cell = target.closest(".phone-cell, .phone-clickable, td[data-label='Phone']");
    if (cell) {
      const text = cell.textContent.replace(/\D/g, "");
      if (text.length === 10) {
        import("./utils.js").then(({ copyToClipboard }) => {
          copyToClipboard(text, cell);
        });
      }
    }
  });

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const uname = document.getElementById("login-username").value;
    const pw = document.getElementById("login-password").value;
    loginError.classList.add("hidden");
    loginSubmit.disabled = true;
    loginSubmit.querySelector(".btn-label").textContent = "Checking…";

    const res = await login(uname, pw);

    loginSubmit.disabled = false;
    loginSubmit.querySelector(".btn-label").textContent = "Enter";

    if (!res.ok) {
      loginError.textContent = res.message;
      loginError.classList.remove("hidden");
      return;
    }
    currentUser = res.user;
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    initActivityLog(currentUser);
    renderForRole(currentUser);
  });

  document.getElementById("logout-btn").addEventListener("click", logout);

  // Re-runs just the current page's init/render — never navigates away or
  // touches the session, so it can never bounce back to the login screen.
  document.getElementById("refresh-btn").addEventListener("click", () => {
    const visiblePage = document.querySelector(".page:not(.hidden)");
    if (visiblePage) showScreen(visiblePage.id, { forceRefresh: true });
    else if (!preachingDashboard.classList.contains("hidden")) Caller.refreshDashboardBadge(currentUser);
  });
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
  // Every deploy bumps sw.js's CACHE_NAME, which installs a new worker that
  // skipWaiting()s and claims this page — but the page that triggered that
  // install is still running old JS/CSS in memory. Reload once, automatically,
  // the moment the new worker takes over, instead of relying on a manual
  // second reload to actually see the update.
  let swRefreshed = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swRefreshed) return;
    swRefreshed = true;
    window.location.reload();
  });
}
