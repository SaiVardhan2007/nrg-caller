import { supabase } from "./supabaseClient.js";
import { getSession, setSession, login, logout } from "./auth.js";
import { showToast } from "./utils.js";
import * as Admin from "./admin.js";
import * as Caller from "./caller.js";
import * as Reception from "./reception.js";
import * as OneToOne from "./oneToOne.js";
import * as CoreCultivation from "./coreCultivation.js";
import * as Collection from "./collection.js";
import * as BookDistribution from "./bookDistribution.js";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const dashboard = document.getElementById("dashboard");
const adminModuleDashboard = document.getElementById("admin-module-dashboard");
const adminTabs = document.getElementById("admin-tabs");
const bookTabs = document.getElementById("book-tabs");
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
  "book-analytics-section": "FNRG Srila Prabhupada Book Distribution",
  "caller-section": "My Calls",
  "reception-section": "Reception",
  "one-to-one-user-section": "One to One with Prabhu",
  "core-cultivation-section": "Core Cultivation",
  "contact-collection-section": "Contact Collection",
  "book-stock-entry-section": "Book Distribution",
};

let currentUser = null;
let adminActionsWired = false;

function showScreen(id) {
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
  headerTitle.textContent = PAGE_TITLES[id] || "FNRG Preaching";

  if (id === "caller-section") Caller.init(currentUser);
  if (id === "reception-section") Reception.init(currentUser);
  if (id === "admin-users-section") Admin.initUsers(currentUser);
  if (id === "admin-contacts-section") Admin.initContacts(currentUser);
  if (id === "admin-new-contacts-section") Admin.initNewContacts(currentUser);
  if (id === "admin-message-section") Admin.initMessage(currentUser);
  if (id === "admin-analytics-section") Admin.initAnalytics(currentUser);
  if (id === "admin-reception-analytics-section") Admin.initReceptionAnalytics();
  if (id === "admin-one-to-one-section") OneToOne.initAdminOneToOne(currentUser);
  if (id === "one-to-one-user-section") OneToOne.initUserOneToOne(currentUser);
  if (id === "core-cultivation-section") CoreCultivation.init(currentUser);
  if (id === "contact-collection-section") Collection.init(currentUser);
  if (id === "book-dashboard-section") BookDistribution.initDashboard(currentUser);
  if (id === "book-places-section") BookDistribution.initPlaces(currentUser);
  if (id === "book-inward-section") BookDistribution.initInwardTable(currentUser);
  if (id === "book-outward-section") BookDistribution.initOutwardTable();
  if (id === "book-stock-entry-section") BookDistribution.initStockEntry(currentUser);

  if (id !== "admin-new-contacts-section") Admin.stopNewContactsPolling();
}

function goDashboard() {
  dashboard.classList.remove("hidden");
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  headerTitle.textContent = "FNRG Preaching";
  backBtn.classList.add("hidden");
  Caller.refreshDashboardBadge(currentUser);
}

function enterSection(id) {
  dashboard.classList.add("hidden");
  backBtn.classList.remove("hidden");
  showScreen(id);
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
    bookTabs.classList.remove("hidden");
    bookTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    bookTabs.querySelector(".admin-tab").classList.add("active");
    document.getElementById("download-all-db-btn").classList.add("hidden");
    document.getElementById("bulk-delete-btn").classList.remove("hidden");
    showScreen("book-dashboard-section");
  } else {
    bookTabs.classList.add("hidden");
    adminTabs.classList.remove("hidden");
    adminTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    adminTabs.querySelector(".admin-tab").classList.add("active");
    setAdminWideActionsVisible(true);
    showScreen("admin-users-section");
  }
}

function wireNav() {
  document.querySelectorAll("#dashboard .dashboard-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (card.classList.contains("disabled")) return;
      card.classList.add("clicked");
      dashboard.classList.add("leaving");
      setTimeout(() => {
        card.classList.remove("clicked");
        dashboard.classList.remove("leaving");
        enterSection(card.dataset.target);
      }, 240);
    });
  });

  adminModuleDashboard.querySelectorAll(".dashboard-card").forEach((card) => {
    card.addEventListener("click", () => {
      card.classList.add("clicked");
      adminModuleDashboard.classList.add("leaving");
      setTimeout(() => {
        card.classList.remove("clicked");
        adminModuleDashboard.classList.remove("leaving");
        enterAdminModule(card.dataset.target);
      }, 240);
    });
  });

  backBtn.addEventListener("click", () => {
    if (currentUser.role === "Admin") {
      goAdminModules();
      return;
    }
    if (currentUser.role === "Reception") return;
    goDashboard();
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
}

function renderForRole(user) {
  userNameEl.textContent = user.user_name;
  if (user.role !== "Coordinator") {
    roleBadgeEl.textContent = user.role;
    roleBadgeEl.classList.remove("hidden");
  } else {
    roleBadgeEl.classList.add("hidden");
  }

  if (user.role === "Admin") {
    adminTabs.classList.add("hidden");
    bookTabs.classList.add("hidden");
    dashboard.classList.add("hidden");
    backBtn.classList.add("hidden");
    // Show download-all-db and bulk-delete buttons for admin
    document.getElementById("download-all-db-btn").classList.remove("hidden");
    document.getElementById("bulk-delete-btn").classList.remove("hidden");
    if (!adminActionsWired) {
      adminActionsWired = true;
      document.getElementById("download-all-db-btn").addEventListener("click", () => Admin.downloadAllDbData());
      document.getElementById("bulk-delete-btn").addEventListener("click", () => Admin.openBulkDeleteModal(currentUser));
    }
    goAdminModules();
  } else if (user.role === "Reception") {
    adminTabs.classList.add("hidden");
    bookTabs.classList.add("hidden");
    dashboard.classList.add("hidden");
    backBtn.classList.add("hidden");
    showScreen("reception-section");
  } else {
    adminTabs.classList.add("hidden");
    bookTabs.classList.add("hidden");
    goDashboard();
  }
}

async function boot() {
  wireNav();

  const existing = getSession();
  if (existing) {
    currentUser = existing;
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    renderForRole(existing);
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
    renderForRole(currentUser);
  });

  document.getElementById("logout-btn").addEventListener("click", logout);

  // Re-runs just the current page's init/render — never navigates away or
  // touches the session, so it can never bounce back to the login screen.
  document.getElementById("refresh-btn").addEventListener("click", () => {
    const visiblePage = document.querySelector(".page:not(.hidden)");
    if (visiblePage) showScreen(visiblePage.id);
    else if (!dashboard.classList.contains("hidden")) Caller.refreshDashboardBadge(currentUser);
  });
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
