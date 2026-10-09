import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, debounce, initColumnDragReorder, reapplyColumnOrder, initHorizontalScroll } from "./utils.js";
import { todayLocalDate } from "./sadhana.js";

const COMPLETION_OPTIONS = [
  ["not_started", "Not Started"],
  ["partially_completed", "In Progress"],
  ["completed", "Completed"],
];
const RECOMMEND_LEVELS = [0, 1, 2, 3];

const DAILY_COLUMNS_KEY = "nrg-col-order:sbc-daily-table";
const DEFAULT_DAILY_COLUMNS = ["S.No", "Date", "Title", "Link", "Playlist", "Recommend Level", "Completion Status", ""];
const REC_HISTORY_COLUMNS_KEY = "nrg-col-order:sbc-rec-history-table";
const DEFAULT_REC_HISTORY_COLUMNS = ["S.No", "Class Date", "Title", "Link", "Playlist", "Completion Status", "Recommended To", "Recommended By", "Recommended At", ""];
const DOUBTS_COLUMNS_KEY = "nrg-col-order:sbc-doubts-table";
const DEFAULT_DOUBTS_COLUMNS = ["S.No", "Asked At", "Class", "Link", "Timing", "Doubt", "Asked By", "Resolved", ""];

let sbcCurrentUser = null;
let sbcWired = false;
let sbcPlaylists = [];
let sbcVideos = [];
let sbcUsers = [];
let sbcRecommendations = [];
// Holds the in-progress Add Class form's url/title while the user detours
// through "+ New Playlist" mid-add, so re-opening the class modal afterwards
// doesn't lose what they'd already typed.
let sbcClassDraft = null;

function completionLabel(value) {
  return COMPLETION_OPTIONS.find(([v]) => v === value)?.[1] || value;
}

function sbcCompletionOptionsHtml(current) {
  return COMPLETION_OPTIONS.map(([v, label]) => `<option value="${v}" ${v === current ? "selected" : ""}>${label}</option>`).join("");
}

function sbcRecommendOptionsHtml(current) {
  return RECOMMEND_LEVELS.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${v}</option>`).join("");
}

function sbcPlaylistOptionsHtml(current) {
  return sbcPlaylists.map((p) => `<option value="${p.id}" ${p.id === current ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
}

// Only ever renders a real http(s) link — an unexpected value here falls
// back to "#" rather than letting a bad/empty youtube_url leak into an href.
function safeHref(url) {
  return /^https?:\/\//i.test(url || "") ? escapeHtml(url) : "#";
}

function sbcRowHtml(r, idx, {
  showDate = true, showPlaylist = true, showSno = true, showLink = true, showDelete = true,
} = {}) {
  return `
    <tr data-id="${r.id}">
      ${showSno ? `<td data-label="S.No">${idx + 1}</td>` : ""}
      ${showDate ? `<td data-label="Date"><input class="inline-edit" type="date" data-field="class_date" value="${r.class_date || ""}" /></td>` : ""}
      <td data-label="Title"><input class="inline-edit" type="text" data-field="title" value="${escapeHtml(r.title)}" /></td>
      ${showLink ? `<td data-label="Link"><a class="cell-chip" href="${safeHref(r.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a></td>` : ""}
      ${showPlaylist ? `<td data-label="Playlist"><select class="inline-edit" data-field="playlist_id">${sbcPlaylistOptionsHtml(r.playlist_id)}</select></td>` : ""}
      <td data-label="Recommend Level"><select class="inline-edit" data-field="recommend_level">${sbcRecommendOptionsHtml(r.recommend_level)}</select></td>
      <td data-label="Completion Status"><select class="inline-edit" data-field="completion_status">${sbcCompletionOptionsHtml(r.completion_status)}</select></td>
      ${showDelete ? `<td data-label=""><button type="button" class="cell-chip danger sbc-delete-btn" title="Delete">🗑 Delete</button></td>` : ""}
    </tr>`;
}

function wireSbcInlineEditCells(tbody, onChange) {
  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const field = e.target.dataset.field;
      const record = sbcVideos.find((x) => x.id === id);
      let value;
      if (field === "recommend_level") value = Number(e.target.value);
      else if (field === "class_date") value = e.target.value || null;
      else if (field === "title") {
        value = e.target.value.trim();
        if (!value) {
          showToast("Title cannot be empty.", "error");
          e.target.value = record.title;
          return;
        }
      } else {
        value = e.target.value; // playlist_id, completion_status
      }

      const { error } = await supabase.from("sb_class_videos").update({ [field]: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        return;
      }
      record[field] = value;
      if (field === "playlist_id") {
        record.playlist_name = sbcPlaylists.find((p) => p.id === value)?.name || "—";
      }
      onChange?.();
    });
  });
}

function wireSbcDeleteButtons(tbody) {
  tbody.querySelectorAll(".sbc-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSbcVideo(btn.closest("tr").dataset.id));
  });
}

async function deleteSbcVideo(id) {
  const r = sbcVideos.find((x) => x.id === id);
  if (!confirm(`Delete class "${r?.title || ""}"?`)) return;
  const { error } = await supabase.from("sb_class_videos").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  sbcVideos = sbcVideos.filter((x) => x.id !== id);
  showToast("Class deleted", "success");
  refreshSbcAfterVideoChange();
}

function renderSbcTableRows(tbodyId, rows, colCount, emptyMessage, opts, onChange) {
  const tbody = document.getElementById(tbodyId);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => sbcRowHtml(r, idx, opts)).join("");
  wireSbcInlineEditCells(tbody, onChange);
  wireSbcDeleteButtons(tbody);
}

function sortByDateDesc(rows) {
  return [...rows].sort((a, b) => (b.class_date || b.created_at || "").localeCompare(a.class_date || a.created_at || ""));
}

/* ======================= DASHBOARD ======================= */

function renderSbcDashboard() {
  const total = sbcVideos.length;
  const notStarted = sbcVideos.filter((v) => v.completion_status === "not_started").length;
  const partial = sbcVideos.filter((v) => v.completion_status === "partially_completed").length;
  const completed = sbcVideos.filter((v) => v.completion_status === "completed").length;

  document.getElementById("sbc-stat-total").textContent = total;
  document.getElementById("sbc-stat-playlists").textContent = sbcPlaylists.length;
  document.getElementById("sbc-stat-not-started").textContent = notStarted;
  document.getElementById("sbc-stat-partial").textContent = partial;
  document.getElementById("sbc-stat-completed").textContent = completed;

  const recent = [...sbcVideos].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 5);
  renderSbcTableRows("sbc-recent-body", recent, 5, "No classes yet.",
    { showSno: false, showLink: false, showDelete: false, showDate: true, showPlaylist: true },
    () => renderSbcDashboard());
}

/* ======================= DAILY CLASS LIST ======================= */

function applyDailyFilters() {
  const term = document.getElementById("sbc-daily-search").value.trim().toLowerCase();
  const playlistFilter = document.getElementById("sbc-daily-filter-playlist").value;
  const completionFilter = document.getElementById("sbc-daily-filter-completion").value;

  let rows = sbcVideos.filter((r) => !term || String(r.title || "").toLowerCase().includes(term));
  if (playlistFilter !== "__ALL__") rows = rows.filter((r) => r.playlist_id === playlistFilter);
  if (completionFilter !== "__ALL__") rows = rows.filter((r) => r.completion_status === completionFilter);

  renderSbcTableRows("sbc-daily-body", sortByDateDesc(rows), 8,
    sbcVideos.length ? "No classes match your filters." : "No classes yet — add one to get started.",
    { showDate: true, showPlaylist: true });
  reapplyColumnOrder("sbc-daily-table");
}

function wireSbcDailyPanel() {
  document.getElementById("sbc-daily-search").addEventListener("input", debounce(applyDailyFilters, 200));
  document.getElementById("sbc-daily-filter-playlist").addEventListener("change", applyDailyFilters);
  document.getElementById("sbc-daily-filter-completion").addEventListener("change", applyDailyFilters);
  document.getElementById("sbc-add-class-btn").addEventListener("click", () => openSbcClassModal());
  initColumnDragReorder("sbc-daily-table", { storageKey: DAILY_COLUMNS_KEY, columns: DEFAULT_DAILY_COLUMNS, resetBtnId: "sbc-daily-reset-columns-btn" });
  initHorizontalScroll("sbc-daily-table-wrap");
}

/* ======================= PLAYLISTS ======================= */

let sbcActivePlaylistId = null;

function renderPlaylistsGrid() {
  const grid = document.getElementById("sbc-playlists-grid");
  if (!sbcPlaylists.length) {
    grid.innerHTML = `<p class="muted-text">No playlists yet — add one to get started.</p>`;
    return;
  }
  grid.innerHTML = sbcPlaylists.map((p) => {
    const count = sbcVideos.filter((v) => v.playlist_id === p.id).length;
    return `
      <div class="trip-event-card sbc-playlist-card" data-id="${p.id}">
        <div class="trip-event-card-header">
          <p class="trip-event-card-name">${escapeHtml(p.name)}</p>
          <button type="button" class="cell-chip danger sbc-playlist-delete-btn" title="Delete playlist">🗑</button>
        </div>
        <p class="sbc-playlist-card-count">${count} class${count === 1 ? "" : "es"}</p>
      </div>`;
  }).join("");

  grid.querySelectorAll(".sbc-playlist-card").forEach((card) => {
    card.addEventListener("click", () => openSbcPlaylistDetail(card.dataset.id));
  });
  grid.querySelectorAll(".sbc-playlist-delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSbcPlaylist(btn.closest(".sbc-playlist-card").dataset.id);
    });
  });
}

async function deleteSbcPlaylist(id) {
  const p = sbcPlaylists.find((x) => x.id === id);
  const count = sbcVideos.filter((v) => v.playlist_id === id).length;
  const warning = count ? ` This will also delete its ${count} class(es).` : "";
  if (!confirm(`Delete playlist "${p?.name || ""}"?${warning}`)) return;

  const { error } = await supabase.from("sb_class_playlists").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  sbcPlaylists = sbcPlaylists.filter((x) => x.id !== id);
  sbcVideos = sbcVideos.filter((v) => v.playlist_id !== id);
  showToast("Playlist deleted", "success");
  populatePlaylistSelects();
  renderPlaylistsGrid();
}

function closeAllSbcVideoMenus() {
  document.querySelectorAll(".sbc-video-menu").forEach((m) => m.classList.add("hidden"));
}

function sbcVideoCardHtml(v) {
  return `
    <div class="sbc-video-card" data-id="${v.id}">
      <div class="sbc-video-card-main">
        <div class="sbc-video-card-title">${escapeHtml(v.title)}</div>
        <div class="sbc-video-card-meta">
          <span>${v.class_date || "—"}</span>
          <span class="sbc-badge ${v.completion_status}">${completionLabel(v.completion_status)}</span>
          <span class="sbc-badge">Rec Lvl ${v.recommend_level}</span>
        </div>
      </div>
      <div class="sbc-video-card-actions">
        <a class="cell-chip" href="${safeHref(v.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a>
        <div class="sbc-video-menu-wrap">
          <button type="button" class="sbc-video-menu-btn" title="Options">⋮</button>
          <div class="sbc-video-menu hidden">
            <button type="button" class="sbc-video-menu-item" data-action="recommend">⭐ Recommend</button>
            <button type="button" class="sbc-video-menu-item" data-action="edit">✏️ Edit</button>
            <button type="button" class="sbc-video-menu-item danger" data-action="delete">🗑 Delete</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderPlaylistVideosList(playlistId) {
  const wrap = document.getElementById("sbc-playlist-videos-list");
  const rows = sortByDateDesc(sbcVideos.filter((v) => v.playlist_id === playlistId));
  if (!rows.length) {
    wrap.innerHTML = `<p class="muted-text">No classes in this playlist yet.</p>`;
    return;
  }
  wrap.innerHTML = rows.map(sbcVideoCardHtml).join("");

  wrap.querySelectorAll(".sbc-video-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const wasHidden = menu.classList.contains("hidden");
      closeAllSbcVideoMenus();
      menu.classList.toggle("hidden", !wasHidden);
    });
  });

  wrap.querySelectorAll(".sbc-video-menu-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllSbcVideoMenus();
      const id = btn.closest(".sbc-video-card").dataset.id;
      const action = btn.dataset.action;
      if (action === "recommend") openSbcQuickRecommendModal(id);
      else if (action === "edit") openSbcClassModal(id);
      else if (action === "delete") deleteSbcVideo(id);
    });
  });
}

function openSbcPlaylistDetail(playlistId) {
  const p = sbcPlaylists.find((x) => x.id === playlistId);
  if (!p) return;
  sbcActivePlaylistId = playlistId;
  document.getElementById("sbc-playlists-grid-view").classList.add("hidden");
  document.getElementById("sbc-playlist-detail-view").classList.remove("hidden");
  document.getElementById("sbc-playlist-detail-title").textContent = p.name;
  renderPlaylistVideosList(playlistId);
}

function showSbcPlaylistsGrid() {
  sbcActivePlaylistId = null;
  document.getElementById("sbc-playlist-detail-view").classList.add("hidden");
  document.getElementById("sbc-playlists-grid-view").classList.remove("hidden");
  renderPlaylistsGrid();
}

// Called after an add/edit/delete/toggle on a video — stays in the playlist
// detail view if that's where the action came from, instead of bouncing back
// to the grid or another tab.
function refreshSbcAfterVideoChange() {
  if (sbcActivePlaylistId && sbcPlaylists.some((p) => p.id === sbcActivePlaylistId)) {
    document.getElementById("sbc-playlist-detail-title").textContent =
      sbcPlaylists.find((p) => p.id === sbcActivePlaylistId)?.name || "";
    renderPlaylistVideosList(sbcActivePlaylistId);
  } else {
    sbcSwitchPanel(sbcActiveTarget());
  }
}

async function renameSbcActivePlaylist() {
  const p = sbcPlaylists.find((x) => x.id === sbcActivePlaylistId);
  if (!p) return;
  const name = prompt("Rename playlist", p.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    showToast("Playlist name cannot be empty.", "error");
    return;
  }
  const { error } = await supabase.from("sb_class_playlists").update({ name: trimmed }).eq("id", p.id);
  if (error) {
    showToast("Update failed: " + error.message, "error");
    return;
  }
  p.name = trimmed;
  sbcVideos.filter((v) => v.playlist_id === p.id).forEach((v) => { v.playlist_name = trimmed; });
  document.getElementById("sbc-playlist-detail-title").textContent = trimmed;
  populatePlaylistSelects();
  showToast("Playlist renamed", "success");
}

function wireSbcPlaylistsPanel() {
  document.getElementById("sbc-add-playlist-btn").addEventListener("click", () => openSbcPlaylistModal());
  document.getElementById("sbc-playlist-back-btn").addEventListener("click", showSbcPlaylistsGrid);
  document.getElementById("sbc-playlist-rename-btn").addEventListener("click", renameSbcActivePlaylist);
  document.getElementById("sbc-playlist-add-video-btn").addEventListener("click", () => openSbcClassModal(null, sbcActivePlaylistId));
  document.addEventListener("click", closeAllSbcVideoMenus);
}

/* ======================= RECOMMENDATIONS (admin: recommend a class to users) =======================
   Admin picks one class and one or more users from the roster, then
   "Recommend to Selected" inserts one sb_class_recommendations row per
   selected user. There's no uniqueness constraint — the same class can be
   recommended again later (to the same or different users), which just adds
   another history row. */

function mapRecommendationRow(r) {
  return {
    id: r.id,
    video_id: r.video_id,
    user_id: r.user_id,
    recommended_by: r.recommended_by,
    recommended_at: r.recommended_at,
    title: r.sb_class_videos?.title || "—",
    youtube_url: r.sb_class_videos?.youtube_url || "",
    class_date: r.sb_class_videos?.class_date || null,
    playlist_id: r.sb_class_videos?.playlist_id || null,
    playlist_name: r.sb_class_videos?.sb_class_playlists?.name || "—",
    completion_status: r.sb_class_videos?.completion_status || "not_started",
    user_name: r.users?.user_name || "—",
  };
}

async function reloadSbcRecommendations() {
  const { data, error } = await supabase
    .from("sb_class_recommendations")
    .select("id,video_id,user_id,recommended_by,recommended_at,sb_class_videos(title,youtube_url,class_date,playlist_id,completion_status,sb_class_playlists(name)),users(user_name)")
    .order("recommended_at", { ascending: false });
  if (error) {
    showToast("Could not refresh recommendation history.", "error");
    return;
  }
  sbcRecommendations = (data || []).map(mapRecommendationRow);
}

function sbcRecClassOptionsHtml() {
  return sortByDateDesc(sbcVideos).map((v) => `<option value="${v.id}">${escapeHtml(v.title)} — ${escapeHtml(v.playlist_name || "—")}</option>`).join("");
}

function populateSbcRecClassSelect() {
  const sel = document.getElementById("sbc-rec-class-select");
  const prev = sel.value;
  sel.innerHTML = sbcVideos.length ? sbcRecClassOptionsHtml() : `<option value="">No classes yet</option>`;
  if (sbcVideos.some((v) => v.id === prev)) sel.value = prev;
}

function renderSbcRecUserList() {
  const list = document.getElementById("sbc-rec-user-list");
  list.innerHTML = sbcUsers.length
    ? sbcUsers.map((u) => `<label class="tag-check" data-name="${escapeHtml((u.user_name || "").toLowerCase())}"><input type="checkbox" class="sbc-rec-user-cb" value="${u.id}" /> ${escapeHtml(u.user_name)}</label>`).join("")
    : `<span class="muted-text">No coordinators found.</span>`;
  document.getElementById("sbc-rec-select-all").checked = false;
}

function applySbcRecUserSearch() {
  const term = document.getElementById("sbc-rec-user-search").value.trim().toLowerCase();
  document.querySelectorAll("#sbc-rec-user-list label.tag-check").forEach((label) => {
    label.classList.toggle("hidden", !!term && !label.dataset.name.includes(term));
  });
}

function openSbcRecommendModal() {
  populateSbcRecClassSelect();
  document.getElementById("sbc-rec-user-search").value = "";
  renderSbcRecUserList();
  applySbcRecUserSearch();
  document.getElementById("sbc-rec-error").classList.add("hidden");
  document.getElementById("sbc-recommend-modal").classList.add("active");
}

async function recommendClassToSelectedUsers() {
  const errorEl = document.getElementById("sbc-rec-error");
  errorEl.classList.add("hidden");
  const videoId = document.getElementById("sbc-rec-class-select").value;
  const userIds = Array.from(document.querySelectorAll("#sbc-rec-user-list .sbc-rec-user-cb:checked")).map((cb) => cb.value);

  if (!videoId) {
    errorEl.textContent = "Please choose a class.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (!userIds.length) {
    errorEl.textContent = "Please select at least one user.";
    errorEl.classList.remove("hidden");
    return;
  }

  const payload = userIds.map((user_id) => ({ video_id: videoId, user_id, recommended_by: sbcCurrentUser?.user_name || null }));
  const { error } = await supabase.from("sb_class_recommendations").insert(payload);
  if (error) {
    errorEl.textContent = error.message;
    errorEl.classList.remove("hidden");
    return;
  }

  document.getElementById("sbc-recommend-modal").classList.remove("active");
  showToast(`Recommended to ${userIds.length} coordinator(s)`, "success");
  await reloadSbcRecommendations();
  renderSbcRecHistoryTable();
  applySbcRecHistorySearch();
}

function sbcUserOptionsHtml(current) {
  return sbcUsers.map((u) => `<option value="${u.id}" ${u.id === current ? "selected" : ""}>${escapeHtml(u.user_name)}</option>`).join("");
}

// Formats an ISO timestamp for a <input type="datetime-local"> value, in the
// viewer's local time (matching how it's displayed elsewhere in this table).
function toDatetimeLocalValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSbcRecHistoryTable() {
  const tbody = document.getElementById("sbc-rec-history-body");
  if (!sbcRecommendations.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="muted-text">No recommendations yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = sbcRecommendations.map((r, idx) => `
    <tr data-id="${r.id}" data-search="${escapeHtml((r.title + " " + r.user_name).toLowerCase())}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Class Date"><input class="inline-edit" type="date" data-field="class_date" value="${r.class_date || ""}" /></td>
      <td data-label="Title"><input class="inline-edit" type="text" data-field="title" value="${escapeHtml(r.title)}" /></td>
      <td data-label="Link"><a class="cell-chip" href="${safeHref(r.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a></td>
      <td data-label="Playlist"><select class="inline-edit" data-field="playlist_id">${sbcPlaylistOptionsHtml(r.playlist_id)}</select></td>
      <td data-label="Completion Status"><select class="inline-edit" data-field="completion_status">${sbcCompletionOptionsHtml(r.completion_status)}</select></td>
      <td data-label="Recommended To"><select class="inline-edit" data-field="user_id">${sbcUserOptionsHtml(r.user_id)}</select></td>
      <td data-label="Recommended By"><input class="inline-edit" type="text" data-field="recommended_by" value="${escapeHtml(r.recommended_by || "")}" /></td>
      <td data-label="Recommended At"><input class="inline-edit" type="datetime-local" data-field="recommended_at" value="${toDatetimeLocalValue(r.recommended_at)}" /></td>
      <td data-label=""><button type="button" class="cell-chip danger sbc-rec-delete-btn" title="Remove">🗑 Remove</button></td>
    </tr>`).join("");

  tbody.querySelectorAll(".sbc-rec-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSbcRecommendation(btn.closest("tr").dataset.id));
  });
  wireSbcRecHistoryInlineEdits(tbody);
  reapplyColumnOrder("sbc-rec-history-table");
}

// Class Date/Title/Playlist live on the recommended video (sb_class_videos)
// and are shared by every recommendation of that class; User/Recommended
// By/At live on this recommendation row itself (sb_class_recommendations).
async function updateSbcRecHistoryField(tr, field, rawValue) {
  const id = tr.dataset.id;
  const record = sbcRecommendations.find((r) => r.id === id);
  if (!record) return;

  if (field === "class_date" || field === "playlist_id" || field === "completion_status") {
    const value = field === "class_date" ? (rawValue || null) : rawValue;
    const { error } = await supabase.from("sb_class_videos").update({ [field]: value }).eq("id", record.video_id);
    if (error) return showToast("Update failed: " + error.message, "error");
    const playlistName = field === "playlist_id" ? (sbcPlaylists.find((p) => p.id === value)?.name || "—") : null;
    [sbcRecommendations, sbcVideos].forEach((list) => {
      list.filter((x) => (x.video_id || x.id) === record.video_id).forEach((x) => {
        x[field] = value;
        if (field === "playlist_id") x.playlist_name = playlistName;
      });
    });
  } else if (field === "title") {
    const value = rawValue.trim();
    if (!value) return showToast("Title cannot be empty.", "error");
    const { error } = await supabase.from("sb_class_videos").update({ title: value }).eq("id", record.video_id);
    if (error) return showToast("Update failed: " + error.message, "error");
    [sbcRecommendations, sbcVideos].forEach((list) => {
      list.filter((x) => (x.video_id || x.id) === record.video_id).forEach((x) => { x.title = value; });
    });
  } else if (field === "user_id") {
    const { error } = await supabase.from("sb_class_recommendations").update({ user_id: rawValue }).eq("id", id);
    if (error) return showToast("Update failed: " + error.message, "error");
    record.user_id = rawValue;
    record.user_name = sbcUsers.find((u) => u.id === rawValue)?.user_name || "—";
  } else if (field === "recommended_by") {
    const value = rawValue.trim() || null;
    const { error } = await supabase.from("sb_class_recommendations").update({ recommended_by: value }).eq("id", id);
    if (error) return showToast("Update failed: " + error.message, "error");
    record.recommended_by = value;
  } else if (field === "recommended_at") {
    const iso = rawValue ? new Date(rawValue).toISOString() : null;
    const { error } = await supabase.from("sb_class_recommendations").update({ recommended_at: iso }).eq("id", id);
    if (error) return showToast("Update failed: " + error.message, "error");
    record.recommended_at = iso;
  }

  renderSbcRecHistoryTable();
  applySbcRecHistorySearch();
}

function wireSbcRecHistoryInlineEdits(tbody) {
  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", (e) => {
      updateSbcRecHistoryField(e.target.closest("tr"), e.target.dataset.field, e.target.value);
    });
  });
}

function applySbcRecHistorySearch() {
  const term = document.getElementById("sbc-rec-history-search").value.trim().toLowerCase();
  document.querySelectorAll("#sbc-rec-history-body tr[data-id]").forEach((row) => {
    row.classList.toggle("hidden", !!term && !row.dataset.search.includes(term));
  });
}

async function deleteSbcRecommendation(id) {
  if (!confirm("Remove this recommendation?")) return;
  const { error } = await supabase.from("sb_class_recommendations").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  sbcRecommendations = sbcRecommendations.filter((r) => r.id !== id);
  showToast("Recommendation removed", "success");
  renderSbcRecHistoryTable();
  applySbcRecHistorySearch();
}

function wireSbcRecommendPanel() {
  const modal = document.getElementById("sbc-recommend-modal");
  document.getElementById("sbc-rec-open-modal-btn").addEventListener("click", openSbcRecommendModal);
  document.getElementById("sbc-rec-cancel-btn").addEventListener("click", () => modal.classList.remove("active"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
  document.getElementById("sbc-rec-user-search").addEventListener("input", debounce(applySbcRecUserSearch, 150));
  document.getElementById("sbc-rec-history-search").addEventListener("input", debounce(applySbcRecHistorySearch, 150));
  document.getElementById("sbc-rec-recommend-btn").addEventListener("click", recommendClassToSelectedUsers);
  document.getElementById("sbc-rec-select-all").addEventListener("change", (e) => {
    document.querySelectorAll("#sbc-rec-user-list .sbc-rec-user-cb").forEach((cb) => {
      if (!cb.closest("label").classList.contains("hidden")) cb.checked = e.target.checked;
    });
  });
  initColumnDragReorder("sbc-rec-history-table", { storageKey: REC_HISTORY_COLUMNS_KEY, columns: DEFAULT_REC_HISTORY_COLUMNS, resetBtnId: "sbc-rec-reset-columns-btn" });
  initHorizontalScroll("sbc-rec-history-table-wrap");
}

/* ======================= DOUBTS (admin: view doubts users asked on classes) ======================= */

let sbcDoubts = [];

function mapDoubtRow(r) {
  return {
    id: r.id,
    video_id: r.video_id,
    user_id: r.user_id,
    timestamp_label: r.timestamp_label,
    doubt_text: r.doubt_text,
    resolved: r.resolved,
    created_at: r.created_at,
    title: r.sb_class_videos?.title || "—",
    youtube_url: r.sb_class_videos?.youtube_url || "",
    user_name: r.users?.user_name || "—",
  };
}

function renderSbcDoubtsTable() {
  const term = document.getElementById("sbc-doubts-search").value.trim().toLowerCase();
  const statusFilter = document.getElementById("sbc-doubts-filter-status").value;

  let rows = sbcDoubts;
  if (statusFilter === "pending") rows = rows.filter((d) => !d.resolved);
  else if (statusFilter === "resolved") rows = rows.filter((d) => d.resolved);
  if (term) rows = rows.filter((d) => `${d.title} ${d.user_name} ${d.doubt_text}`.toLowerCase().includes(term));

  const tbody = document.getElementById("sbc-doubts-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted-text">${sbcDoubts.length ? "No doubts match your filters." : "No doubts asked yet."}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((d, idx) => `
    <tr data-id="${d.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Asked At">${new Date(d.created_at).toLocaleString()}</td>
      <td data-label="Class">${escapeHtml(d.title)}</td>
      <td data-label="Link"><a class="cell-chip" href="${safeHref(d.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a></td>
      <td data-label="Timing">${escapeHtml(d.timestamp_label)}</td>
      <td data-label="Doubt">${escapeHtml(d.doubt_text)}</td>
      <td data-label="Asked By">${escapeHtml(d.user_name)}</td>
      <td data-label="Resolved"><input type="checkbox" class="inline-edit sbc-doubt-resolved-cb" ${d.resolved ? "checked" : ""} /></td>
      <td data-label=""><button type="button" class="cell-chip danger sbc-doubt-delete-btn" title="Delete">🗑 Delete</button></td>
    </tr>`).join("");

  tbody.querySelectorAll(".sbc-doubt-resolved-cb").forEach((cb) => {
    cb.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const record = sbcDoubts.find((d) => d.id === id);
      const value = e.target.checked;
      const { error } = await supabase.from("sb_class_doubts").update({ resolved: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.checked = !value;
        return;
      }
      if (record) record.resolved = value;
    });
  });
  tbody.querySelectorAll(".sbc-doubt-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSbcDoubt(btn.closest("tr").dataset.id));
  });
  reapplyColumnOrder("sbc-doubts-table");
}

async function deleteSbcDoubt(id) {
  if (!confirm("Delete this doubt?")) return;
  const { error } = await supabase.from("sb_class_doubts").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  sbcDoubts = sbcDoubts.filter((d) => d.id !== id);
  showToast("Doubt deleted", "success");
  renderSbcDoubtsTable();
}

function wireSbcDoubtsPanel() {
  document.getElementById("sbc-doubts-search").addEventListener("input", debounce(renderSbcDoubtsTable, 150));
  document.getElementById("sbc-doubts-filter-status").addEventListener("change", renderSbcDoubtsTable);
  initColumnDragReorder("sbc-doubts-table", { storageKey: DOUBTS_COLUMNS_KEY, columns: DEFAULT_DOUBTS_COLUMNS, resetBtnId: "sbc-doubts-reset-columns-btn" });
  initHorizontalScroll("sbc-doubts-table-wrap");
}

/* ======================= ADD CLASS / ADD PLAYLIST MODALS ======================= */

let sbcEditingVideoId = null;

function openSbcClassModal(editId = null, forcedPlaylistId = null) {
  if (!sbcPlaylists.length) {
    showToast("Please add a playlist first.", "error");
    openSbcPlaylistModal();
    return;
  }
  sbcEditingVideoId = editId;
  const record = editId ? sbcVideos.find((v) => v.id === editId) : null;
  document.getElementById("sbc-class-modal-title").textContent = record ? "Edit Class" : "Add Class";
  document.getElementById("sbc-class-url").value = record?.youtube_url || "";
  document.getElementById("sbc-class-title").value = record?.title || "";
  document.getElementById("sbc-class-playlist").innerHTML = sbcPlaylistOptionsHtml(record?.playlist_id || forcedPlaylistId || sbcPlaylists[0].id);
  document.getElementById("sbc-class-date").value = record?.class_date || todayLocalDate();
  document.getElementById("sbc-class-recommend").value = String(record?.recommend_level ?? 0);
  document.getElementById("sbc-class-completion").value = record?.completion_status || "not_started";
  document.getElementById("sbc-class-error").classList.add("hidden");
  document.getElementById("sbc-class-modal").classList.add("active");
}

function reopenClassModalWithDraft(selectPlaylistId) {
  const draft = sbcClassDraft;
  sbcClassDraft = null;
  openSbcClassModal();
  if (draft) {
    document.getElementById("sbc-class-url").value = draft.url;
    document.getElementById("sbc-class-title").value = draft.title;
  }
  if (selectPlaylistId) document.getElementById("sbc-class-playlist").value = selectPlaylistId;
}

function wireSbcClassModal() {
  const modal = document.getElementById("sbc-class-modal");
  const errorEl = document.getElementById("sbc-class-error");

  document.getElementById("sbc-class-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("sbc-class-new-playlist-btn").onclick = () => {
    sbcClassDraft = {
      url: document.getElementById("sbc-class-url").value,
      title: document.getElementById("sbc-class-title").value,
    };
    modal.classList.remove("active");
    openSbcPlaylistModal();
  };

  document.getElementById("sbc-class-save-btn").onclick = async () => {
    const url = document.getElementById("sbc-class-url").value.trim();
    const title = document.getElementById("sbc-class-title").value.trim();
    const playlistId = document.getElementById("sbc-class-playlist").value;
    const date = document.getElementById("sbc-class-date").value;
    const recommendLevel = Number(document.getElementById("sbc-class-recommend").value);
    const completion = document.getElementById("sbc-class-completion").value;

    if (!/^https?:\/\//i.test(url)) {
      errorEl.textContent = "Please enter a valid YouTube link (starting with http:// or https://).";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!title) {
      errorEl.textContent = "Please enter a title.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!playlistId) {
      errorEl.textContent = "Please choose a playlist.";
      errorEl.classList.remove("hidden");
      return;
    }

    const payload = {
      youtube_url: url,
      title,
      playlist_id: playlistId,
      class_date: date || null,
      recommend_level: recommendLevel,
      completion_status: completion,
    };

    if (sbcEditingVideoId) {
      const { error } = await supabase.from("sb_class_videos").update(payload).eq("id", sbcEditingVideoId);
      if (error) {
        errorEl.textContent = error.message;
        errorEl.classList.remove("hidden");
        return;
      }
      modal.classList.remove("active");
      showToast("Class updated", "success");
    } else {
      payload.added_by = sbcCurrentUser?.user_name || null;
      const { error } = await supabase.from("sb_class_videos").insert(payload);
      if (error) {
        errorEl.textContent = error.message;
        errorEl.classList.remove("hidden");
        return;
      }
      modal.classList.remove("active");
      showToast("Class added", "success");
    }
    await loadSbcData();
    refreshSbcAfterVideoChange();
  };
}

function openSbcPlaylistModal() {
  document.getElementById("sbc-playlist-name-input").value = "";
  document.getElementById("sbc-playlist-error").classList.add("hidden");
  document.getElementById("sbc-playlist-modal").classList.add("active");
}

function wireSbcPlaylistModal() {
  const modal = document.getElementById("sbc-playlist-modal");
  const errorEl = document.getElementById("sbc-playlist-error");

  const closeAndMaybeResumeClass = () => {
    modal.classList.remove("active");
    if (sbcClassDraft) reopenClassModalWithDraft();
  };
  document.getElementById("sbc-playlist-cancel-btn").onclick = closeAndMaybeResumeClass;
  modal.addEventListener("click", (e) => { if (e.target === modal) closeAndMaybeResumeClass(); });

  document.getElementById("sbc-playlist-save-btn").onclick = async () => {
    const name = document.getElementById("sbc-playlist-name-input").value.trim();
    if (!name) {
      errorEl.textContent = "Please enter a playlist name.";
      errorEl.classList.remove("hidden");
      return;
    }
    const { data, error } = await supabase.from("sb_class_playlists").insert({ name }).select().single();
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    sbcPlaylists.push(data);
    sbcPlaylists.sort((a, b) => a.name.localeCompare(b.name));
    populatePlaylistSelects();
    modal.classList.remove("active");
    showToast("Playlist added", "success");
    if (sbcClassDraft) {
      reopenClassModalWithDraft(data.id);
    } else {
      sbcSwitchPanel("sbc-playlists-panel");
    }
  };
}

/* ======================= QUICK RECOMMEND (from a video's options menu) ======================= */

let sbcQuickRecVideoId = null;

function sbcCoordinatorCheckboxHtml(u, cls) {
  return `<label class="tag-check" data-name="${escapeHtml((u.user_name || "").toLowerCase())}"><input type="checkbox" class="${cls}" value="${u.id}" /> ${escapeHtml(u.user_name)}</label>`;
}

function openSbcQuickRecommendModal(videoId) {
  const v = sbcVideos.find((x) => x.id === videoId);
  if (!v) return;
  sbcQuickRecVideoId = videoId;
  document.getElementById("sbc-quick-rec-video-title").textContent = `${v.title} — ${v.playlist_name || ""}`;
  document.getElementById("sbc-quick-rec-search").value = "";
  document.getElementById("sbc-quick-rec-select-all").checked = false;
  const list = document.getElementById("sbc-quick-rec-user-list");
  list.innerHTML = sbcUsers.length
    ? sbcUsers.map((u) => sbcCoordinatorCheckboxHtml(u, "sbc-quick-rec-user-cb")).join("")
    : `<span class="muted-text">No coordinators found.</span>`;
  document.getElementById("sbc-quick-rec-error").classList.add("hidden");
  document.getElementById("sbc-quick-rec-modal").classList.add("active");
}

function wireSbcQuickRecommendModal() {
  const modal = document.getElementById("sbc-quick-rec-modal");
  const errorEl = document.getElementById("sbc-quick-rec-error");

  document.getElementById("sbc-quick-rec-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("sbc-quick-rec-search").addEventListener("input", debounce(() => {
    const term = document.getElementById("sbc-quick-rec-search").value.trim().toLowerCase();
    document.querySelectorAll("#sbc-quick-rec-user-list label.tag-check").forEach((label) => {
      label.classList.toggle("hidden", !!term && !label.dataset.name.includes(term));
    });
  }, 150));

  document.getElementById("sbc-quick-rec-select-all").addEventListener("change", (e) => {
    document.querySelectorAll("#sbc-quick-rec-user-list .sbc-quick-rec-user-cb").forEach((cb) => {
      if (!cb.closest("label").classList.contains("hidden")) cb.checked = e.target.checked;
    });
  });

  document.getElementById("sbc-quick-rec-save-btn").onclick = async () => {
    errorEl.classList.add("hidden");
    const userIds = Array.from(document.querySelectorAll("#sbc-quick-rec-user-list .sbc-quick-rec-user-cb:checked")).map((cb) => cb.value);
    if (!userIds.length) {
      errorEl.textContent = "Please select at least one coordinator.";
      errorEl.classList.remove("hidden");
      return;
    }
    const payload = userIds.map((user_id) => ({ video_id: sbcQuickRecVideoId, user_id, recommended_by: sbcCurrentUser?.user_name || null }));
    const { error } = await supabase.from("sb_class_recommendations").insert(payload);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast(`Recommended to ${userIds.length} coordinator(s)`, "success");
    await reloadSbcRecommendations();
    if (sbcActiveTarget() === "sbc-recommendations-panel") {
      renderSbcRecHistoryTable();
      applySbcRecHistorySearch();
    }
  };
}

/* ======================= SHARED ======================= */

function populatePlaylistSelects() {
  const dailyFilter = document.getElementById("sbc-daily-filter-playlist");
  const prevDaily = dailyFilter.value;
  dailyFilter.innerHTML = `<option value="__ALL__">All</option>` + sbcPlaylists.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  dailyFilter.value = prevDaily === "__ALL__" || sbcPlaylists.some((p) => p.id === prevDaily) ? prevDaily : "__ALL__";
}

function sbcActiveTarget() {
  return document.querySelector("#sbclasses-tabs .admin-tab.active")?.dataset.target || "sbc-dashboard-panel";
}

function sbcSwitchPanel(target) {
  document.querySelectorAll("#sbclasses-tabs .admin-tab").forEach((t) => t.classList.toggle("active", t.dataset.target === target));
  document.querySelectorAll("#sbclasses-section .fsu-panel").forEach((p) => p.classList.toggle("hidden", p.id !== target));

  if (target === "sbc-dashboard-panel") renderSbcDashboard();
  else if (target === "sbc-daily-panel") applyDailyFilters();
  else if (target === "sbc-playlists-panel") {
    showSbcPlaylistsGrid();
  } else if (target === "sbc-recommendations-panel") {
    renderSbcRecHistoryTable();
    applySbcRecHistorySearch();
  } else if (target === "sbc-doubts-panel") {
    renderSbcDoubtsTable();
  }
}

async function loadSbcData() {
  const [{ data: playlists, error: pErr }, { data: videos, error: vErr }, { data: users, error: uErr }, { data: recs, error: rErr }, { data: doubts, error: dErr }] = await Promise.all([
    supabase.from("sb_class_playlists").select("id,name").order("name"),
    supabase.from("sb_class_videos")
      .select("id,title,youtube_url,class_date,recommend_level,completion_status,playlist_id,created_at,sb_class_playlists(name)")
      .order("created_at", { ascending: false }),
    supabase.from("users").select("id,user_name").eq("role", "Coordinator").order("user_name"),
    supabase.from("sb_class_recommendations")
      .select("id,video_id,user_id,recommended_by,recommended_at,sb_class_videos(title,youtube_url,class_date,playlist_id,completion_status,sb_class_playlists(name)),users(user_name)")
      .order("recommended_at", { ascending: false }),
    supabase.from("sb_class_doubts")
      .select("id,video_id,user_id,timestamp_label,doubt_text,resolved,created_at,sb_class_videos(title,youtube_url),users(user_name)")
      .order("created_at", { ascending: false }),
  ]);
  if (pErr || vErr || uErr || rErr || dErr) {
    showToast("Could not load SB Classes data.", "error");
    return;
  }
  sbcPlaylists = playlists || [];
  sbcVideos = (videos || []).map((v) => ({ ...v, playlist_name: v.sb_class_playlists?.name || "—" }));
  sbcUsers = users || [];
  sbcRecommendations = (recs || []).map(mapRecommendationRow);
  sbcDoubts = (doubts || []).map(mapDoubtRow);
  populatePlaylistSelects();
}

export async function initSbClasses(currentUser) {
  sbcCurrentUser = currentUser;
  if (!sbcWired) {
    sbcWired = true;
    document.querySelectorAll("#sbclasses-tabs .admin-tab").forEach((tab) => {
      tab.addEventListener("click", () => sbcSwitchPanel(tab.dataset.target));
    });
    wireSbcDailyPanel();
    wireSbcPlaylistsPanel();
    wireSbcRecommendPanel();
    wireSbcClassModal();
    wireSbcPlaylistModal();
    wireSbcQuickRecommendModal();
    wireSbcDoubtsPanel();
  }
  await loadSbcData();
  sbcSwitchPanel("sbc-dashboard-panel");
}

/* ======================= USER: Daily Class List & Recommendations =======================
   The regular-user side, wired into the FNRG Sadhana user page
   (fnrg-sadhana-user-section) alongside Enter Sadhana / Analytics. Users see
   the shared class list (read-only, apart from marking their own view of a
   class's completion status — completion_status is a column on the class
   itself, not per-user) and any classes an admin recommended to them. */

let fsuSbcWired = false;
let fsuSbcCurrentUser = null;
let fsuSbcVideos = [];
let fsuSbcPlaylists = [];
let fsuSbcRecs = [];
let fsuSbcDoubts = [];

function fsuDailyRowHtml(v, idx) {
  return `
    <tr data-id="${v.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Date">${v.class_date || "—"}</td>
      <td data-label="Title">${escapeHtml(v.title)}</td>
      <td data-label="Link"><a class="cell-chip" href="${safeHref(v.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a></td>
      <td data-label="Playlist">${escapeHtml(v.playlist_name || "—")}</td>
      <td data-label="Recommend Level">${v.recommend_level}</td>
      <td data-label="Completion Status"><select class="inline-edit fsu-completion-select" data-field="completion_status">${sbcCompletionOptionsHtml(v.completion_status)}</select></td>
    </tr>`;
}

function fsuRecRowHtml(r) {
  return `
    <tr data-id="${r.video_id}">
      <td data-label="Date">${r.class_date || "—"}</td>
      <td data-label="Title">${escapeHtml(r.title)}</td>
      <td data-label="Link"><a class="cell-chip" href="${safeHref(r.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a></td>
      <td data-label="Playlist">${escapeHtml(r.playlist_name || "—")}</td>
      <td data-label="Recommended By">${escapeHtml(r.recommended_by || "—")}</td>
      <td data-label="Recommended At">${new Date(r.recommended_at).toLocaleDateString()}</td>
      <td data-label="Completion Status"><select class="inline-edit fsu-completion-select" data-field="completion_status">${sbcCompletionOptionsHtml(r.completion_status)}</select></td>
    </tr>`;
}

function wireFsuCompletionSelects(tbody, cache) {
  tbody.querySelectorAll(".fsu-completion-select").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const record = cache.find((x) => (x.id || x.video_id) === id);
      const value = e.target.value;
      const { error } = await supabase.from("sb_class_videos").update({ completion_status: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.value = record?.completion_status || "not_started";
        return;
      }
      if (record) record.completion_status = value;
      // The same class can appear in both the daily list and the
      // recommendations list — keep whichever cache didn't just save in sync.
      [fsuSbcVideos, fsuSbcRecs].forEach((list) => {
        const other = list.find((x) => (x.id || x.video_id) === id);
        if (other) other.completion_status = value;
      });
    });
  });
}

function populateFsuDailyPlaylistFilter() {
  const sel = document.getElementById("fsu-daily-filter-playlist");
  const prev = sel.value;
  sel.innerHTML = `<option value="__ALL__">All</option>` + fsuSbcPlaylists.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  sel.value = prev === "__ALL__" || fsuSbcPlaylists.some((p) => p.id === prev) ? prev : "__ALL__";
}

function applyFsuDailyFilters() {
  const term = document.getElementById("fsu-daily-search").value.trim().toLowerCase();
  const playlistFilter = document.getElementById("fsu-daily-filter-playlist").value;
  const completionFilter = document.getElementById("fsu-daily-filter-completion").value;

  let rows = fsuSbcVideos.filter((v) => !term || String(v.title || "").toLowerCase().includes(term));
  if (playlistFilter !== "__ALL__") rows = rows.filter((v) => v.playlist_id === playlistFilter);
  if (completionFilter !== "__ALL__") rows = rows.filter((v) => v.completion_status === completionFilter);
  rows = sortByDateDesc(rows);

  const tbody = document.getElementById("fsu-daily-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">${fsuSbcVideos.length ? "No classes match your filters." : "No classes yet."}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((v, idx) => fsuDailyRowHtml(v, idx)).join("");
  wireFsuCompletionSelects(tbody, fsuSbcVideos);
}

function renderFsuRecTable() {
  const tbody = document.getElementById("fsu-rec-body");
  if (!fsuSbcRecs.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">No classes have been recommended to you yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = fsuSbcRecs.map(fsuRecRowHtml).join("");
  wireFsuCompletionSelects(tbody, fsuSbcRecs);
}

async function loadFsuSpData(userId) {
  const [{ data: playlists, error: pErr }, { data: videos, error: vErr }, { data: recs, error: rErr }, { data: doubts, error: dErr }] = await Promise.all([
    supabase.from("sb_class_playlists").select("id,name").order("name"),
    supabase.from("sb_class_videos")
      .select("id,title,youtube_url,class_date,recommend_level,completion_status,playlist_id,sb_class_playlists(name)")
      .order("class_date", { ascending: false }),
    supabase.from("sb_class_recommendations")
      .select("video_id,recommended_by,recommended_at,sb_class_videos(title,youtube_url,class_date,completion_status,sb_class_playlists(name))")
      .eq("user_id", userId)
      .order("recommended_at", { ascending: false }),
    supabase.from("sb_class_doubts")
      .select("id,timestamp_label,doubt_text,resolved,created_at,sb_class_videos(title)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
  ]);
  if (pErr || vErr || rErr || dErr) {
    showToast("Could not load classes.", "error");
    return;
  }
  fsuSbcDoubts = (doubts || []).map((d) => ({
    id: d.id,
    timestamp_label: d.timestamp_label,
    doubt_text: d.doubt_text,
    resolved: d.resolved,
    created_at: d.created_at,
    title: d.sb_class_videos?.title || "—",
  }));
  fsuSbcPlaylists = playlists || [];
  fsuSbcVideos = (videos || []).map((v) => ({ ...v, playlist_name: v.sb_class_playlists?.name || "—" }));

  const seen = new Set();
  fsuSbcRecs = [];
  (recs || []).forEach((r) => {
    if (seen.has(r.video_id)) return; // rows arrive latest-first, so the first hit per class is the most recent recommendation
    seen.add(r.video_id);
    fsuSbcRecs.push({
      video_id: r.video_id,
      recommended_by: r.recommended_by,
      recommended_at: r.recommended_at,
      title: r.sb_class_videos?.title || "—",
      youtube_url: r.sb_class_videos?.youtube_url || "",
      class_date: r.sb_class_videos?.class_date || null,
      completion_status: r.sb_class_videos?.completion_status || "not_started",
      playlist_name: r.sb_class_videos?.sb_class_playlists?.name || "—",
    });
  });
}

/* ======================= USER: Ask a Doubt ======================= */

function fsuDoubtClassOptionsHtml() {
  return sortByDateDesc(fsuSbcVideos).map((v) => `<option value="${v.id}">${escapeHtml(v.title)} — ${escapeHtml(v.playlist_name || "—")}</option>`).join("");
}

function populateFsuDoubtClassSelect() {
  const sel = document.getElementById("fsu-doubt-class-select");
  const prev = sel.value;
  sel.innerHTML = fsuSbcVideos.length ? fsuDoubtClassOptionsHtml() : `<option value="">No classes yet</option>`;
  if (fsuSbcVideos.some((v) => v.id === prev)) sel.value = prev;
}

function renderFsuDoubtsTable() {
  const tbody = document.getElementById("fsu-doubts-body");
  if (!fsuSbcDoubts.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted-text">You haven't asked any doubts yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = fsuSbcDoubts.map((d) => `
    <tr>
      <td data-label="Asked At">${new Date(d.created_at).toLocaleString()}</td>
      <td data-label="Class">${escapeHtml(d.title)}</td>
      <td data-label="Timing">${escapeHtml(d.timestamp_label)}</td>
      <td data-label="Doubt">${escapeHtml(d.doubt_text)}</td>
      <td data-label="Status"><span class="sbc-badge ${d.resolved ? "completed" : "not_started"}">${d.resolved ? "Resolved" : "Pending"}</span></td>
    </tr>`).join("");
}

function wireFsuDoubtsPanel() {
  document.getElementById("fsu-doubt-submit-btn").addEventListener("click", async () => {
    const errorEl = document.getElementById("fsu-doubt-error");
    errorEl.classList.add("hidden");
    const videoId = document.getElementById("fsu-doubt-class-select").value;
    const timestampLabel = document.getElementById("fsu-doubt-timestamp").value.trim();
    const doubtText = document.getElementById("fsu-doubt-text").value.trim();

    if (!videoId) {
      errorEl.textContent = "Please choose a class.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!timestampLabel) {
      errorEl.textContent = "Please mention the timing in the video where you have the doubt.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (!doubtText) {
      errorEl.textContent = "Please type your doubt.";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await supabase.from("sb_class_doubts").insert({
      video_id: videoId,
      user_id: fsuSbcCurrentUser?.id,
      timestamp_label: timestampLabel,
      doubt_text: doubtText,
    });
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }

    document.getElementById("fsu-doubt-timestamp").value = "";
    document.getElementById("fsu-doubt-text").value = "";
    showToast("Doubt submitted", "success");
    await loadFsuSpData(fsuSbcCurrentUser.id);
    renderFsuDoubtsTable();
  });
}

export async function initFsuSbClasses(currentUser) {
  fsuSbcCurrentUser = currentUser;
  if (!fsuSbcWired) {
    fsuSbcWired = true;
    document.getElementById("fsu-daily-search").addEventListener("input", debounce(applyFsuDailyFilters, 200));
    document.getElementById("fsu-daily-filter-playlist").addEventListener("change", applyFsuDailyFilters);
    document.getElementById("fsu-daily-filter-completion").addEventListener("change", applyFsuDailyFilters);
    wireFsuDoubtsPanel();
  }
  if (!currentUser?.id) return;
  await loadFsuSpData(currentUser.id);
  populateFsuDailyPlaylistFilter();
  applyFsuDailyFilters();
  renderFsuRecTable();
  populateFsuDoubtClassSelect();
  renderFsuDoubtsTable();
}
