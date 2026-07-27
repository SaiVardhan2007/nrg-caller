import { supabase } from "./supabaseClient.js";
import { getSession, setSession, login, logout } from "./auth.js";
import { showToast } from "./utils.js";
import * as Admin from "./admin.js";
import * as Caller from "./caller.js";
import * as Reception from "./reception.js";
import * as OneToOne from "./oneToOne.js";
import * as CoreCultivation from "./coreCultivation.js";
import * as Collection from "./collection.js";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const dashboard = document.getElementById("dashboard");
const adminTabs = document.getElementById("admin-tabs");
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
  "caller-section": "My Calls",
  "reception-section": "Reception",
  "one-to-one-user-section": "One to One with Prabhu",
  "core-cultivation-section": "Core Cultivation",
  "contact-collection-section": "Contact Collection",
};

let currentUser = null;

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

  if (id !== "admin-new-contacts-section") Admin.stopNewContactsPolling();
}

function goDashboard() {
  dashboard.classList.remove("hidden");
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  headerTitle.textContent = "FNRG Preaching";
  backBtn.classList.add("hidden");
}

function enterSection(id) {
  dashboard.classList.add("hidden");
  backBtn.classList.remove("hidden");
  showScreen(id);
}

function wireNav() {
  document.querySelectorAll(".dashboard-card").forEach((card) => {
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

  backBtn.addEventListener("click", () => {
    if (currentUser.role === "Admin" || currentUser.role === "Reception") return;
    goDashboard();
  });

  adminTabs.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      adminTabs.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
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
    adminTabs.classList.remove("hidden");
    dashboard.classList.add("hidden");
    backBtn.classList.add("hidden");
    // Show download-all-db button for admin
    const dlBtn = document.getElementById("download-all-db-btn");
    dlBtn.classList.remove("hidden");
    dlBtn.addEventListener("click", () => Admin.downloadAllDbData(), { once: true });
    // Show bulk-delete button for admin
    const bulkDelBtn = document.getElementById("bulk-delete-btn");
    bulkDelBtn.classList.remove("hidden");
    bulkDelBtn.addEventListener("click", () => Admin.openBulkDeleteModal(currentUser), { once: true });
    showScreen("admin-users-section");
  } else if (user.role === "Reception") {
    adminTabs.classList.add("hidden");
    dashboard.classList.add("hidden");
    backBtn.classList.add("hidden");
    showScreen("reception-section");
  } else {
    adminTabs.classList.add("hidden");
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
  });
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
