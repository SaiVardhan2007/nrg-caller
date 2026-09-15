import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, debounce, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll, populateFilterSelect, exportTableToExcel, initMobileFilterDrawer } from "./utils.js";

/* ======================= EXPENSES (admin only) =======================
   Trip / Preaching / Residency Expenses are three independent flat ledgers
   (own Supabase table each — trip_expenses, preaching_expenses,
   residency_expenses) that are otherwise identical in shape: date /
   description / amount / place / added-by. createExpenseCategory() builds
   the full page (table, filters, mobile drawer, add modal, stats) once per
   config instead of tripling the same ~200 lines three times. */

function fmtMoney(n) {
  return "₹" + (Math.round((n || 0) * 100) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function wireExportBtn(btnId, tableId, filenamePrefix) {
  document.getElementById(btnId)?.addEventListener("click", () => {
    exportTableToExcel(document.getElementById(tableId), `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
}

function distinctValues(rows, field) {
  return Array.from(new Set(rows.map((r) => r[field]).filter(Boolean))).sort();
}

function matchesSearch(row, term, fields) {
  if (!term) return true;
  return fields.some((f) => String(row[f] || "").toLowerCase().includes(term));
}

function matchesSelectFilters(row, filters) {
  for (const [selectId, field] of filters) {
    const val = document.getElementById(selectId)?.value ?? "__ALL__";
    if (val === "__ALL__") continue;
    const cellVal = row[field] || "";
    if (val === "" ? cellVal !== "" : cellVal !== val) return false;
  }
  return true;
}

function matchesNumberFilters(row, filters) {
  for (const [inputId, field] of filters) {
    const raw = document.getElementById(inputId)?.value ?? "";
    if (raw === "") continue;
    const num = parseFloat(raw);
    if (Number.isNaN(num)) continue;
    if (Number(row[field] ?? NaN) !== num) return false;
  }
  return true;
}

function sortRows(rows, sortVal, defaultVal) {
  const [field, dir] = (sortVal || defaultVal).split("-");
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

function pairFilterControls(idA, idB, onChange) {
  const elA = document.getElementById(idA);
  const elB = document.getElementById(idB);
  if (!elA || !elB) return;
  const wire = (src, dst) => {
    if (src.tagName === "SELECT") {
      src.addEventListener("change", () => { dst.value = src.value; onChange(); });
    } else {
      src.addEventListener("input", debounce(() => { dst.value = src.value; onChange(); }, 200));
    }
  };
  wire(elA, elB);
  wire(elB, elA);
}

function populatePairedSelect(idA, idB, values) {
  populateFilterSelect(document.getElementById(idA), values);
  populateFilterSelect(document.getElementById(idB), values);
}

// Click-to-edit for table cells: an <input class="inline-edit"> sits directly
// in the cell (borderless until hover/focus, see .inline-edit in theme.css)
// instead of a separate Edit button + modal. Saves straight to Supabase on
// change/blur — same pattern as book_expenses in bookDistribution.js.
function wireInlineEditCells(tbody, tableName, cache, { numberFields = [], requiredFields = [] } = {}, afterSave) {
  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const field = e.target.dataset.field;
      const record = cache.find((x) => x.id === id);
      const raw = e.target.value.trim();

      if (requiredFields.includes(field) && !raw) {
        showToast(`${field.replace(/_/g, " ")} cannot be empty.`, "error");
        e.target.value = record[field] ?? "";
        return;
      }

      const value = numberFields.includes(field) ? (raw === "" ? null : Number(raw)) : (raw || null);
      const { error } = await supabase.from(tableName).update({ [field]: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.value = record[field] ?? "";
        return;
      }
      record[field] = value;
      if (afterSave) await afterSave();
    });
  });
}

function createExpenseCategory({ table, prefix, sectionId, tableId, tbodyId, modalId, columnsKey, addLabel, budgetCategory, budgetModalId, budgetHistoryModalId }) {
  const DEFAULT_COLUMNS = ["S.No", "Date", "Description", "Amount", "Place", "Added By", ""];
  const SELECT_FILTERS = [[`${prefix}-filter-place`, "place"]];
  const NUMBER_FILTERS = [[`${prefix}-th-filter-amount`, "amount"]];

  let cache = [];
  let budget = 0;
  let budgetCache = [];
  let filtersWired = false;
  let modalWired = false;

  function renderRows(rows, emptyMessage) {
    const tbody = document.getElementById(tbodyId);
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted-text">${emptyMessage}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r, idx) => `
      <tr data-id="${r.id}">
        <td data-label="S.No">${idx + 1}</td>
        <td data-label="Date"><input class="inline-edit" type="date" data-field="expense_date" value="${r.expense_date || ""}" /></td>
        <td data-label="Description"><input class="inline-edit" data-field="description" value="${escapeHtml(r.description || "")}" /></td>
        <td data-label="Amount"><input class="inline-edit" type="number" min="0" step="0.01" data-field="amount" value="${r.amount ?? ""}" /></td>
        <td data-label="Place"><input class="inline-edit" data-field="place" value="${escapeHtml(r.place || "")}" /></td>
        <td data-label="Added By"><input class="inline-edit" data-field="added_by" value="${escapeHtml(r.added_by || "")}" /></td>
        <td data-label="">
          <button type="button" class="cell-chip danger expense-delete-btn" title="Delete">🗑 Delete</button>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll(".expense-delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteRow(btn.closest("tr").dataset.id));
    });
    wireInlineEditCells(tbody, table, cache, { numberFields: ["amount"], requiredFields: ["description", "expense_date", "amount"] }, () => { applyFilters(); updateStats(); });
    reapplyColumnOrder(tableId);
  }

  function applyFilters() {
    const search = document.getElementById(`${prefix}-search`)?.value.trim().toLowerCase() || "";
    let rows = cache.filter((r) =>
      matchesSearch(r, search, ["description", "place"]) &&
      matchesSelectFilters(r, SELECT_FILTERS) &&
      matchesNumberFilters(r, NUMBER_FILTERS)
    );
    rows = sortRows(rows, document.getElementById(`${prefix}-sort`)?.value, "expense_date-desc");
    renderRows(rows, cache.length ? "No expenses match your filters." : "No expenses yet — add one to get started.");
  }

  function wireFilters() {
    if (filtersWired) return;
    filtersWired = true;
    document.getElementById(`${prefix}-search`).addEventListener("input", debounce(applyFilters, 200));
    document.getElementById(`${prefix}-sort`).addEventListener("change", applyFilters);
    pairFilterControls(`${prefix}-filter-place`, `${prefix}-th-filter-place`, applyFilters);
    document.getElementById(`${prefix}-th-filter-amount`)?.addEventListener("input", debounce(applyFilters, 200));
    wireExportBtn(`${prefix}-export-btn`, tableId, table);
    initColumnDragReorder(tableId, { storageKey: columnsKey, columns: DEFAULT_COLUMNS, resetBtnId: `${prefix}-reset-columns-btn` });
    initHorizontalScroll(`${tableId}-wrap`);
    initMobileFilterDrawer(sectionId);

    // Mobile: tapping a row (not one of its inline-edit fields/buttons)
    // expands it in place to reveal Place/Added By/Delete — same tap-to-expand
    // rules as every other admin table (see theme.css).
    document.getElementById(tbodyId).addEventListener("click", (e) => {
      if (window.innerWidth > 640) return;
      if (e.target.closest("input, button")) return;
      const row = e.target.closest("tr[data-id]");
      if (row) row.classList.toggle("expanded");
    });
  }

  async function deleteRow(id) {
    const r = cache.find((x) => x.id === id);
    if (!confirm(`Delete expense "${r?.description || ""}"?`)) return;
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) {
      showToast("Delete failed: " + error.message, "error");
      return;
    }
    showToast("Expense deleted", "success");
    await load();
  }

  function openModal() {
    document.getElementById(`${prefix}-date`).value = new Date().toISOString().slice(0, 10);
    document.getElementById(`${prefix}-description`).value = "";
    document.getElementById(`${prefix}-amount`).value = "";
    document.getElementById(`${prefix}-place`).value = "";
    document.getElementById(`${prefix}-error`).classList.add("hidden");
    document.getElementById(modalId).classList.add("active");
  }

  function wireModal(currentUser) {
    if (modalWired) return;
    modalWired = true;
    const modal = document.getElementById(modalId);
    const errorEl = document.getElementById(`${prefix}-error`);

    document.getElementById(`add-${prefix}-expense-btn`).onclick = () => openModal();
    document.getElementById(`${prefix}-cancel-btn`).onclick = () => modal.classList.remove("active");
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

    document.getElementById(`${prefix}-save-btn`).onclick = async () => {
      const date = document.getElementById(`${prefix}-date`).value;
      const description = document.getElementById(`${prefix}-description`).value.trim();
      const amount = document.getElementById(`${prefix}-amount`).value;
      const place = document.getElementById(`${prefix}-place`).value.trim();

      if (!date) {
        errorEl.textContent = "Please choose a date.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!description) {
        errorEl.textContent = "Please enter what this expense was for.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!amount || Number(amount) <= 0) {
        errorEl.textContent = "Please enter an amount greater than 0.";
        errorEl.classList.remove("hidden");
        return;
      }

      const payload = {
        expense_date: date,
        description,
        amount: Number(amount),
        place: place || null,
        added_by: currentUser?.user_name || null,
      };
      const { error } = await supabase.from(table).insert(payload);

      if (error) {
        errorEl.textContent = error.message;
        errorEl.classList.remove("hidden");
        return;
      }
      modal.classList.remove("active");
      showToast(`${addLabel} added`, "success");
      await load();
    };
  }

  function wireBudgetModal(currentUser) {
    const modal = document.getElementById(budgetModalId);
    const errorEl = document.getElementById(`${prefix}-budget-error`);
    const dateInput = document.getElementById(`${prefix}-budget-date`);
    const descInput = document.getElementById(`${prefix}-budget-description`);
    const amountInput = document.getElementById(`${prefix}-budget-amount`);

    document.getElementById(`add-${prefix}-budget-btn`).onclick = () => {
      dateInput.value = new Date().toISOString().slice(0, 10);
      descInput.value = "";
      amountInput.value = "";
      errorEl.classList.add("hidden");
      modal.classList.add("active");
    };
    document.getElementById(`${prefix}-budget-cancel-btn`).onclick = () => modal.classList.remove("active");
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

    document.getElementById(`${prefix}-budget-save-btn`).onclick = async () => {
      const date = dateInput.value;
      const description = descInput.value.trim();
      const amount = Number(amountInput.value);

      if (!date) {
        errorEl.textContent = "Please choose a date.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!description) {
        errorEl.textContent = "Please enter what this budget is for.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!amountInput.value || amount <= 0) {
        errorEl.textContent = "Please enter an amount greater than 0.";
        errorEl.classList.remove("hidden");
        return;
      }

      const payload = {
        category: budgetCategory,
        transaction_date: date,
        description,
        amount,
        added_by: currentUser?.user_name || null,
      };
      const { error } = await supabase.from("budget_transactions").insert(payload);

      if (error) {
        errorEl.textContent = error.message;
        errorEl.classList.remove("hidden");
        return;
      }
      modal.classList.remove("active");
      showToast("Budget added", "success");
      await loadBudget();
      updateStats();
      renderBudgetHistoryRows();
    };
  }

  function renderBudgetHistoryRows() {
    const tbody = document.getElementById(`${prefix}-budget-history-body`);
    if (!tbody) return;
    if (!budgetCache.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted-text">No budget added yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = budgetCache.map((r, idx) => `
      <tr data-id="${r.id}">
        <td data-label="S.No">${idx + 1}</td>
        <td data-label="Date">${r.transaction_date || ""}</td>
        <td data-label="Description">${escapeHtml(r.description || "")}</td>
        <td data-label="Amount">${fmtMoney(r.amount)}</td>
        <td data-label="Added By">${escapeHtml(r.added_by || "")}</td>
        <td data-label="">
          <button type="button" class="cell-chip danger budget-delete-btn" title="Delete">🗑 Delete</button>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll(".budget-delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteBudgetRow(btn.closest("tr").dataset.id));
    });
  }

  async function deleteBudgetRow(id) {
    const r = budgetCache.find((x) => x.id === id);
    if (!confirm(`Delete budget entry "${r?.description || ""}"?`)) return;
    const { error } = await supabase.from("budget_transactions").delete().eq("id", id);
    if (error) {
      showToast("Delete failed: " + error.message, "error");
      return;
    }
    showToast("Budget entry deleted", "success");
    await loadBudget();
    updateStats();
    renderBudgetHistoryRows();
  }

  function wireBudgetHistoryModal() {
    const modal = document.getElementById(budgetHistoryModalId);
    document.getElementById(`${prefix}-budget-history-close-btn`).onclick = () => modal.classList.remove("active");
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
    document.getElementById(`${prefix}-stat-budget-box`).onclick = () => {
      modal.classList.add("active");
      renderBudgetHistoryRows();
    };
  }

  function updateStats() {
    const totalExpenses = cache.reduce((s, r) => s + (r.amount || 0), 0);
    document.getElementById(`${prefix}-stat-budget`).textContent = fmtMoney(budget);
    document.getElementById(`${prefix}-stat-expenses`).textContent = fmtMoney(totalExpenses);
    document.getElementById(`${prefix}-stat-available`).textContent = fmtMoney(budget - totalExpenses);
  }

  async function loadBudget() {
    const { data } = await supabase
      .from("budget_transactions")
      .select("id,transaction_date,description,amount,added_by")
      .eq("category", budgetCategory)
      .order("transaction_date", { ascending: false })
      .order("created_at", { ascending: false });
    budgetCache = data || [];
    budget = budgetCache.reduce((s, r) => s + (r.amount || 0), 0);
  }

  async function load() {
    const tbody = document.getElementById(tbodyId);
    tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Loading…</td></tr>`;

    const [{ data, error }] = await Promise.all([
      supabase
        .from(table)
        .select("id,expense_date,description,amount,place,added_by")
        .order("expense_date", { ascending: false })
        .order("created_at", { ascending: false }),
      loadBudget(),
    ]);

    if (error) {
      tbody.innerHTML = `<tr><td colspan="7" class="loading-row">Could not load expenses.</td></tr>`;
      return;
    }
    cache = data || [];
    populatePairedSelect(`${prefix}-filter-place`, `${prefix}-th-filter-place`, distinctValues(cache, "place"));
    applyFilters();
    updateStats();
  }

  return {
    init: async (currentUser) => {
      wireModal(currentUser);
      wireBudgetModal(currentUser);
      wireBudgetHistoryModal();
      wireFilters();
      await load();
    },
  };
}

const tripCategory = createExpenseCategory({
  table: "trip_expenses",
  prefix: "et",
  sectionId: "expenses-trip-section",
  tableId: "expenses-trip-table",
  tbodyId: "expenses-trip-body",
  modalId: "expense-trip-modal",
  columnsKey: "nrg-trip-expenses-column-order",
  addLabel: "Trip expense",
  budgetCategory: "trip",
  budgetModalId: "expense-trip-budget-modal",
  budgetHistoryModalId: "expense-trip-budget-history-modal",
});

const preachingCategory = createExpenseCategory({
  table: "preaching_expenses",
  prefix: "ep",
  sectionId: "expenses-preaching-section",
  tableId: "expenses-preaching-table",
  tbodyId: "expenses-preaching-body",
  modalId: "expense-preaching-modal",
  columnsKey: "nrg-preaching-expenses-column-order",
  addLabel: "Preaching expense",
  budgetCategory: "preaching",
  budgetModalId: "expense-preaching-budget-modal",
  budgetHistoryModalId: "expense-preaching-budget-history-modal",
});

const residencyCategory = createExpenseCategory({
  table: "residency_expenses",
  prefix: "er",
  sectionId: "expenses-residency-section",
  tableId: "expenses-residency-table",
  tbodyId: "expenses-residency-body",
  modalId: "expense-residency-modal",
  columnsKey: "nrg-residency-expenses-column-order",
  addLabel: "Residency expense",
  budgetCategory: "residency",
  budgetModalId: "expense-residency-budget-modal",
  budgetHistoryModalId: "expense-residency-budget-history-modal",
});

export const initExpensesTrip = (currentUser) => tripCategory.init(currentUser);
export const initExpensesPreaching = (currentUser) => preachingCategory.init(currentUser);
export const initExpensesResidency = (currentUser) => residencyCategory.init(currentUser);
