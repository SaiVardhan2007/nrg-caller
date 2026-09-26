import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, debounce } from "./utils.js";
import { todayLocalDate } from "./sadhana.js";

const COMPLETION_OPTIONS = [
  ["not_started", "Not Started"],
  ["partially_completed", "Partially Completed"],
  ["completed", "Completed"],
];
const RECOMMEND_LEVELS = [0, 1, 2, 3];

let spcCurrentUser = null;
let spcWired = false;
let spcPlaylists = [];
let spcVideos = [];
let spcUsers = [];
let spcRecommendations = [];
// Holds the in-progress Add Class form's url/title while the user detours
// through "+ New Playlist" mid-add, so re-opening the class modal afterwards
// doesn't lose what they'd already typed.
let spcClassDraft = null;

function completionLabel(value) {
  return COMPLETION_OPTIONS.find(([v]) => v === value)?.[1] || value;
}

function spcCompletionOptionsHtml(current) {
  return COMPLETION_OPTIONS.map(([v, label]) => `<option value="${v}" ${v === current ? "selected" : ""}>${label}</option>`).join("");
}

function spcRecommendOptionsHtml(current) {
  return RECOMMEND_LEVELS.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${v}</option>`).join("");
}

function spcPlaylistOptionsHtml(current) {
  return spcPlaylists.map((p) => `<option value="${p.id}" ${p.id === current ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
}

// Only ever renders a real http(s) link — an unexpected value here falls
// back to "#" rather than letting a bad/empty youtube_url leak into an href.
function safeHref(url) {
  return /^https?:\/\//i.test(url || "") ? escapeHtml(url) : "#";
}

function spcRowHtml(r, idx, {
  showDate = true, showPlaylist = true, showSno = true, showLink = true, showAssigned = true, showDelete = true,
} = {}) {
  return `
    <tr data-id="${r.id}">
      ${showSno ? `<td data-label="S.No">${idx + 1}</td>` : ""}
      ${showDate ? `<td data-label="Date"><input class="inline-edit" type="date" data-field="class_date" value="${r.class_date || ""}" /></td>` : ""}
      <td data-label="Title"><input class="inline-edit" type="text" data-field="title" value="${escapeHtml(r.title)}" /></td>
      ${showLink ? `<td data-label="Link"><a class="cell-chip" href="${safeHref(r.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a></td>` : ""}
      ${showPlaylist ? `<td data-label="Playlist"><select class="inline-edit" data-field="playlist_id">${spcPlaylistOptionsHtml(r.playlist_id)}</select></td>` : ""}
      ${showAssigned ? `<td data-label="Assigned"><input type="checkbox" class="inline-edit" data-field="assigned" ${r.assigned ? "checked" : ""} /></td>` : ""}
      <td data-label="Recommend Level"><select class="inline-edit" data-field="recommend_level">${spcRecommendOptionsHtml(r.recommend_level)}</select></td>
      <td data-label="Completion Status"><select class="inline-edit" data-field="completion_status">${spcCompletionOptionsHtml(r.completion_status)}</select></td>
      ${showDelete ? `<td data-label=""><button type="button" class="cell-chip danger spc-delete-btn" title="Delete">🗑 Delete</button></td>` : ""}
    </tr>`;
}

function wireSpcInlineEditCells(tbody, onChange) {
  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const field = e.target.dataset.field;
      const record = spcVideos.find((x) => x.id === id);
      let value;
      if (field === "assigned") value = e.target.checked;
      else if (field === "recommend_level") value = Number(e.target.value);
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

      const { error } = await supabase.from("sp_class_videos").update({ [field]: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        return;
      }
      record[field] = value;
      if (field === "playlist_id") {
        record.playlist_name = spcPlaylists.find((p) => p.id === value)?.name || "—";
      }
      onChange?.();
    });
  });
}

function wireSpcDeleteButtons(tbody) {
  tbody.querySelectorAll(".spc-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSpcVideo(btn.closest("tr").dataset.id));
  });
}

async function deleteSpcVideo(id) {
  const r = spcVideos.find((x) => x.id === id);
  if (!confirm(`Delete class "${r?.title || ""}"?`)) return;
  const { error } = await supabase.from("sp_class_videos").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  spcVideos = spcVideos.filter((x) => x.id !== id);
  showToast("Class deleted", "success");
  refreshSpcAfterVideoChange();
}

function renderSpcTableRows(tbodyId, rows, colCount, emptyMessage, opts, onChange) {
  const tbody = document.getElementById(tbodyId);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="muted-text">${emptyMessage}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, idx) => spcRowHtml(r, idx, opts)).join("");
  wireSpcInlineEditCells(tbody, onChange);
  wireSpcDeleteButtons(tbody);
}

function sortByDateDesc(rows) {
  return [...rows].sort((a, b) => (b.class_date || b.created_at || "").localeCompare(a.class_date || a.created_at || ""));
}

/* ======================= DASHBOARD ======================= */

function renderSpcDashboard() {
  const total = spcVideos.length;
  const assigned = spcVideos.filter((v) => v.assigned).length;
  const notStarted = spcVideos.filter((v) => v.completion_status === "not_started").length;
  const partial = spcVideos.filter((v) => v.completion_status === "partially_completed").length;
  const completed = spcVideos.filter((v) => v.completion_status === "completed").length;

  document.getElementById("spc-stat-total").textContent = total;
  document.getElementById("spc-stat-playlists").textContent = spcPlaylists.length;
  document.getElementById("spc-stat-assigned").textContent = assigned;
  document.getElementById("spc-stat-not-started").textContent = notStarted;
  document.getElementById("spc-stat-partial").textContent = partial;
  document.getElementById("spc-stat-completed").textContent = completed;

  const recent = [...spcVideos].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 5);
  renderSpcTableRows("spc-recent-body", recent, 5, "No classes yet.",
    { showSno: false, showLink: false, showAssigned: false, showDelete: false, showDate: true, showPlaylist: true },
    () => renderSpcDashboard());
}

/* ======================= DAILY CLASS LIST ======================= */

function applyDailyFilters() {
  const term = document.getElementById("spc-daily-search").value.trim().toLowerCase();
  const playlistFilter = document.getElementById("spc-daily-filter-playlist").value;
  const completionFilter = document.getElementById("spc-daily-filter-completion").value;

  let rows = spcVideos.filter((r) => !term || String(r.title || "").toLowerCase().includes(term));
  if (playlistFilter !== "__ALL__") rows = rows.filter((r) => r.playlist_id === playlistFilter);
  if (completionFilter !== "__ALL__") rows = rows.filter((r) => r.completion_status === completionFilter);

  renderSpcTableRows("spc-daily-body", sortByDateDesc(rows), 9,
    spcVideos.length ? "No classes match your filters." : "No classes yet — add one to get started.",
    { showDate: true, showPlaylist: true });
}

function wireSpcDailyPanel() {
  document.getElementById("spc-daily-search").addEventListener("input", debounce(applyDailyFilters, 200));
  document.getElementById("spc-daily-filter-playlist").addEventListener("change", applyDailyFilters);
  document.getElementById("spc-daily-filter-completion").addEventListener("change", applyDailyFilters);
  document.getElementById("spc-add-class-btn").addEventListener("click", () => openSpcClassModal());
}

/* ======================= PLAYLISTS ======================= */

let spcActivePlaylistId = null;

function renderPlaylistsGrid() {
  const grid = document.getElementById("spc-playlists-grid");
  if (!spcPlaylists.length) {
    grid.innerHTML = `<p class="muted-text">No playlists yet — add one to get started.</p>`;
    return;
  }
  grid.innerHTML = spcPlaylists.map((p) => {
    const count = spcVideos.filter((v) => v.playlist_id === p.id).length;
    return `
      <div class="trip-event-card spc-playlist-card" data-id="${p.id}">
        <div class="trip-event-card-header">
          <p class="trip-event-card-name">${escapeHtml(p.name)}</p>
          <button type="button" class="cell-chip danger spc-playlist-delete-btn" title="Delete playlist">🗑</button>
        </div>
        <p class="spc-playlist-card-count">${count} class${count === 1 ? "" : "es"}</p>
      </div>`;
  }).join("");

  grid.querySelectorAll(".spc-playlist-card").forEach((card) => {
    card.addEventListener("click", () => openSpcPlaylistDetail(card.dataset.id));
  });
  grid.querySelectorAll(".spc-playlist-delete-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSpcPlaylist(btn.closest(".spc-playlist-card").dataset.id);
    });
  });
}

async function deleteSpcPlaylist(id) {
  const p = spcPlaylists.find((x) => x.id === id);
  const count = spcVideos.filter((v) => v.playlist_id === id).length;
  const warning = count ? ` This will also delete its ${count} class(es).` : "";
  if (!confirm(`Delete playlist "${p?.name || ""}"?${warning}`)) return;

  const { error } = await supabase.from("sp_class_playlists").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  spcPlaylists = spcPlaylists.filter((x) => x.id !== id);
  spcVideos = spcVideos.filter((v) => v.playlist_id !== id);
  showToast("Playlist deleted", "success");
  populatePlaylistSelects();
  renderPlaylistsGrid();
}

function closeAllSpcVideoMenus() {
  document.querySelectorAll(".spc-video-menu").forEach((m) => m.classList.add("hidden"));
}

function spcVideoCardHtml(v) {
  return `
    <div class="spc-video-card" data-id="${v.id}">
      <div class="spc-video-card-main">
        <div class="spc-video-card-title">${escapeHtml(v.title)}</div>
        <div class="spc-video-card-meta">
          <span>${v.class_date || "—"}</span>
          <span class="spc-badge ${v.completion_status}">${completionLabel(v.completion_status)}</span>
          ${v.assigned ? `<span class="spc-badge assigned">📌 Daily List</span>` : ""}
          <span class="spc-badge">Rec Lvl ${v.recommend_level}</span>
        </div>
      </div>
      <div class="spc-video-card-actions">
        <a class="cell-chip" href="${safeHref(v.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a>
        <div class="spc-video-menu-wrap">
          <button type="button" class="spc-video-menu-btn" title="Options">⋮</button>
          <div class="spc-video-menu hidden">
            <button type="button" class="spc-video-menu-item" data-action="recommend">⭐ Recommend</button>
            <button type="button" class="spc-video-menu-item" data-action="toggle-assigned">${v.assigned ? "📌 Remove from Daily List" : "📌 Add to Daily List"}</button>
            <button type="button" class="spc-video-menu-item" data-action="edit">✏️ Edit</button>
            <button type="button" class="spc-video-menu-item danger" data-action="delete">🗑 Delete</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderPlaylistVideosList(playlistId) {
  const wrap = document.getElementById("spc-playlist-videos-list");
  const rows = sortByDateDesc(spcVideos.filter((v) => v.playlist_id === playlistId));
  if (!rows.length) {
    wrap.innerHTML = `<p class="muted-text">No classes in this playlist yet.</p>`;
    return;
  }
  wrap.innerHTML = rows.map(spcVideoCardHtml).join("");

  wrap.querySelectorAll(".spc-video-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const wasHidden = menu.classList.contains("hidden");
      closeAllSpcVideoMenus();
      menu.classList.toggle("hidden", !wasHidden);
    });
  });

  wrap.querySelectorAll(".spc-video-menu-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllSpcVideoMenus();
      const id = btn.closest(".spc-video-card").dataset.id;
      const action = btn.dataset.action;
      if (action === "recommend") openSpcQuickRecommendModal(id);
      else if (action === "toggle-assigned") toggleSpcVideoAssigned(id);
      else if (action === "edit") openSpcClassModal(id);
      else if (action === "delete") deleteSpcVideo(id);
    });
  });
}

async function toggleSpcVideoAssigned(id) {
  const record = spcVideos.find((x) => x.id === id);
  if (!record) return;
  const value = !record.assigned;
  const { error } = await supabase.from("sp_class_videos").update({ assigned: value }).eq("id", id);
  if (error) {
    showToast("Update failed: " + error.message, "error");
    return;
  }
  record.assigned = value;
  showToast(value ? "Added to Daily Class List" : "Removed from Daily Class List", "success");
  renderPlaylistVideosList(spcActivePlaylistId);
}

function openSpcPlaylistDetail(playlistId) {
  const p = spcPlaylists.find((x) => x.id === playlistId);
  if (!p) return;
  spcActivePlaylistId = playlistId;
  document.getElementById("spc-playlists-grid-view").classList.add("hidden");
  document.getElementById("spc-playlist-detail-view").classList.remove("hidden");
  document.getElementById("spc-playlist-detail-title").textContent = p.name;
  renderPlaylistVideosList(playlistId);
}

function showSpcPlaylistsGrid() {
  spcActivePlaylistId = null;
  document.getElementById("spc-playlist-detail-view").classList.add("hidden");
  document.getElementById("spc-playlists-grid-view").classList.remove("hidden");
  renderPlaylistsGrid();
}

// Called after an add/edit/delete/toggle on a video — stays in the playlist
// detail view if that's where the action came from, instead of bouncing back
// to the grid or another tab.
function refreshSpcAfterVideoChange() {
  if (spcActivePlaylistId && spcPlaylists.some((p) => p.id === spcActivePlaylistId)) {
    document.getElementById("spc-playlist-detail-title").textContent =
      spcPlaylists.find((p) => p.id === spcActivePlaylistId)?.name || "";
    renderPlaylistVideosList(spcActivePlaylistId);
  } else {
    spcSwitchPanel(spcActiveTarget());
  }
}

async function renameSpcActivePlaylist() {
  const p = spcPlaylists.find((x) => x.id === spcActivePlaylistId);
  if (!p) return;
  const name = prompt("Rename playlist", p.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    showToast("Playlist name cannot be empty.", "error");
    return;
  }
  const { error } = await supabase.from("sp_class_playlists").update({ name: trimmed }).eq("id", p.id);
  if (error) {
    showToast("Update failed: " + error.message, "error");
    return;
  }
  p.name = trimmed;
  spcVideos.filter((v) => v.playlist_id === p.id).forEach((v) => { v.playlist_name = trimmed; });
  document.getElementById("spc-playlist-detail-title").textContent = trimmed;
  populatePlaylistSelects();
  showToast("Playlist renamed", "success");
}

function wireSpcPlaylistsPanel() {
  document.getElementById("spc-add-playlist-btn").addEventListener("click", () => openSpcPlaylistModal());
  document.getElementById("spc-playlist-back-btn").addEventListener("click", showSpcPlaylistsGrid);
  document.getElementById("spc-playlist-rename-btn").addEventListener("click", renameSpcActivePlaylist);
  document.getElementById("spc-playlist-add-video-btn").addEventListener("click", () => openSpcClassModal(null, spcActivePlaylistId));
  document.addEventListener("click", closeAllSpcVideoMenus);
}

/* ======================= RECOMMENDATIONS (admin: recommend a class to users) =======================
   Admin picks one class and one or more users from the roster, then
   "Recommend to Selected" inserts one sp_class_recommendations row per
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
    title: r.sp_class_videos?.title || "—",
    class_date: r.sp_class_videos?.class_date || null,
    playlist_id: r.sp_class_videos?.playlist_id || null,
    playlist_name: r.sp_class_videos?.sp_class_playlists?.name || "—",
    user_name: r.users?.user_name || "—",
  };
}

async function reloadSpcRecommendations() {
  const { data, error } = await supabase
    .from("sp_class_recommendations")
    .select("id,video_id,user_id,recommended_by,recommended_at,sp_class_videos(title,class_date,playlist_id,sp_class_playlists(name)),users(user_name)")
    .order("recommended_at", { ascending: false });
  if (error) {
    showToast("Could not refresh recommendation history.", "error");
    return;
  }
  spcRecommendations = (data || []).map(mapRecommendationRow);
}

function spcRecClassOptionsHtml() {
  return sortByDateDesc(spcVideos).map((v) => `<option value="${v.id}">${escapeHtml(v.title)} — ${escapeHtml(v.playlist_name || "—")}</option>`).join("");
}

function populateSpcRecClassSelect() {
  const sel = document.getElementById("spc-rec-class-select");
  const prev = sel.value;
  sel.innerHTML = spcVideos.length ? spcRecClassOptionsHtml() : `<option value="">No classes yet</option>`;
  if (spcVideos.some((v) => v.id === prev)) sel.value = prev;
}

function renderSpcRecUserList() {
  const list = document.getElementById("spc-rec-user-list");
  list.innerHTML = spcUsers.length
    ? spcUsers.map((u) => `<label class="tag-check" data-name="${escapeHtml((u.user_name || "").toLowerCase())}"><input type="checkbox" class="spc-rec-user-cb" value="${u.id}" /> ${escapeHtml(u.user_name)}</label>`).join("")
    : `<span class="muted-text">No coordinators found.</span>`;
  document.getElementById("spc-rec-select-all").checked = false;
}

function applySpcRecUserSearch() {
  const term = document.getElementById("spc-rec-user-search").value.trim().toLowerCase();
  document.querySelectorAll("#spc-rec-user-list label.tag-check").forEach((label) => {
    label.classList.toggle("hidden", !!term && !label.dataset.name.includes(term));
  });
}

function openSpcRecommendModal() {
  populateSpcRecClassSelect();
  document.getElementById("spc-rec-user-search").value = "";
  renderSpcRecUserList();
  applySpcRecUserSearch();
  document.getElementById("spc-rec-error").classList.add("hidden");
  document.getElementById("spc-recommend-modal").classList.add("active");
}

async function recommendClassToSelectedUsers() {
  const errorEl = document.getElementById("spc-rec-error");
  errorEl.classList.add("hidden");
  const videoId = document.getElementById("spc-rec-class-select").value;
  const userIds = Array.from(document.querySelectorAll("#spc-rec-user-list .spc-rec-user-cb:checked")).map((cb) => cb.value);

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

  const payload = userIds.map((user_id) => ({ video_id: videoId, user_id, recommended_by: spcCurrentUser?.user_name || null }));
  const { error } = await supabase.from("sp_class_recommendations").insert(payload);
  if (error) {
    errorEl.textContent = error.message;
    errorEl.classList.remove("hidden");
    return;
  }

  document.getElementById("spc-recommend-modal").classList.remove("active");
  showToast(`Recommended to ${userIds.length} coordinator(s)`, "success");
  await reloadSpcRecommendations();
  renderSpcRecHistoryTable();
  applySpcRecHistorySearch();
}

function spcUserOptionsHtml(current) {
  return spcUsers.map((u) => `<option value="${u.id}" ${u.id === current ? "selected" : ""}>${escapeHtml(u.user_name)}</option>`).join("");
}

// Formats an ISO timestamp for a <input type="datetime-local"> value, in the
// viewer's local time (matching how it's displayed elsewhere in this table).
function toDatetimeLocalValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderSpcRecHistoryTable() {
  const tbody = document.getElementById("spc-rec-history-body");
  if (!spcRecommendations.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted-text">No recommendations yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = spcRecommendations.map((r, idx) => `
    <tr data-id="${r.id}" data-search="${escapeHtml((r.title + " " + r.user_name).toLowerCase())}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Class Date"><input class="inline-edit" type="date" data-field="class_date" value="${r.class_date || ""}" /></td>
      <td data-label="Title"><input class="inline-edit" type="text" data-field="title" value="${escapeHtml(r.title)}" /></td>
      <td data-label="Playlist"><select class="inline-edit" data-field="playlist_id">${spcPlaylistOptionsHtml(r.playlist_id)}</select></td>
      <td data-label="Recommended To"><select class="inline-edit" data-field="user_id">${spcUserOptionsHtml(r.user_id)}</select></td>
      <td data-label="Recommended By"><input class="inline-edit" type="text" data-field="recommended_by" value="${escapeHtml(r.recommended_by || "")}" /></td>
      <td data-label="Recommended At"><input class="inline-edit" type="datetime-local" data-field="recommended_at" value="${toDatetimeLocalValue(r.recommended_at)}" /></td>
      <td data-label=""><button type="button" class="cell-chip danger spc-rec-delete-btn" title="Remove">🗑 Remove</button></td>
    </tr>`).join("");

  tbody.querySelectorAll(".spc-rec-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSpcRecommendation(btn.closest("tr").dataset.id));
  });
  wireSpcRecHistoryInlineEdits(tbody);
}

// Class Date/Title/Playlist live on the recommended video (sp_class_videos)
// and are shared by every recommendation of that class; User/Recommended
// By/At live on this recommendation row itself (sp_class_recommendations).
async function updateSpcRecHistoryField(tr, field, rawValue) {
  const id = tr.dataset.id;
  const record = spcRecommendations.find((r) => r.id === id);
  if (!record) return;

  if (field === "class_date" || field === "playlist_id") {
    const value = field === "class_date" ? (rawValue || null) : rawValue;
    const { error } = await supabase.from("sp_class_videos").update({ [field]: value }).eq("id", record.video_id);
    if (error) return showToast("Update failed: " + error.message, "error");
    const playlistName = field === "playlist_id" ? (spcPlaylists.find((p) => p.id === value)?.name || "—") : null;
    [spcRecommendations, spcVideos].forEach((list) => {
      list.filter((x) => (x.video_id || x.id) === record.video_id).forEach((x) => {
        x[field] = value;
        if (field === "playlist_id") x.playlist_name = playlistName;
      });
    });
  } else if (field === "title") {
    const value = rawValue.trim();
    if (!value) return showToast("Title cannot be empty.", "error");
    const { error } = await supabase.from("sp_class_videos").update({ title: value }).eq("id", record.video_id);
    if (error) return showToast("Update failed: " + error.message, "error");
    [spcRecommendations, spcVideos].forEach((list) => {
      list.filter((x) => (x.video_id || x.id) === record.video_id).forEach((x) => { x.title = value; });
    });
  } else if (field === "user_id") {
    const { error } = await supabase.from("sp_class_recommendations").update({ user_id: rawValue }).eq("id", id);
    if (error) return showToast("Update failed: " + error.message, "error");
    record.user_id = rawValue;
    record.user_name = spcUsers.find((u) => u.id === rawValue)?.user_name || "—";
  } else if (field === "recommended_by") {
    const value = rawValue.trim() || null;
    const { error } = await supabase.from("sp_class_recommendations").update({ recommended_by: value }).eq("id", id);
    if (error) return showToast("Update failed: " + error.message, "error");
    record.recommended_by = value;
  } else if (field === "recommended_at") {
    const iso = rawValue ? new Date(rawValue).toISOString() : null;
    const { error } = await supabase.from("sp_class_recommendations").update({ recommended_at: iso }).eq("id", id);
    if (error) return showToast("Update failed: " + error.message, "error");
    record.recommended_at = iso;
  }

  renderSpcRecHistoryTable();
  applySpcRecHistorySearch();
}

function wireSpcRecHistoryInlineEdits(tbody) {
  tbody.querySelectorAll(".inline-edit").forEach((el) => {
    el.addEventListener("change", (e) => {
      updateSpcRecHistoryField(e.target.closest("tr"), e.target.dataset.field, e.target.value);
    });
  });
}

function applySpcRecHistorySearch() {
  const term = document.getElementById("spc-rec-history-search").value.trim().toLowerCase();
  document.querySelectorAll("#spc-rec-history-body tr[data-id]").forEach((row) => {
    row.classList.toggle("hidden", !!term && !row.dataset.search.includes(term));
  });
}

async function deleteSpcRecommendation(id) {
  if (!confirm("Remove this recommendation?")) return;
  const { error } = await supabase.from("sp_class_recommendations").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  spcRecommendations = spcRecommendations.filter((r) => r.id !== id);
  showToast("Recommendation removed", "success");
  renderSpcRecHistoryTable();
  applySpcRecHistorySearch();
}

function wireSpcRecommendPanel() {
  const modal = document.getElementById("spc-recommend-modal");
  document.getElementById("spc-rec-open-modal-btn").addEventListener("click", openSpcRecommendModal);
  document.getElementById("spc-rec-cancel-btn").addEventListener("click", () => modal.classList.remove("active"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });
  document.getElementById("spc-rec-user-search").addEventListener("input", debounce(applySpcRecUserSearch, 150));
  document.getElementById("spc-rec-history-search").addEventListener("input", debounce(applySpcRecHistorySearch, 150));
  document.getElementById("spc-rec-recommend-btn").addEventListener("click", recommendClassToSelectedUsers);
  document.getElementById("spc-rec-select-all").addEventListener("change", (e) => {
    document.querySelectorAll("#spc-rec-user-list .spc-rec-user-cb").forEach((cb) => {
      if (!cb.closest("label").classList.contains("hidden")) cb.checked = e.target.checked;
    });
  });
}

/* ======================= DOUBTS (admin: view doubts users asked on classes) ======================= */

let spcDoubts = [];

function mapDoubtRow(r) {
  return {
    id: r.id,
    video_id: r.video_id,
    user_id: r.user_id,
    timestamp_label: r.timestamp_label,
    doubt_text: r.doubt_text,
    resolved: r.resolved,
    created_at: r.created_at,
    title: r.sp_class_videos?.title || "—",
    youtube_url: r.sp_class_videos?.youtube_url || "",
    user_name: r.users?.user_name || "—",
  };
}

function renderSpcDoubtsTable() {
  const term = document.getElementById("spc-doubts-search").value.trim().toLowerCase();
  const statusFilter = document.getElementById("spc-doubts-filter-status").value;

  let rows = spcDoubts;
  if (statusFilter === "pending") rows = rows.filter((d) => !d.resolved);
  else if (statusFilter === "resolved") rows = rows.filter((d) => d.resolved);
  if (term) rows = rows.filter((d) => `${d.title} ${d.user_name} ${d.doubt_text}`.toLowerCase().includes(term));

  const tbody = document.getElementById("spc-doubts-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted-text">${spcDoubts.length ? "No doubts match your filters." : "No doubts asked yet."}</td></tr>`;
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
      <td data-label="Resolved"><input type="checkbox" class="inline-edit spc-doubt-resolved-cb" ${d.resolved ? "checked" : ""} /></td>
      <td data-label=""><button type="button" class="cell-chip danger spc-doubt-delete-btn" title="Delete">🗑 Delete</button></td>
    </tr>`).join("");

  tbody.querySelectorAll(".spc-doubt-resolved-cb").forEach((cb) => {
    cb.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const record = spcDoubts.find((d) => d.id === id);
      const value = e.target.checked;
      const { error } = await supabase.from("sp_class_doubts").update({ resolved: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.checked = !value;
        return;
      }
      if (record) record.resolved = value;
    });
  });
  tbody.querySelectorAll(".spc-doubt-delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteSpcDoubt(btn.closest("tr").dataset.id));
  });
}

async function deleteSpcDoubt(id) {
  if (!confirm("Delete this doubt?")) return;
  const { error } = await supabase.from("sp_class_doubts").delete().eq("id", id);
  if (error) {
    showToast("Delete failed: " + error.message, "error");
    return;
  }
  spcDoubts = spcDoubts.filter((d) => d.id !== id);
  showToast("Doubt deleted", "success");
  renderSpcDoubtsTable();
}

function wireSpcDoubtsPanel() {
  document.getElementById("spc-doubts-search").addEventListener("input", debounce(renderSpcDoubtsTable, 150));
  document.getElementById("spc-doubts-filter-status").addEventListener("change", renderSpcDoubtsTable);
}

/* ======================= ADD CLASS / ADD PLAYLIST MODALS ======================= */

let spcEditingVideoId = null;

function openSpcClassModal(editId = null, forcedPlaylistId = null) {
  if (!spcPlaylists.length) {
    showToast("Please add a playlist first.", "error");
    openSpcPlaylistModal();
    return;
  }
  spcEditingVideoId = editId;
  const record = editId ? spcVideos.find((v) => v.id === editId) : null;
  document.getElementById("spc-class-modal-title").textContent = record ? "Edit Class" : "Add Class";
  document.getElementById("spc-class-url").value = record?.youtube_url || "";
  document.getElementById("spc-class-title").value = record?.title || "";
  document.getElementById("spc-class-playlist").innerHTML = spcPlaylistOptionsHtml(record?.playlist_id || forcedPlaylistId || spcPlaylists[0].id);
  document.getElementById("spc-class-date").value = record?.class_date || todayLocalDate();
  document.getElementById("spc-class-assigned").checked = !!record?.assigned;
  document.getElementById("spc-class-recommend").value = String(record?.recommend_level ?? 0);
  document.getElementById("spc-class-completion").value = record?.completion_status || "not_started";
  document.getElementById("spc-class-error").classList.add("hidden");
  document.getElementById("spc-class-modal").classList.add("active");
}

function reopenClassModalWithDraft(selectPlaylistId) {
  const draft = spcClassDraft;
  spcClassDraft = null;
  openSpcClassModal();
  if (draft) {
    document.getElementById("spc-class-url").value = draft.url;
    document.getElementById("spc-class-title").value = draft.title;
  }
  if (selectPlaylistId) document.getElementById("spc-class-playlist").value = selectPlaylistId;
}

function wireSpcClassModal() {
  const modal = document.getElementById("spc-class-modal");
  const errorEl = document.getElementById("spc-class-error");

  document.getElementById("spc-class-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("spc-class-new-playlist-btn").onclick = () => {
    spcClassDraft = {
      url: document.getElementById("spc-class-url").value,
      title: document.getElementById("spc-class-title").value,
    };
    modal.classList.remove("active");
    openSpcPlaylistModal();
  };

  document.getElementById("spc-class-save-btn").onclick = async () => {
    const url = document.getElementById("spc-class-url").value.trim();
    const title = document.getElementById("spc-class-title").value.trim();
    const playlistId = document.getElementById("spc-class-playlist").value;
    const date = document.getElementById("spc-class-date").value;
    const assigned = document.getElementById("spc-class-assigned").checked;
    const recommendLevel = Number(document.getElementById("spc-class-recommend").value);
    const completion = document.getElementById("spc-class-completion").value;

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
      assigned,
      recommend_level: recommendLevel,
      completion_status: completion,
    };

    if (spcEditingVideoId) {
      const { error } = await supabase.from("sp_class_videos").update(payload).eq("id", spcEditingVideoId);
      if (error) {
        errorEl.textContent = error.message;
        errorEl.classList.remove("hidden");
        return;
      }
      modal.classList.remove("active");
      showToast("Class updated", "success");
    } else {
      payload.added_by = spcCurrentUser?.user_name || null;
      const { error } = await supabase.from("sp_class_videos").insert(payload);
      if (error) {
        errorEl.textContent = error.message;
        errorEl.classList.remove("hidden");
        return;
      }
      modal.classList.remove("active");
      showToast("Class added", "success");
    }
    await loadSpcData();
    refreshSpcAfterVideoChange();
  };
}

function openSpcPlaylistModal() {
  document.getElementById("spc-playlist-name-input").value = "";
  document.getElementById("spc-playlist-error").classList.add("hidden");
  document.getElementById("spc-playlist-modal").classList.add("active");
}

function wireSpcPlaylistModal() {
  const modal = document.getElementById("spc-playlist-modal");
  const errorEl = document.getElementById("spc-playlist-error");

  const closeAndMaybeResumeClass = () => {
    modal.classList.remove("active");
    if (spcClassDraft) reopenClassModalWithDraft();
  };
  document.getElementById("spc-playlist-cancel-btn").onclick = closeAndMaybeResumeClass;
  modal.addEventListener("click", (e) => { if (e.target === modal) closeAndMaybeResumeClass(); });

  document.getElementById("spc-playlist-save-btn").onclick = async () => {
    const name = document.getElementById("spc-playlist-name-input").value.trim();
    if (!name) {
      errorEl.textContent = "Please enter a playlist name.";
      errorEl.classList.remove("hidden");
      return;
    }
    const { data, error } = await supabase.from("sp_class_playlists").insert({ name }).select().single();
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    spcPlaylists.push(data);
    spcPlaylists.sort((a, b) => a.name.localeCompare(b.name));
    populatePlaylistSelects();
    modal.classList.remove("active");
    showToast("Playlist added", "success");
    if (spcClassDraft) {
      reopenClassModalWithDraft(data.id);
    } else {
      spcSwitchPanel("spc-playlists-panel");
    }
  };
}

/* ======================= QUICK RECOMMEND (from a video's options menu) ======================= */

let spcQuickRecVideoId = null;

function spcCoordinatorCheckboxHtml(u, cls) {
  return `<label class="tag-check" data-name="${escapeHtml((u.user_name || "").toLowerCase())}"><input type="checkbox" class="${cls}" value="${u.id}" /> ${escapeHtml(u.user_name)}</label>`;
}

function openSpcQuickRecommendModal(videoId) {
  const v = spcVideos.find((x) => x.id === videoId);
  if (!v) return;
  spcQuickRecVideoId = videoId;
  document.getElementById("spc-quick-rec-video-title").textContent = `${v.title} — ${v.playlist_name || ""}`;
  document.getElementById("spc-quick-rec-search").value = "";
  document.getElementById("spc-quick-rec-select-all").checked = false;
  const list = document.getElementById("spc-quick-rec-user-list");
  list.innerHTML = spcUsers.length
    ? spcUsers.map((u) => spcCoordinatorCheckboxHtml(u, "spc-quick-rec-user-cb")).join("")
    : `<span class="muted-text">No coordinators found.</span>`;
  document.getElementById("spc-quick-rec-error").classList.add("hidden");
  document.getElementById("spc-quick-rec-modal").classList.add("active");
}

function wireSpcQuickRecommendModal() {
  const modal = document.getElementById("spc-quick-rec-modal");
  const errorEl = document.getElementById("spc-quick-rec-error");

  document.getElementById("spc-quick-rec-cancel-btn").onclick = () => modal.classList.remove("active");
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("active"); });

  document.getElementById("spc-quick-rec-search").addEventListener("input", debounce(() => {
    const term = document.getElementById("spc-quick-rec-search").value.trim().toLowerCase();
    document.querySelectorAll("#spc-quick-rec-user-list label.tag-check").forEach((label) => {
      label.classList.toggle("hidden", !!term && !label.dataset.name.includes(term));
    });
  }, 150));

  document.getElementById("spc-quick-rec-select-all").addEventListener("change", (e) => {
    document.querySelectorAll("#spc-quick-rec-user-list .spc-quick-rec-user-cb").forEach((cb) => {
      if (!cb.closest("label").classList.contains("hidden")) cb.checked = e.target.checked;
    });
  });

  document.getElementById("spc-quick-rec-save-btn").onclick = async () => {
    errorEl.classList.add("hidden");
    const userIds = Array.from(document.querySelectorAll("#spc-quick-rec-user-list .spc-quick-rec-user-cb:checked")).map((cb) => cb.value);
    if (!userIds.length) {
      errorEl.textContent = "Please select at least one coordinator.";
      errorEl.classList.remove("hidden");
      return;
    }
    const payload = userIds.map((user_id) => ({ video_id: spcQuickRecVideoId, user_id, recommended_by: spcCurrentUser?.user_name || null }));
    const { error } = await supabase.from("sp_class_recommendations").insert(payload);
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
      return;
    }
    modal.classList.remove("active");
    showToast(`Recommended to ${userIds.length} coordinator(s)`, "success");
    await reloadSpcRecommendations();
    if (spcActiveTarget() === "spc-recommendations-panel") {
      renderSpcRecHistoryTable();
      applySpcRecHistorySearch();
    }
  };
}

/* ======================= SHARED ======================= */

function populatePlaylistSelects() {
  const dailyFilter = document.getElementById("spc-daily-filter-playlist");
  const prevDaily = dailyFilter.value;
  dailyFilter.innerHTML = `<option value="__ALL__">All</option>` + spcPlaylists.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  dailyFilter.value = prevDaily === "__ALL__" || spcPlaylists.some((p) => p.id === prevDaily) ? prevDaily : "__ALL__";
}

function spcActiveTarget() {
  return document.querySelector("#spclasses-tabs .admin-tab.active")?.dataset.target || "spc-dashboard-panel";
}

function spcSwitchPanel(target) {
  document.querySelectorAll("#spclasses-tabs .admin-tab").forEach((t) => t.classList.toggle("active", t.dataset.target === target));
  document.querySelectorAll("#spclasses-section .fsu-panel").forEach((p) => p.classList.toggle("hidden", p.id !== target));

  if (target === "spc-dashboard-panel") renderSpcDashboard();
  else if (target === "spc-daily-panel") applyDailyFilters();
  else if (target === "spc-playlists-panel") {
    showSpcPlaylistsGrid();
  } else if (target === "spc-recommendations-panel") {
    renderSpcRecHistoryTable();
    applySpcRecHistorySearch();
  } else if (target === "spc-doubts-panel") {
    renderSpcDoubtsTable();
  }
}

async function loadSpcData() {
  const [{ data: playlists, error: pErr }, { data: videos, error: vErr }, { data: users, error: uErr }, { data: recs, error: rErr }, { data: doubts, error: dErr }] = await Promise.all([
    supabase.from("sp_class_playlists").select("id,name").order("name"),
    supabase.from("sp_class_videos")
      .select("id,title,youtube_url,class_date,assigned,recommend_level,completion_status,playlist_id,created_at,sp_class_playlists(name)")
      .order("created_at", { ascending: false }),
    supabase.from("users").select("id,user_name").eq("role", "Coordinator").order("user_name"),
    supabase.from("sp_class_recommendations")
      .select("id,video_id,user_id,recommended_by,recommended_at,sp_class_videos(title,class_date,playlist_id,sp_class_playlists(name)),users(user_name)")
      .order("recommended_at", { ascending: false }),
    supabase.from("sp_class_doubts")
      .select("id,video_id,user_id,timestamp_label,doubt_text,resolved,created_at,sp_class_videos(title,youtube_url),users(user_name)")
      .order("created_at", { ascending: false }),
  ]);
  if (pErr || vErr || uErr || rErr || dErr) {
    showToast("Could not load SP Classes data.", "error");
    return;
  }
  spcPlaylists = playlists || [];
  spcVideos = (videos || []).map((v) => ({ ...v, playlist_name: v.sp_class_playlists?.name || "—" }));
  spcUsers = users || [];
  spcRecommendations = (recs || []).map(mapRecommendationRow);
  spcDoubts = (doubts || []).map(mapDoubtRow);
  populatePlaylistSelects();
}

export async function initSpClasses(currentUser) {
  spcCurrentUser = currentUser;
  if (!spcWired) {
    spcWired = true;
    document.querySelectorAll("#spclasses-tabs .admin-tab").forEach((tab) => {
      tab.addEventListener("click", () => spcSwitchPanel(tab.dataset.target));
    });
    wireSpcDailyPanel();
    wireSpcPlaylistsPanel();
    wireSpcRecommendPanel();
    wireSpcClassModal();
    wireSpcPlaylistModal();
    wireSpcQuickRecommendModal();
    wireSpcDoubtsPanel();
  }
  await loadSpcData();
  spcSwitchPanel("spc-dashboard-panel");
}

/* ======================= USER: Daily Class List & Recommendations =======================
   The regular-user side, wired into the FNRG Sadhana user page
   (fnrg-sadhana-user-section) alongside Enter Sadhana / Analytics. Users see
   the shared class list (read-only, apart from marking their own view of a
   class's completion status — completion_status is a column on the class
   itself, not per-user) and any classes an admin recommended to them. */

let fsuSpcWired = false;
let fsuSpcCurrentUser = null;
let fsuSpcVideos = [];
let fsuSpcPlaylists = [];
let fsuSpcRecs = [];
let fsuSpcDoubts = [];

function fsuDailyRowHtml(v, idx) {
  return `
    <tr data-id="${v.id}">
      <td data-label="S.No">${idx + 1}</td>
      <td data-label="Date">${v.class_date || "—"}</td>
      <td data-label="Title">${escapeHtml(v.title)}</td>
      <td data-label="Link"><a class="cell-chip" href="${safeHref(v.youtube_url)}" target="_blank" rel="noopener">▶ Watch</a></td>
      <td data-label="Playlist">${escapeHtml(v.playlist_name || "—")}</td>
      <td data-label="Recommend Level">${v.recommend_level}</td>
      <td data-label="Completion Status"><select class="inline-edit fsu-completion-select" data-field="completion_status">${spcCompletionOptionsHtml(v.completion_status)}</select></td>
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
      <td data-label="Completion Status"><select class="inline-edit fsu-completion-select" data-field="completion_status">${spcCompletionOptionsHtml(r.completion_status)}</select></td>
    </tr>`;
}

function wireFsuCompletionSelects(tbody, cache) {
  tbody.querySelectorAll(".fsu-completion-select").forEach((el) => {
    el.addEventListener("change", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      const record = cache.find((x) => (x.id || x.video_id) === id);
      const value = e.target.value;
      const { error } = await supabase.from("sp_class_videos").update({ completion_status: value }).eq("id", id);
      if (error) {
        showToast("Update failed: " + error.message, "error");
        e.target.value = record?.completion_status || "not_started";
        return;
      }
      if (record) record.completion_status = value;
      // The same class can appear in both the daily list and the
      // recommendations list — keep whichever cache didn't just save in sync.
      [fsuSpcVideos, fsuSpcRecs].forEach((list) => {
        const other = list.find((x) => (x.id || x.video_id) === id);
        if (other) other.completion_status = value;
      });
    });
  });
}

function populateFsuDailyPlaylistFilter() {
  const sel = document.getElementById("fsu-daily-filter-playlist");
  const prev = sel.value;
  sel.innerHTML = `<option value="__ALL__">All</option>` + fsuSpcPlaylists.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  sel.value = prev === "__ALL__" || fsuSpcPlaylists.some((p) => p.id === prev) ? prev : "__ALL__";
}

function applyFsuDailyFilters() {
  const term = document.getElementById("fsu-daily-search").value.trim().toLowerCase();
  const playlistFilter = document.getElementById("fsu-daily-filter-playlist").value;
  const completionFilter = document.getElementById("fsu-daily-filter-completion").value;

  let rows = fsuSpcVideos.filter((v) => !term || String(v.title || "").toLowerCase().includes(term));
  if (playlistFilter !== "__ALL__") rows = rows.filter((v) => v.playlist_id === playlistFilter);
  if (completionFilter !== "__ALL__") rows = rows.filter((v) => v.completion_status === completionFilter);
  rows = sortByDateDesc(rows);

  const tbody = document.getElementById("fsu-daily-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">${fsuSpcVideos.length ? "No classes match your filters." : "No classes yet."}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((v, idx) => fsuDailyRowHtml(v, idx)).join("");
  wireFsuCompletionSelects(tbody, fsuSpcVideos);
}

function renderFsuRecTable() {
  const tbody = document.getElementById("fsu-rec-body");
  if (!fsuSpcRecs.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-text">No classes have been recommended to you yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = fsuSpcRecs.map(fsuRecRowHtml).join("");
  wireFsuCompletionSelects(tbody, fsuSpcRecs);
}

async function loadFsuSpData(userId) {
  const [{ data: playlists, error: pErr }, { data: videos, error: vErr }, { data: recs, error: rErr }, { data: doubts, error: dErr }] = await Promise.all([
    supabase.from("sp_class_playlists").select("id,name").order("name"),
    supabase.from("sp_class_videos")
      .select("id,title,youtube_url,class_date,recommend_level,completion_status,playlist_id,sp_class_playlists(name)")
      .order("class_date", { ascending: false }),
    supabase.from("sp_class_recommendations")
      .select("video_id,recommended_by,recommended_at,sp_class_videos(title,youtube_url,class_date,completion_status,sp_class_playlists(name))")
      .eq("user_id", userId)
      .order("recommended_at", { ascending: false }),
    supabase.from("sp_class_doubts")
      .select("id,timestamp_label,doubt_text,resolved,created_at,sp_class_videos(title)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
  ]);
  if (pErr || vErr || rErr || dErr) {
    showToast("Could not load classes.", "error");
    return;
  }
  fsuSpcDoubts = (doubts || []).map((d) => ({
    id: d.id,
    timestamp_label: d.timestamp_label,
    doubt_text: d.doubt_text,
    resolved: d.resolved,
    created_at: d.created_at,
    title: d.sp_class_videos?.title || "—",
  }));
  fsuSpcPlaylists = playlists || [];
  fsuSpcVideos = (videos || []).map((v) => ({ ...v, playlist_name: v.sp_class_playlists?.name || "—" }));

  const seen = new Set();
  fsuSpcRecs = [];
  (recs || []).forEach((r) => {
    if (seen.has(r.video_id)) return; // rows arrive latest-first, so the first hit per class is the most recent recommendation
    seen.add(r.video_id);
    fsuSpcRecs.push({
      video_id: r.video_id,
      recommended_by: r.recommended_by,
      recommended_at: r.recommended_at,
      title: r.sp_class_videos?.title || "—",
      youtube_url: r.sp_class_videos?.youtube_url || "",
      class_date: r.sp_class_videos?.class_date || null,
      completion_status: r.sp_class_videos?.completion_status || "not_started",
      playlist_name: r.sp_class_videos?.sp_class_playlists?.name || "—",
    });
  });
}

/* ======================= USER: Ask a Doubt ======================= */

function fsuDoubtClassOptionsHtml() {
  return sortByDateDesc(fsuSpcVideos).map((v) => `<option value="${v.id}">${escapeHtml(v.title)} — ${escapeHtml(v.playlist_name || "—")}</option>`).join("");
}

function populateFsuDoubtClassSelect() {
  const sel = document.getElementById("fsu-doubt-class-select");
  const prev = sel.value;
  sel.innerHTML = fsuSpcVideos.length ? fsuDoubtClassOptionsHtml() : `<option value="">No classes yet</option>`;
  if (fsuSpcVideos.some((v) => v.id === prev)) sel.value = prev;
}

function renderFsuDoubtsTable() {
  const tbody = document.getElementById("fsu-doubts-body");
  if (!fsuSpcDoubts.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted-text">You haven't asked any doubts yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = fsuSpcDoubts.map((d) => `
    <tr>
      <td data-label="Asked At">${new Date(d.created_at).toLocaleString()}</td>
      <td data-label="Class">${escapeHtml(d.title)}</td>
      <td data-label="Timing">${escapeHtml(d.timestamp_label)}</td>
      <td data-label="Doubt">${escapeHtml(d.doubt_text)}</td>
      <td data-label="Status"><span class="spc-badge ${d.resolved ? "completed" : "not_started"}">${d.resolved ? "Resolved" : "Pending"}</span></td>
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

    const { error } = await supabase.from("sp_class_doubts").insert({
      video_id: videoId,
      user_id: fsuSpcCurrentUser?.id,
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
    await loadFsuSpData(fsuSpcCurrentUser.id);
    renderFsuDoubtsTable();
  });
}

export async function initFsuSpClasses(currentUser) {
  fsuSpcCurrentUser = currentUser;
  if (!fsuSpcWired) {
    fsuSpcWired = true;
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
