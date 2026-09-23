import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, debounce, normalizePhoneInput, formatPhone, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll, populateFilterSelect, exportTableToExcel, initMobileFilterDrawer } from "./utils.js";
import { wireSearchableCombo, fmtMoney } from "./bookDistribution.js";
import { localDateInput, todayLocalDate } from "./sadhana.js";

function sortRows(rows, field, dir) {
  const ascending = dir !== "desc";
  return [...rows].sort((a, b) => {
    let av = a[field], bv = b[field];
    if (typeof av === "string" || typeof bv === "string") {
      av = (av || "").toLowerCase();
      bv = (bv || "").toLowerCase();
      return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    av = av ?? 0;
    bv = bv ?? 0;
    return ascending ? av - bv : bv - av;
  });
}

/* ======================= DASHBOARD =======================
   Donors are a curated subset of Master Contact — nobody shows up here
   until an admin searches their phone number (against `contacts`) and adds
   them. Total Amount is a live sum of that donor's rows in `donations`;
   clicking it opens the donor's full transaction history. */

let donorsCache = [];
let dashboardTxCache = [];
let dashboardWired = false;
let foundContact = null;

function donorTotal(mobNo) {
  return dashboardTxCache.filter((t) => t.mob_no === mobNo).reduce((s, t) => s + Number(t.amount || 0) - Number(t.utilised || 0), 0);
}

function matchesDashboardSearch(donor, term) {
  if (!term) return true;
  return (donor.name || "").toLowerCase().includes(term) || (donor.mob_no || "").includes(term);
}

function renderDonationsDashboard(rows) {
  const tbody = document.getElementById("donations-dashboard-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted-text">${donorsCache.length ? "No donors match your search." : "No donors yet — search a phone number above to add one."}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((d, idx) => `
    <tr data-id="${d.id}" data-mob="${d.mob_no}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name">${escapeHtml(d.name)}</td>
      <td data-label="Number">${formatPhone(d.mob_no)}</td>
      <td data-label="Total Amount"><button type="button" class="cell-chip donations-view-total-btn">${fmtMoney(donorTotal(d.mob_no))}</button></td>
      <td data-label="">
        <button type="button" class="cell-chip danger donations-remove-donor-btn" title="Remove donor">🗑 Remove</button>
      </td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".donations-view-total-btn").forEach((btn) => {
    btn.addEventListener("click", () => openDonorDetail(btn.closest("tr").dataset.mob));
  });
  tbody.querySelectorAll(".donations-remove-donor-btn").forEach((btn) => {
    btn.addEventListener("click", () => removeDonor(btn.closest("tr").dataset.id));
  });
}

function applyDonationsDashboardFilters() {
  const search = document.getElementById("donations-dashboard-search")?.value.trim().toLowerCase() || "";
  const rows = donorsCache.filter((d) => matchesDashboardSearch(d, search));
  const [field, dir] = (document.getElementById("donations-dashboard-sort")?.value || "name-asc").split("-");
  const sorted = field === "amount"
    ? [...rows].sort((a, b) => dir === "desc" ? donorTotal(b.mob_no) - donorTotal(a.mob_no) : donorTotal(a.mob_no) - donorTotal(b.mob_no))
    : sortRows(rows, field, dir);
  renderDonationsDashboard(sorted);
}

function openDonorDetail(mobNo) {
  const donor = donorsCache.find((d) => d.mob_no === mobNo);
  const rows = dashboardTxCache
    .filter((t) => t.mob_no === mobNo)
    .sort((a, b) => (b.donation_date || "").localeCompare(a.donation_date || ""));
  document.getElementById("donation-donor-detail-title").textContent = `${donor?.name || ""} — Transactions`;
  document.getElementById("donation-donor-detail-body").innerHTML = rows.length ? rows.map((t) => `
    <tr>
      <td>${t.donation_date || "—"}</td>
      <td>${fmtMoney(t.amount)}</td>
      <td>${fmtMoney(t.utilised || 0)}</td>
      <td>${escapeHtml(t.remarks || "—")}</td>
      <td>${escapeHtml(t.event || "—")}</td>
    </tr>
  `).join("") : `<tr><td colspan="5" class="muted-text">No transactions yet.</td></tr>`;
  document.getElementById("donation-donor-detail-modal").classList.add("active");
}

async function removeDonor(id) {
  const donor = donorsCache.find((d) => d.id === id);
  if (!confirm(`Remove "${donor?.name || ""}" from Donations? This also deletes all of their logged transactions.`)) return;
  const { error } = await supabase.from("donation_donors").delete().eq("id", id);
  if (error) {
    showToast("Remove failed: " + error.message, "error");
    return;
  }
  showToast("Donor removed", "success");
  await loadDonationsDashboard();
}

function resetDonorSearch() {
  document.getElementById("donations-add-donor-search").value = "";
  document.getElementById("donations-add-donor-result").classList.add("hidden");
  document.getElementById("donations-add-donor-not-found").classList.add("hidden");
  foundContact = null;
}

function wireDonorSearch() {
  const input = document.getElementById("donations-add-donor-search");
  const resultEl = document.getElementById("donations-add-donor-result");
  const notFoundEl = document.getElementById("donations-add-donor-not-found");
  const addBtn = document.getElementById("donations-add-donor-btn");

  input.addEventListener("input", async (e) => {
    const digits = normalizePhoneInput(e.target.value);
    e.target.value = digits;
    resultEl.classList.add("hidden");
    notFoundEl.classList.add("hidden");
    foundContact = null;
    if (digits.length !== 10) return;

    const { data } = await supabase.from("contacts").select("id,name,mob_no").eq("mob_no", digits).maybeSingle();
    if (!data) {
      notFoundEl.classList.remove("hidden");
      return;
    }
    foundContact = data;
    const alreadyAdded = donorsCache.some((d) => d.mob_no === data.mob_no);
    document.getElementById("donations-add-donor-name").textContent = data.name;
    document.getElementById("donations-add-donor-phone").textContent = formatPhone(data.mob_no);
    addBtn.disabled = alreadyAdded;
    addBtn.textContent = alreadyAdded ? "✓ Already Added" : "Add";
    resultEl.classList.remove("hidden");
  });

  addBtn.addEventListener("click", async () => {
    if (!foundContact) return;
    addBtn.disabled = true;
    const { error } = await supabase.from("donation_donors").insert({ mob_no: foundContact.mob_no, name: foundContact.name });
    addBtn.disabled = false;
    if (error) {
      showToast("Could not add donor: " + error.message, "error");
      return;
    }
    showToast(`${foundContact.name} added to Donations`, "success");
    resetDonorSearch();
    await loadDonationsDashboard();
  });

  document.getElementById("donations-add-donor-cancel").addEventListener("click", resetDonorSearch);
}

function wireDonationsDashboard() {
  if (dashboardWired) return;
  dashboardWired = true;
  wireDonorSearch();
  document.getElementById("donations-dashboard-search").addEventListener("input", debounce(applyDonationsDashboardFilters, 200));
  document.getElementById("donations-dashboard-sort").addEventListener("change", applyDonationsDashboardFilters);
  initHorizontalScroll("donations-dashboard-table-wrap");
  initMobileFilterDrawer("donations-dashboard-section");

  // Mobile: tapping a row (not one of its buttons) expands it in place to
  // reveal Number and Remove — same pattern as Commander/Book Dashboard.
  document.getElementById("donations-dashboard-body").addEventListener("click", (e) => {
    if (window.innerWidth > 640) return;
    if (e.target.closest("input, button, select, a")) return;
    const row = e.target.closest("tr[data-id]");
    if (row) row.classList.toggle("expanded");
  });

  const detailModal = document.getElementById("donation-donor-detail-modal");
  document.getElementById("donation-donor-detail-close-btn").addEventListener("click", () => detailModal.classList.remove("active"));
  detailModal.addEventListener("click", (e) => { if (e.target === detailModal) detailModal.classList.remove("active"); });
}

async function loadDonationsDashboard() {
  const tbody = document.getElementById("donations-dashboard-body");
  tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Loading…</td></tr>`;

  const [{ data: donors, error: donorsErr }, { data: tx, error: txErr }] = await Promise.all([
    supabase.from("donation_donors").select("id,mob_no,name").order("name"),
    supabase.from("donations").select("mob_no,amount,event,donation_date,utilised,remarks"),
  ]);

  if (donorsErr || txErr) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading-row">Could not load donors.</td></tr>`;
    return;
  }
  donorsCache = donors || [];
  dashboardTxCache = tx || [];
  applyDonationsDashboardFilters();
}

export async function initDonationsDashboard() {
  wireDonationsDashboard();
  await loadDonationsDashboard();
}

/* ======================= TRANSACTIONS =======================
   The donation log: S.No, Name, Number, Amount, Event. Donor is picked via
   a searchable dropdown (name + number) built only from donation_donors —
   "the users will be from preaching but not all", so the picker is scoped
   to the curated donor list, not the full Master Contact roster. */

const DONATIONS_COLUMNS_KEY = "nrg-donations-column-order";
const DEFAULT_DONATIONS_COLUMNS = ["S.No", "Time Stamp", "Name", "Number", "Amount", "Utilised", "Remarks", "Date", "Event", ""];

let transactionsCache = [];
let txFiltersWired = false;
let txModalWired = false;
let txDonorCombo = null;

function donorLabel(d) {
  return `${d.name} — ${d.mob_no}`;
}

function matchesTxSearch(row, term) {
  if (!term) return true;
  return (row.name || "").toLowerCase().includes(term) || (row.mob_no || "").includes(term);
}

function renderDonationsTxRows(rows) {
  const tbody = document.getElementById("donations-tx-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="muted-text">${transactionsCache.length ? "No transactions match your filters." : "No transactions yet — add one to get started."}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-id="${r.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Time Stamp">${r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
      <td data-label="Name"><input class="inline-edit" type="text" data-field="name" value="${escapeHtml(r.name)}" /></td>
      <td data-label="Number"><input class="inline-edit" type="tel" inputmode="numeric" data-field="mob_no" value="${escapeHtml(r.mob_no)}" /></td>
      <td data-label="Amount"><input class="inline-edit" type="number" min="0" step="any" data-field="amount" value="${r.amount ?? ""}" /></td>
      <td data-label="Utilised"><input class="inline-edit" type="number" min="0" step="any" data-field="utilised" value="${r.utilised || ""}" placeholder="0" /></td>
      <td data-label="Remarks"><input class="inline-edit" type="text" data-field="remarks" value="${escapeHtml(r.remarks || "")}" placeholder="Optional" /></td>
      <td data-label="Date"><input class="inline-edit" type="date" data-field="donation_date" value="${r.donation_date || ""}" /></td>
      <td data-label="Event"><select class="inline-edit" data-field="event">${eventOptionsHtml(r.event || "")}</select></td>
      <td data-label="">
        <button type="button" class="cell-chip danger donation-tx-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".donation-tx-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteDonationTx(btn.closest("tr").dataset.id));
  });
  wireDonationsTxInlineEdit(tbody);
  reapplyColumnOrder("donations-tx-table");
}

// Click-to-edit for Name/Number/Amount/Event, same pattern as Sadhana's
// wireInlineEditCells — saves straight to Supabase on change/blur.
function wireDonationsTxInlineEdit(tbody) {
  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    // Scrolling the page while the cursor happens to sit over a focused
    // number field silently bumps its value in Chrome/Firefox — blur it on
    // wheel so a scroll always scrolls the page, never Amount/Utilised.
    if (el.type === "number") {
      el.addEventListener("wheel", () => el.blur(), { passive: true });
    }
    // Enter moves to the same field one row down (spreadsheet-style) instead
    // of doing nothing useful or nudging a number field.
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const nextRow = e.target.closest("tr")?.nextElementSibling;
      const nextField = nextRow?.querySelector(`[data-field="${e.target.dataset.field}"]`);
      if (nextField) {
        nextField.focus();
        nextField.select?.();
      } else {
        e.target.blur();
      }
    });
    el.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const field = e.target.dataset.field;
      const record = transactionsCache.find((x) => x.id === id);
      let raw = e.target.value.trim();

      if (field === "name" && !raw) {
        showToast("Name cannot be empty.", "error");
        e.target.value = record.name ?? "";
        return;
      }
      if (field === "mob_no") {
        raw = normalizePhoneInput(raw);
        if (raw.length !== 10) {
          showToast("Phone number must be 10 digits.", "error");
          e.target.value = record.mob_no ?? "";
          return;
        }
        e.target.value = raw;
      }
      if (field === "amount") {
        const amount = Number(raw);
        if (!raw || Number.isNaN(amount) || amount <= 0) {
          showToast("Please enter a valid amount.", "error");
          e.target.value = record.amount ?? "";
          return;
        }
        raw = amount;
      }
      if (field === "utilised") {
        const utilised = raw === "" ? 0 : Number(raw);
        if (Number.isNaN(utilised) || utilised < 0) {
          showToast("Please enter a valid utilised amount.", "error");
          e.target.value = record.utilised || "";
          return;
        }
        if (utilised > Number(record.amount || 0)) {
          showToast("Utilised amount cannot exceed the donated amount.", "error");
          e.target.value = record.utilised || "";
          return;
        }
        raw = utilised;
      }
      if (field === "donation_date" && !raw) {
        showToast("Date cannot be empty.", "error");
        e.target.value = record.donation_date ?? "";
        return;
      }

      const value = (field === "event" || field === "remarks") ? (raw || null) : raw;
      const { error } = await supabase.from("donations").update({ [field]: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.value = record[field] ?? "";
        return;
      }
      record[field] = value;
    });
  });
}

function applyDonationsTxFilters() {
  const search = document.getElementById("donations-tx-search")?.value.trim().toLowerCase() || "";
  const eventFilter = document.getElementById("donations-tx-th-filter-event")?.value ?? "__ALL__";
  let rows = transactionsCache.filter((r) => {
    if (!matchesTxSearch(r, search)) return false;
    if (eventFilter === "__ALL__") return true;
    return (r.event || "") === eventFilter;
  });
  const [field, dir] = (document.getElementById("donations-tx-sort")?.value || "created_at-desc").split("-");
  rows = sortRows(rows, field, dir);
  renderDonationsTxRows(rows);
}

function wireDonationsTxFilters() {
  if (txFiltersWired) return;
  txFiltersWired = true;
  document.getElementById("donations-tx-search").addEventListener("input", debounce(applyDonationsTxFilters, 200));
  document.getElementById("donations-tx-sort").addEventListener("change", applyDonationsTxFilters);
  document.getElementById("donations-tx-th-filter-event").addEventListener("change", applyDonationsTxFilters);
  initColumnDragReorder("donations-tx-table", { storageKey: DONATIONS_COLUMNS_KEY, columns: DEFAULT_DONATIONS_COLUMNS, resetBtnId: "donations-tx-reset-columns-btn" });
  initHorizontalScroll("donations-tx-table-wrap");
  initMobileFilterDrawer("donations-transactions-section");
  document.getElementById("donations-tx-body").addEventListener("click", (e) => {
    if (window.innerWidth > 640) return;
    if (e.target.closest("input, button, select, a")) return;
    const row = e.target.closest("tr[data-id]");
    if (row) row.classList.toggle("expanded");
  });
}

async function deleteDonationTx(id) {
  const r = transactionsCache.find((x) => x.id === id);
  if (!confirm(`Delete this ${fmtMoney(r?.amount)} donation from "${r?.name || ""}"?`)) return;
  const { error } = await supabase.from("donations").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Transaction deleted", "success");
  await loadDonationsTransactions();
}

function eventOptionsHtml(selected = "") {
  return `<option value="">—</option>` + eventsCache.map((e) => `<option value="${escapeHtml(e.name)}" ${e.name === selected ? "selected" : ""}>${escapeHtml(e.name)}</option>`).join("");
}

function openDonationTxModal() {
  document.getElementById("donation-tx-donor").value = "";
  document.getElementById("donation-tx-amount").value = "";
  document.getElementById("donation-tx-date").value = todayLocalDate();
  document.getElementById("donation-tx-event").innerHTML = eventOptionsHtml();
  document.getElementById("donation-tx-error").classList.add("hidden");
  document.getElementById("donation-transaction-modal").classList.add("active");
}

function wireDonationTxModal(currentUser) {
  if (txModalWired) return;
  txModalWired = true;

  const modal = document.getElementById("donation-transaction-modal");
  const errorEl = document.getElementById("donation-tx-error");
  const donorInput = document.getElementById("donation-tx-donor");
  txDonorCombo = wireSearchableCombo(donorInput, () => donorsCache.map(donorLabel));

  document.getElementById("add-donation-btn").onclick = () => openDonationTxModal();
  document.getElementById("donation-tx-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("donation-tx-save-btn").onclick = async () => {
    const donorText = donorInput.value.trim().toLowerCase();
    const donor = donorsCache.find((d) => donorLabel(d).toLowerCase() === donorText);
    const amountRaw = document.getElementById("donation-tx-amount").value;
    const donationDate = document.getElementById("donation-tx-date").value;
    const event = document.getElementById("donation-tx-event").value;

    if (!donor) {
      errorEl.textContent = "Please pick a donor from the suggestions.";
      errorEl.classList.remove("hidden");
      return;
    }
    const amount = Number(amountRaw);
    if (!amountRaw || Number.isNaN(amount) || amount <= 0) {
      errorEl.textContent = "Please enter a valid amount.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!donationDate) {
      errorEl.textContent = "Please pick a date.";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("donations").insert({
      mob_no: donor.mob_no,
      name: donor.name,
      amount,
      donation_date: donationDate,
      event: event || null,
      added_by: currentUser?.user_name || null,
    });

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Donation added", "success");
    await loadDonationsTransactions();
  };
}

async function loadDonationsTransactions() {
  const tbody = document.getElementById("donations-tx-body");
  tbody.innerHTML = `<tr><td colspan="10" class="loading-row">Loading…</td></tr>`;

  const [{ data: tx, error: txErr }, { data: donors, error: donorsErr }, { data: events }] = await Promise.all([
    supabase.from("donations").select("id,mob_no,name,amount,event,donation_date,created_at,utilised,remarks").order("created_at", { ascending: false }),
    supabase.from("donation_donors").select("id,mob_no,name").order("name"),
    supabase.from("donation_events").select("id,name").order("name"),
  ]);

  if (txErr || donorsErr) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-row">Could not load transactions.</td></tr>`;
    return;
  }
  transactionsCache = tx || [];
  donorsCache = donors || [];
  eventsCache = events || [];

  const eventFilter = document.getElementById("donations-tx-th-filter-event");
  const current = eventFilter.value;
  eventFilter.innerHTML = `<option value="__ALL__">All</option><option value="">—</option>` +
    eventsCache.map((e) => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`).join("");
  eventFilter.value = [...eventFilter.options].some((o) => o.value === current) ? current : "__ALL__";

  applyDonationsTxFilters();
}

export async function initDonationsTransactions(currentUser) {
  wireDonationsTxFilters();
  wireDonationTxModal(currentUser);
  await loadDonationsTransactions();
}

/* ======================= EVENTS =======================
   A small admin-managed list of donation event names (e.g. Rath Yatra,
   Janmashtami collection drive), tagged onto individual transactions —
   its own table so it doesn't collide with the unrelated calling-purpose
   `events` table, same reasoning as Book Distribution's book_events. */

let eventsCache = [];
let evFiltersWired = false;
let evModalWired = false;

function renderDonationEventsRows(rows) {
  const tbody = document.getElementById("donations-ev-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted-text">${eventsCache.length ? "No events match your search." : "No events yet — add one to get started."}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((e, idx) => `
    <tr data-id="${e.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name">${escapeHtml(e.name)}</td>
      <td data-label="">
        <button type="button" class="cell-chip danger donation-event-delete-btn" title="Delete">🗑 Delete</button>
      </td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".donation-event-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteDonationEvent(btn.closest("tr").dataset.id));
  });
}

function applyDonationEventsFilters() {
  const search = document.getElementById("donations-ev-search")?.value.trim().toLowerCase() || "";
  let rows = eventsCache.filter((e) => !search || (e.name || "").toLowerCase().includes(search));
  const [field, dir] = (document.getElementById("donations-ev-sort")?.value || "name-asc").split("-");
  rows = sortRows(rows, field, dir);
  renderDonationEventsRows(rows);
}

function wireDonationEventsFilters() {
  if (evFiltersWired) return;
  evFiltersWired = true;
  document.getElementById("donations-ev-search").addEventListener("input", debounce(applyDonationEventsFilters, 200));
  document.getElementById("donations-ev-sort").addEventListener("change", applyDonationEventsFilters);
  initHorizontalScroll("donations-ev-table-wrap");
  initMobileFilterDrawer("donations-events-section");
}

async function deleteDonationEvent(id) {
  const e = eventsCache.find((x) => x.id === id);
  if (!confirm(`Delete event "${e?.name || ""}"? Transactions already tagged with it keep their Event text.`)) return;
  const { error } = await supabase.from("donation_events").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  showToast("Event deleted", "success");
  await loadDonationEvents();
}

function wireDonationEventModal() {
  if (evModalWired) return;
  evModalWired = true;

  const modal = document.getElementById("donation-event-modal");
  const errorEl = document.getElementById("donation-event-error");

  document.getElementById("add-donation-event-btn").onclick = () => {
    document.getElementById("donation-event-name").value = "";
    errorEl.classList.add("hidden");
    modal.classList.add("active");
  };
  document.getElementById("donation-event-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("donation-event-save-btn").onclick = async () => {
    const name = document.getElementById("donation-event-name").value.trim();
    if (!name) {
      errorEl.textContent = "Please enter a name for this event.";
      errorEl.classList.remove("hidden");
      return;
    }
    const { error } = await supabase.from("donation_events").insert({ name });
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast("Event added", "success");
    await loadDonationEvents();
  };
}

async function loadDonationEvents() {
  const tbody = document.getElementById("donations-ev-body");
  tbody.innerHTML = `<tr><td colspan="3" class="loading-row">Loading…</td></tr>`;

  const { data, error } = await supabase.from("donation_events").select("id,name").order("name");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="3" class="loading-row">Could not load events.</td></tr>`;
    return;
  }
  eventsCache = data || [];
  applyDonationEventsFilters();
}

export async function initDonationsEvents() {
  wireDonationEventsFilters();
  wireDonationEventModal();
  await loadDonationEvents();
}

/* ======================= ANALYTICS =======================
   Aggregates `donations` rows (over a date range / donor / event filter)
   into a per-donor leaderboard — transaction count, total amount, last
   donation date — mirroring Sadhana's analytics tab. Raw rows for the
   current run are kept in analyticsRows so the per-row "View" drill-down
   and the Sort By control can re-slice client-side without re-querying. */

let analyticsRows = [];
let analyticsFiltersWired = false;

function buildDonationLeaderboard(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.mob_no)) {
      map.set(r.mob_no, { mob_no: r.mob_no, name: r.name, count: 0, total: 0, utilised: 0, lastDate: null });
    }
    const e = map.get(r.mob_no);
    e.count++;
    e.total += Number(r.amount || 0) - Number(r.utilised || 0);
    e.utilised += Number(r.utilised || 0);
    if (!e.lastDate || r.donation_date > e.lastDate) e.lastDate = r.donation_date;
  });
  return Array.from(map.values());
}

function sortDonationLeaderboard(rows, sortVal) {
  const [field, dir] = (sortVal || "amount-desc").split("-");
  const ascending = dir !== "desc";
  const valueOf = (r) => {
    if (field === "amount") return r.total;
    if (field === "count") return r.count;
    return (r.name || "").toLowerCase();
  };
  return [...rows].sort((a, b) => {
    const av = valueOf(a), bv = valueOf(b);
    if (typeof av === "string" || typeof bv === "string") return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    return ascending ? av - bv : bv - av;
  });
}

function renderDonationAnalyticsStats(rows, leaderboard) {
  const totalDonated = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalUtilised = rows.reduce((s, r) => s + Number(r.utilised || 0), 0);
  document.getElementById("da-stat-amount").textContent = fmtMoney(totalDonated - totalUtilised);
  document.getElementById("da-stat-transactions").textContent = rows.length;
  document.getElementById("da-stat-donors").textContent = leaderboard.length;
  document.getElementById("da-stat-utilised").textContent = fmtMoney(totalUtilised);
}

function renderDonationLeaderboard(rows) {
  const tbody = document.getElementById("da-leaderboard-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">No donations match these filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => `
    <tr>
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Name">${escapeHtml(r.name)}</td>
      <td data-label="Number">${formatPhone(r.mob_no)}</td>
      <td data-label="Transactions">${r.count}</td>
      <td data-label="Total Amount">${fmtMoney(r.total)}</td>
      <td data-label="Last Donation">${r.lastDate || "—"}</td>
      <td data-label="" class="no-export"><button type="button" class="cell-chip da-view-btn" data-mob="${r.mob_no}">👁 View</button></td>
    </tr>`).join("");
  tbody.querySelectorAll(".da-view-btn").forEach((btn) => {
    btn.addEventListener("click", () => openDonationAnalyticsDetail(btn.dataset.mob));
  });
}

function openDonationAnalyticsDetail(mobNo) {
  const rows = analyticsRows.filter((r) => r.mob_no === mobNo).sort((a, b) => (b.donation_date || "").localeCompare(a.donation_date || ""));
  document.getElementById("donation-analytics-detail-title").textContent = `${rows[0]?.name || ""} — Transactions`;
  document.getElementById("donation-analytics-detail-body").innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td data-label="Date">${r.donation_date || "—"}</td>
      <td data-label="Amount">${fmtMoney(r.amount)}</td>
      <td data-label="Utilised">${fmtMoney(r.utilised || 0)}</td>
      <td data-label="Remarks">${escapeHtml(r.remarks || "—")}</td>
      <td data-label="Event">${escapeHtml(r.event || "—")}</td>
    </tr>
  `).join("") : `<tr><td colspan="5" class="muted-text">No transactions.</td></tr>`;
  document.getElementById("donation-analytics-detail-modal").classList.add("active");
}

// Re-slices the already-fetched analyticsRows by Sort By without
// re-querying Supabase — only the date-range/donor/event filters (in the
// sidebar's View button) trigger a fresh fetch.
function refreshDonationLeaderboardView() {
  const leaderboard = sortDonationLeaderboard(buildDonationLeaderboard(analyticsRows), document.getElementById("da-sort").value);
  renderDonationAnalyticsStats(analyticsRows, leaderboard);
  renderDonationLeaderboard(leaderboard);
}

async function runDonationAnalytics() {
  const from = document.getElementById("da-from").value;
  const to = document.getElementById("da-to").value;
  const donorSel = document.getElementById("da-filter-donor-select").value;
  const eventSel = document.getElementById("da-filter-event-select").value;

  let query = supabase.from("donations").select("mob_no,name,amount,event,donation_date,utilised,remarks");
  if (from) query = query.gte("donation_date", from);
  if (to) query = query.lte("donation_date", to);
  if (donorSel && donorSel !== "__ALL__") query = query.eq("mob_no", donorSel);
  if (eventSel && eventSel !== "__ALL__") query = query.eq("event", eventSel);

  const { data, error } = await query;
  if (error) {
    showToast("Could not load donation analytics.", "error");
    return;
  }
  analyticsRows = data || [];
  refreshDonationLeaderboardView();
}

async function wireDonationAnalyticsFilters() {
  if (analyticsFiltersWired) return;
  analyticsFiltersWired = true;

  const d = new Date();
  d.setDate(d.getDate() - 30);
  document.getElementById("da-from").value = localDateInput(d);
  document.getElementById("da-to").value = todayLocalDate();

  const { data: donors } = await supabase.from("donation_donors").select("mob_no,name").order("name");
  const donorSelect = document.getElementById("da-filter-donor-select");
  donorSelect.innerHTML = `<option value="__ALL__">All</option>` +
    (donors || []).map((d) => `<option value="${escapeHtml(d.mob_no)}">${escapeHtml(d.name)}</option>`).join("");

  const { data: events } = await supabase.from("donation_events").select("name").order("name");
  populateFilterSelect(document.getElementById("da-filter-event-select"), (events || []).map((e) => e.name));

  initMobileFilterDrawer("donations-analytics-section");
  document.getElementById("da-run-btn").addEventListener("click", runDonationAnalytics);
  document.getElementById("da-sort").addEventListener("change", refreshDonationLeaderboardView);
  document.getElementById("da-export-btn").addEventListener("click", () => {
    exportTableToExcel(document.getElementById("da-leaderboard-table"), "FNRG_Donations_Analytics.xlsx");
  });

  // Mobile: tapping a row (not the View button) expands it in place to
  // reveal Number/Transactions/Last Donation — same pattern as Book
  // Analytics Segments above. Rows have no stable id, only need the class flip.
  document.getElementById("da-leaderboard-body").addEventListener("click", (e) => {
    if (window.innerWidth > 640) return;
    if (e.target.closest("button")) return;
    const row = e.target.closest("tbody tr");
    if (row) row.classList.toggle("expanded");
  });

  const detailModal = document.getElementById("donation-analytics-detail-modal");
  document.getElementById("donation-analytics-detail-close").addEventListener("click", () => detailModal.classList.remove("active"));
  detailModal.addEventListener("click", (e) => { if (e.target === detailModal) detailModal.classList.remove("active"); });
}

export async function initDonationsAnalytics() {
  await wireDonationAnalyticsFilters();
  await runDonationAnalytics();
}
