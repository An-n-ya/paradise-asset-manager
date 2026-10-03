const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "flac"];
const VIDEO_EXT = ["mp4", "webm", "mov"];

const NAV = [
  {
    group: "游戏数据",
    items: [
      { view: "characters", label: "角色", icon: "👤", kind: "characters" },
      { view: "scene", label: "场景", icon: "▧", kind: "assets", type: "scene" },
      { view: "dataset", label: "数据集", icon: "▤", kind: "assets", type: "dataset" },
    ],
  },
  {
    group: "音频",
    items: [
      { view: "bgm", label: "BGM", icon: "♪", kind: "assets", type: "bgm" },
      { view: "se", label: "音效", icon: "◔", kind: "assets", type: "se" },
      { view: "voice", label: "语音", icon: "◍", kind: "assets", type: "voice" },
    ],
  },
  {
    group: "资源管理",
    items: [
      { view: "dynamic", label: "动态图像", icon: "◈", kind: "assets", type: "dynamic" },
      { view: "bucket", label: "资源总览", icon: "☰", kind: "bucket" },
    ],
  },
];

const NAV_ITEMS = NAV.reduce(function (all, group) {
  return all.concat(group.items);
}, []);

const state = {
  tab: "assets",
  view: "characters",
  search: "",
  status: null,
  characters: [],
  assets: [],
  objects: [],
  detail: null,
  selectedCharacterId: null,
  selectedAssetId: null,
  selectedExpressionId: null,
  selectedObjectKey: null,
  script: null,
  scriptDoc: null,
  scriptDocFile: null,
  scriptLabelId: null,
  scriptSearch: "",
};

let pendingUpload = null;
let cropAbort = null;
let scriptEls = null;
let scriptSaveTimer = null;
let scriptDirty = false;
let scriptStatus = { text: "就绪", cls: "" };
let blockSeq = 0;
let blockMenuEl = null;
let blockMenuCtx = null;
let blockMenuItems = [];
let blockMenuShown = [];
let blockMenuActive = 0;
let blockMenuQuery = "";
let listFocusPending = false;
let scriptFocusPending = false;

const el = {
  topTabs: document.getElementById("top-tabs"),
  viewAssets: document.getElementById("view-assets"),
  viewScript: document.getElementById("view-script"),
  nav: document.getElementById("nav"),
  listTitle: document.getElementById("list-title"),
  listCount: document.getElementById("list-count"),
  listTotal: document.getElementById("list-total"),
  addBtn: document.getElementById("add-btn"),
  searchInput: document.getElementById("search-input"),
  list: document.getElementById("list"),
  detail: document.getElementById("detail"),
  cosDot: document.getElementById("cos-dot"),
  cosLabel: document.getElementById("cos-label"),
  toast: document.getElementById("toast"),
  uploadOverlay: document.getElementById("upload-overlay"),
  uploadTitle: document.getElementById("upload-title"),
  uploadSub: document.getElementById("upload-sub"),
  uploadSteps: document.getElementById("upload-steps"),
  uploadBar: document.getElementById("upload-bar"),
  uploadBarFill: document.getElementById("upload-bar-fill"),
  dropHint: document.getElementById("drop-hint"),
  fileInput: document.getElementById("file-input"),
};

function currentNav() {
  return NAV_ITEMS.find(function (item) { return item.view === state.view; });
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extOf(key) {
  const name = String(key || "");
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function categoryOf(key) {
  const ext = extOf(key);
  if (IMAGE_EXT.includes(ext)) return "image";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (VIDEO_EXT.includes(ext)) return "video";
  return "file";
}

function iconFor(key) {
  const c = categoryOf(key);
  if (c === "image") return "▧";
  if (c === "audio") return "♪";
  if (c === "video") return "◈";
  return "▤";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function parseCrop(value) {
  if (!value) return null;
  let obj = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch (e) {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const nums = [obj.x, obj.y, obj.w, obj.h].map(Number);
  if (!nums.every(function (n) { return isFinite(n); })) return null;
  const x = clamp(nums[0], 0, 1);
  const y = clamp(nums[1], 0, 1);
  const w = clamp(nums[2], 0, 1);
  const h = clamp(nums[3], 0, 1);
  if (w <= 0 || h <= 0) return null;
  return { x: x, y: y, w: w, h: h };
}

function serializeCrop(crop) {
  if (!crop) return "";
  return JSON.stringify({
    x: round4(crop.x),
    y: round4(crop.y),
    w: round4(crop.w),
    h: round4(crop.h),
  });
}

function avatarImgHtml(url, crop) {
  if (!url) return "";
  if (!crop) {
    return '<img class="avatar-img plain" src="' + escapeHtml(url) + '" alt="" />';
  }
  const left = (-crop.x / crop.w) * 100;
  const top = (-crop.y / crop.h) * 100;
  const width = (1 / crop.w) * 100;
  const height = (1 / crop.h) * 100;
  return (
    '<img class="avatar-img crop" src="' + escapeHtml(url) + '" alt="" style="' +
    "left:" + left.toFixed(4) + "%;" +
    "top:" + top.toFixed(4) + "%;" +
    "width:" + width.toFixed(4) + "%;" +
    "height:" + height.toFixed(4) + '%;" />'
  );
}

function cropRectStyle(crop) {
  if (!crop) return "display:none;";
  return (
    "left:" + (crop.x * 100).toFixed(4) + "%;" +
    "top:" + (crop.y * 100).toFixed(4) + "%;" +
    "width:" + (crop.w * 100).toFixed(4) + "%;" +
    "height:" + (crop.h * 100).toFixed(4) + "%;"
  );
}

const CROP_SIDE_RATIO = 0.44;
const CROP_CENTER_Y = 0.24;

function defaultCrop(naturalWidth, naturalHeight) {
  const nw = naturalWidth || 1;
  const nh = naturalHeight || 1;
  const side = Math.min(nw, nh) * CROP_SIDE_RATIO;
  const w = round4(clamp(side / nw, 0.05, 1));
  const h = round4(clamp(side / nh, 0.05, 1));
  return {
    x: round4((1 - w) / 2),
    y: round4(clamp(CROP_CENTER_Y - h / 2, 0, 1 - h)),
    w: w,
    h: h,
  };
}

function humanSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function sizeText(bytes) {
  return bytes > 0 ? humanSize(bytes) : "—";
}

let toastTimer = null;
let toastActionHandler = null;

function dismissToast() {
  clearTimeout(toastTimer);
  toastActionHandler = null;
  el.toast.className = "toast";
}

function toast(message, options) {
  if (typeof options === "boolean") options = { error: options };
  options = options || {};
  const isError = !!options.error;
  const action = options.action;

  el.toast.textContent = "";
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  el.toast.appendChild(msg);

  toastActionHandler = null;
  if (action && action.label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", function () {
      const handler = toastActionHandler;
      dismissToast();
      if (typeof handler === "function") handler();
    });
    toastActionHandler = typeof action.onClick === "function" ? action.onClick : null;
    el.toast.appendChild(btn);
  }

  el.toast.className = "toast show" + (isError ? " err" : "");
  clearTimeout(toastTimer);
  const duration = options.duration || (action ? 6500 : 2400);
  toastTimer = setTimeout(dismissToast, duration);
}

let confirmNode = null;

function confirmAction(options) {
  options = options || {};
  if (!confirmNode) confirmNode = document.getElementById("confirm-dialog");
  const title = options.title || "确认操作";
  const text = options.text || "";
  const okText = options.okText || "确定";
  const danger = options.danger !== false;

  if (!confirmNode || typeof confirmNode.showModal !== "function") {
    const plain = text ? title + "\n\n" + text : title;
    return Promise.resolve(window.confirm(plain));
  }

  const titleEl = document.getElementById("confirm-title");
  const textEl = document.getElementById("confirm-text");
  const okEl = document.getElementById("confirm-ok");
  if (titleEl) titleEl.textContent = title;
  if (textEl) {
    textEl.textContent = text;
    textEl.hidden = !text;
  }
  if (okEl) {
    okEl.textContent = okText;
    okEl.classList.toggle("danger", danger);
  }
  confirmNode.classList.toggle("danger", danger);

  return new Promise(function (resolve) {
    let settled = false;
    function onClose() {
      if (settled) return;
      settled = true;
      confirmNode.removeEventListener("close", onClose);
      resolve(confirmNode.returnValue === "confirm");
    }
    confirmNode.returnValue = "";
    confirmNode.addEventListener("close", onClose);
    confirmNode.showModal();
  });
}

let uploadStepsState = [];

function renderUploadSteps() {
  if (!el.uploadSteps) return;
  if (!uploadStepsState.length) {
    el.uploadSteps.hidden = true;
    el.uploadSteps.innerHTML = "";
    return;
  }
  el.uploadSteps.hidden = false;
  el.uploadSteps.innerHTML = uploadStepsState
    .map(function (step) {
      let cls = "upload-step";
      if (step.state === "done") cls += " done";
      else if (step.state === "current") cls += " current";
      return (
        '<div class="' + cls + '"><span class="step-dot" aria-hidden="true"></span>' +
        "<span>" + escapeHtml(step.label) + "</span></div>"
      );
    })
    .join("");
}

function setUploadSteps(labels) {
  uploadStepsState = (labels || []).map(function (label, index) {
    return { label: label, state: index === 0 ? "current" : "todo" };
  });
  renderUploadSteps();
}

function setUploadStep(index) {
  uploadStepsState.forEach(function (step, i) {
    step.state = i < index ? "done" : i === index ? "current" : "todo";
  });
  renderUploadSteps();
}

function finishUploadSteps() {
  uploadStepsState.forEach(function (step) { step.state = "done"; });
  renderUploadSteps();
}

function setUploadProgress(pct, indeterminate) {
  if (!el.uploadBar || !el.uploadBarFill) return;
  if (indeterminate) {
    el.uploadBar.classList.add("upload-indeterminate");
    el.uploadBar.removeAttribute("aria-valuenow");
    return;
  }
  el.uploadBar.classList.remove("upload-indeterminate");
  const value = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  el.uploadBar.setAttribute("aria-valuenow", String(value));
  el.uploadBarFill.style.width = value + "%";
}

function showUploadOverlay(title, sub, steps) {
  el.uploadTitle.textContent = title || "正在上传…";
  el.uploadSub.textContent = sub || "";
  setUploadSteps(steps || []);
  setUploadProgress(0, false);
  el.uploadOverlay.hidden = false;
}

function updateUploadOverlay(title, sub) {
  if (title !== undefined) el.uploadTitle.textContent = title;
  if (sub !== undefined) el.uploadSub.textContent = sub;
}

function hideUploadOverlay() {
  el.uploadOverlay.hidden = true;
  uploadStepsState = [];
  renderUploadSteps();
}

async function api(path, options) {
  const opts = options || {};
  const init = { headers: {} };
  if (opts.method) init.method = opts.method;
  if (opts.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = text; }
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error : "请求失败 (" + res.status + ")";
    throw new Error(msg);
  }
  return data;
}

function dirForType(type) {
  if (type === "bgm" || type === "se" || type === "voice") return "audio/";
  if (type === "dataset") return "data/";
  return "images/";
}

function safeFileName(name) {
  return String(name || "file").replace(/[\\/]+/g, "_").replace(/\s+/g, " ").trim();
}

function putToCos(url, file, contentType, onProgress) {
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("content-type", contentType);
    if (onProgress) {
      xhr.upload.onprogress = function (event) {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
    }
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("上传失败 (" + xhr.status + ")"));
    };
    xhr.onerror = function () { reject(new Error("上传失败（网络错误）")); };
    xhr.send(file);
  });
}

async function uploadToCos(file, relativeKey, onProgress) {
  const contentType = file.type || "application/octet-stream";
  const info = await api("/api/cos/presign-upload", {
    method: "POST",
    body: { key: relativeKey, contentType: contentType },
  });
  await putToCos(info.url, file, contentType, onProgress);
  return info;
}

/* ---------------------------- data ---------------------------- */

async function refreshData() {
  const results = await Promise.all([
    api("/api/status"),
    api("/api/characters"),
    api("/api/assets"),
    state.view === "bucket" ? api("/api/cos/objects") : Promise.resolve(null),
  ]);
  state.status = results[0];
  state.characters = results[1];
  state.assets = results[2];
  if (results[3]) state.objects = results[3];
  renderNav();
  renderList();
}

async function selectCharacter(id) {
  state.selectedCharacterId = id;
  state.selectedAssetId = null;
  state.selectedObjectKey = null;
  state.detail = await api("/api/characters/" + id);
  const list = (state.detail && state.detail.expressions) || [];
  const kept = list.some(function (e) { return e.id === state.selectedExpressionId; });
  if (!kept) state.selectedExpressionId = list.length ? list[0].id : null;
  renderList();
  renderDetail();
}

function selectAsset(id) {
  state.selectedAssetId = id;
  state.selectedCharacterId = null;
  state.selectedObjectKey = null;
  state.detail = null;
  renderList();
  renderDetail();
}

function selectObject(key) {
  state.selectedObjectKey = key;
  state.selectedCharacterId = null;
  state.selectedAssetId = null;
  state.detail = null;
  renderList();
  renderDetail();
}

/* ---------------------------- nav ---------------------------- */

function countFor(item) {
  if (item.kind === "characters") {
    return state.characters.length;
  }
  if (item.kind === "assets") {
    return state.assets.filter(function (a) { return a.type === item.type; }).length;
  }
  if (item.kind === "bucket") {
    return state.objects.length;
  }
  return 0;
}

function renderNav() {
  el.nav.innerHTML = NAV.map(function (group) {
    const items = group.items.map(function (item) {
      const active = item.view === state.view;
      return (
        '<button class="nav-item' + (active ? " active" : "") + '" data-view="' + item.view + '"' +
          (active ? ' aria-current="page"' : "") + '>' +
          '<span class="nav-icon" aria-hidden="true">' + item.icon + "</span>" +
          '<span class="nav-label">' + escapeHtml(item.label) + "</span>" +
          '<span class="nav-count">' + countFor(item) + "</span>" +
        "</button>"
      );
    }).join("");
    return (
      '<div class="nav-group">' +
        '<div class="nav-group-title">' + escapeHtml(group.group) + "</div>" +
        items +
      "</div>"
    );
  }).join("");

  applyNavRoving();

  const ready = state.status && state.status.cos && state.status.cos.ready;
  el.cosDot.className = "status-dot " + (ready ? "on" : "off");
  el.cosLabel.textContent = ready ? "COS 已连接" : "COS 未配置";
}

/* ---------------------------- list ---------------------------- */

function matchSearch(text) {
  if (!state.search) return true;
  return String(text || "").toLowerCase().indexOf(state.search.toLowerCase()) !== -1;
}

function rowThumb(key, url, crop) {
  if (url && categoryOf(key) === "image") {
    return '<div class="row-thumb">' + avatarImgHtml(url, crop) + "</div>";
  }
  return '<div class="row-thumb">' + iconFor(key) + "</div>";
}

function emptyStateHtml(nav) {
  if (state.search) {
    return (
      '<div class="empty-state compact">' +
        '<div class="empty-icon" aria-hidden="true">⌕</div>' +
        '<div class="empty-title">未找到匹配项</div>' +
        '<div class="empty-desc">没有与「' + escapeHtml(state.search) + '」相关的结果，试试其他关键词。</div>' +
      "</div>"
    );
  }
  if (nav.kind === "characters") {
    return (
      '<div class="empty-state">' +
        '<div class="empty-icon" aria-hidden="true">' + nav.icon + "</div>" +
        '<div class="empty-title">还没有角色</div>' +
        '<div class="empty-desc">点击右上角 <span class="kbd">+</span> 新建角色，再为它添加表情差分。</div>' +
      "</div>"
    );
  }
  if (nav.kind === "bucket") {
    return (
      '<div class="empty-state">' +
        '<div class="empty-icon" aria-hidden="true">' + nav.icon + "</div>" +
        '<div class="empty-title">对象存储为空</div>' +
        '<div class="empty-desc">当前前缀下没有任何对象。</div>' +
      "</div>"
    );
  }
  return (
    '<div class="empty-state">' +
      '<div class="empty-icon" aria-hidden="true">' + nav.icon + "</div>" +
      '<div class="empty-title">还没有' + escapeHtml(nav.label) + "</div>" +
      '<div class="empty-desc">点击右上角 <span class="kbd">+</span> 新建，或直接把文件拖到这里上传。</div>' +
    "</div>"
  );
}

function skeletonHtml(count) {
  let rows = "";
  for (let i = 0; i < count; i += 1) {
    rows +=
      '<div class="skel-row">' +
        '<div class="skel-thumb skeleton"></div>' +
        '<div class="skel-lines">' +
          '<div class="skel-line skeleton w-70"></div>' +
          '<div class="skel-line skeleton w-45"></div>' +
        "</div>" +
      "</div>";
  }
  return '<div class="pane-skeleton" aria-hidden="true">' + rows + "</div>";
}

function showListSkeleton(count) {
  el.list.setAttribute("aria-busy", "true");
  el.list.innerHTML = skeletonHtml(count || 7);
  el.listCount.textContent = "…";
  el.listTotal.hidden = true;
}

function showDetailSkeleton() {
  el.detail.innerHTML = skeletonHtml(4);
}

function listErrorHtml(message) {
  return (
    '<div class="empty-state is-error">' +
      '<div class="empty-icon" aria-hidden="true">!</div>' +
      '<div class="empty-title">加载失败</div>' +
      '<div class="empty-desc">' + escapeHtml(message || "无法连接到服务，请稍后重试。") + "</div>" +
      '<button class="btn small empty-action" data-act="retry-load">重试</button>' +
    "</div>"
  );
}

function renderList() {
  const nav = currentNav();
  el.listTitle.textContent = nav.label;

  let rows = "";
  let count = 0;
  let totalBytes = 0;
  const addVisible = nav.kind !== "bucket";
  el.addBtn.style.display = addVisible ? "" : "none";

  if (nav.kind === "characters") {
    const items = state.characters.filter(function (c) {
      return matchSearch(c.name) || matchSearch(c.display_name);
    });
    count = items.length;
    rows = items.map(function (c) {
      const active = c.id === state.selectedCharacterId ? " active" : "";
      const missing = c.expression_count === 0
        ? '<span class="row-badge">无表情</span>' : "";
      return (
        '<div class="row' + active + '" data-row="character" data-id="' + c.id + '">' +
          rowThumb(c.avatar_key, c.avatarPreviewUrl || c.avatarUrl, parseCrop(c.avatar_crop)) +
          '<div class="row-main">' +
            '<div class="row-name">' + escapeHtml(c.display_name || c.name) + "</div>" +
            '<div class="row-sub">' + c.expression_count + " 个表情</div>" +
          "</div>" + missing +
        "</div>"
      );
    }).join("");
  } else if (nav.kind === "assets") {
    const items = state.assets.filter(function (a) {
      return a.type === nav.type && (matchSearch(a.name) || matchSearch(a.asset_key));
    });
    count = items.length;
    rows = items.map(function (a) {
      const active = a.id === state.selectedAssetId ? " active" : "";
      totalBytes += (a.size || 0) + (a.previewSize || 0);
      const sizeLabel = a.size ? " · " + humanSize(a.size) : "";
      return (
        '<div class="row' + active + '" data-row="asset" data-id="' + a.id + '">' +
          rowThumb(a.asset_key, a.previewUrl || a.url) +
          '<div class="row-main">' +
            '<div class="row-name">' + escapeHtml(a.name) + "</div>" +
            '<div class="row-sub">' + escapeHtml(a.asset_key || "未设置资源") + sizeLabel + "</div>" +
          "</div>" +
        "</div>"
      );
    }).join("");
  } else {
    const items = state.objects.filter(function (o) {
      return matchSearch(o.relativeKey);
    });
    count = items.length;
    rows = items.map(function (o) {
      const active = o.relativeKey === state.selectedObjectKey ? " active" : "";
      totalBytes += o.size || 0;
      return (
        '<div class="row' + active + '" data-row="object" data-key="' + escapeHtml(o.relativeKey) + '">' +
          rowThumb(o.relativeKey, o.previewUrl || o.url) +
          '<div class="row-main">' +
            '<div class="row-name">' + escapeHtml(o.relativeKey) + "</div>" +
            '<div class="row-sub">' + humanSize(o.size) + "</div>" +
          "</div>" +
        "</div>"
      );
    }).join("");
  }

  el.listCount.textContent = String(count);
  if (totalBytes > 0) {
    el.listTotal.textContent = "占用 " + humanSize(totalBytes);
    el.listTotal.hidden = false;
  } else {
    el.listTotal.hidden = true;
  }
  el.list.removeAttribute("aria-busy");
  el.list.innerHTML = rows || emptyStateHtml(nav);
  syncListRoving();
}

function listRows() {
  return Array.prototype.slice.call(el.list.querySelectorAll("[data-row]"));
}

function syncListRoving() {
  applyRoving(el.list, "[data-row]");
  if (listFocusPending) {
    listFocusPending = false;
    const active = el.list.querySelector("[data-row].active") || listRows()[0];
    if (active) active.focus();
  }
}

function applyRoving(container, itemSelector) {
  if (!container) return;
  const items = Array.prototype.slice.call(container.querySelectorAll(itemSelector));
  if (!items.length) return;
  let activeIdx = -1;
  items.forEach(function (node, i) {
    if (node.classList.contains("active")) activeIdx = i;
  });
  if (activeIdx === -1) activeIdx = 0;
  items.forEach(function (node, i) {
    node.setAttribute("role", "option");
    node.setAttribute("aria-selected", node.classList.contains("active") ? "true" : "false");
    node.tabIndex = i === activeIdx ? 0 : -1;
  });
}

function applyNavRoving() {
  if (!el.nav) return;
  const items = Array.prototype.slice.call(el.nav.querySelectorAll("[data-view]"));
  if (!items.length) return;
  let activeIdx = 0;
  items.forEach(function (node, i) {
    if (node.classList.contains("active")) activeIdx = i;
  });
  items.forEach(function (node, i) { node.tabIndex = i === activeIdx ? 0 : -1; });
}

function focusRovingItem(container, itemSelector, node) {
  const items = Array.prototype.slice.call(container.querySelectorAll(itemSelector));
  items.forEach(function (n) { n.tabIndex = n === node ? 0 : -1; });
  if (node) node.focus();
}

function activateListRow(row) {
  if (!row) return;
  const kind = row.dataset.row;
  if (kind === "character") {
    if (Number(row.dataset.id) !== state.selectedCharacterId) {
      listFocusPending = true;
      selectCharacter(Number(row.dataset.id)).catch(function (e) { toast(e.message, true); });
    }
  } else if (kind === "asset") {
    if (Number(row.dataset.id) !== state.selectedAssetId) {
      listFocusPending = true;
      selectAsset(Number(row.dataset.id));
    }
  } else if (kind === "object") {
    if (row.dataset.key !== state.selectedObjectKey) {
      listFocusPending = true;
      selectObject(row.dataset.key);
    }
  }
}

function focusablesIn(container, selector) {
  if (!container) return [];
  return Array.prototype.slice.call(container.querySelectorAll(selector));
}

function focusByIndex(items, index) {
  if (!items.length) return;
  const next = Math.max(0, Math.min(items.length - 1, index));
  items.forEach(function (node, i) { node.tabIndex = i === next ? 0 : -1; });
  items[next].focus();
}

function moveRovingFocus(event, container, selector) {
  const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];
  if (keys.indexOf(event.key) === -1) return false;
  const items = focusablesIn(container, selector);
  if (!items.length) return false;
  let index = items.indexOf(document.activeElement);
  if (index === -1) index = 0;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") index += 1;
  else if (event.key === "ArrowUp" || event.key === "ArrowLeft") index -= 1;
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = items.length - 1;
  event.preventDefault();
  focusByIndex(items, index);
  return true;
}

function isActivationKey(event) {
  return event.key === "Enter" || event.key === " " || event.key === "Spacebar";
}

function selectExpressionRow(eid, focusField) {
  if (eid == null) return;
  if (eid === state.selectedExpressionId) return;
  state.selectedExpressionId = eid;
  renderDetail();
  if (focusField) {
    const input = el.detail.querySelector(
      '[data-exp-row][data-exp-id="' + eid + '"] [data-exp-field="' + focusField + '"]'
    );
    if (input) input.focus();
  }
}

function syncExpressionRoving() {
  const rows = focusablesIn(el.detail, "[data-exp-row]");
  if (!rows.length) return;
  let activeIdx = -1;
  rows.forEach(function (node, i) { if (node.classList.contains("active")) activeIdx = i; });
  if (activeIdx === -1) activeIdx = 0;
  rows.forEach(function (node, i) {
    node.setAttribute("role", "group");
    node.setAttribute("aria-current", node.classList.contains("active") ? "true" : "false");
    node.tabIndex = i === activeIdx ? 0 : -1;
  });
}

/* ---------------------------- detail ---------------------------- */

function previewHtml(key, url, previewUrl, opts) {
  opts = opts || {};
  if (!key) return '<div class="preview-empty">未设置资源</div>';
  const c = categoryOf(key);
  if (c === "image") {
    const src = previewUrl || url;
    return src ? '<img src="' + escapeHtml(src) + '" alt="" />'
      : '<div class="preview-empty">资源不可预览</div>';
  }
  if (c === "audio") {
    const src = opts.audioUrl || url;
    let html = src ? '<audio controls src="' + escapeHtml(src) + '"></audio>'
      : '<div class="preview-empty">资源不可预览</div>';
    if (opts.downloadUrl) {
      html += '<div class="preview-actions">' +
        '<a class="btn small" href="' + escapeHtml(opts.downloadUrl) + '" download="' + escapeHtml(opts.downloadName || "audio") + '">下载原音频</a>' +
        "</div>";
    }
    return html;
  }
  if (c === "video") {
    return url ? '<video controls src="' + escapeHtml(url) + '"></video>'
      : '<div class="preview-empty">资源不可预览</div>';
  }
  return url
    ? '<a class="tag" href="' + escapeHtml(url) + '" target="_blank">下载 / 打开资源</a>'
    : '<div class="preview-empty">未设置资源</div>';
}

function detailHeadAvatar(key, url, crop, cropTarget) {
  const isImage = !!(url && categoryOf(key) === "image");
  const inner = isImage ? avatarImgHtml(url, crop) : iconFor(key);
  if (cropTarget && isImage) {
    return (
      '<button type="button" class="detail-avatar detail-avatar-btn" data-act="open-crop" data-id="' +
      cropTarget.id + '" title="剪裁对白头像" aria-label="剪裁对白头像">' +
        inner +
        '<span class="avatar-edit-hint" aria-hidden="true">剪裁</span>' +
      "</button>"
    );
  }
  return '<div class="detail-avatar">' + inner + "</div>";
}

function diffEditorHtml(c, expressions, selExp) {
  const activeKey = selExp && selExp.asset_key ? selExp.asset_key : c.avatar_key;
  const imgUrl = (selExp && (selExp.previewUrl || selExp.url)) || c.avatarPreviewUrl || c.avatarUrl;
  const hasImage = imgUrl && categoryOf(activeKey) === "image";
  const crop = parseCrop(c.avatar_crop);
  const avatarUrl = c.avatarPreviewUrl || c.avatarUrl || "";
  const fileName = activeKey ? activeKey.split("/").pop() : "";
  const selId = state.selectedExpressionId || "";
  const disabled = state.selectedExpressionId ? "" : " disabled";

  const stage = hasImage
    ? '<div class="crop-stage is-static">' +
        '<img class="crop-source" src="' + escapeHtml(imgUrl) + '" alt="" />' +
      "</div>"
    : '<div class="preview-box">' + previewHtml(c.avatar_key, c.avatarUrl, c.avatarPreviewUrl) + "</div>";

  return (
    '<div class="diff-editor">' +
      '<aside class="diff-lists">' +
        '<div class="diff-pane-head"><span class="diff-pane-title">对白头像</span></div>' +
        '<div class="exp-list">' + (expressions || '<div class="list-empty">暂无表情</div>') + "</div>" +
        '<button class="diff-add" data-act="add-expression" data-id="' + c.id + '">+ 添加表情</button>' +
      "</aside>" +
      '<div class="diff-stage-pane">' +
        '<div class="diff-pane-head">' +
          '<span class="diff-pane-title">原图</span>' +
          (fileName ? '<span class="diff-file-name">' + escapeHtml(fileName) + "</span>" : "") +
        "</div>" +
        '<div class="diff-stage-body">' + stage + "</div>" +
      "</div>" +
      '<aside class="diff-side">' +
        '<div class="diff-block">' +
          '<div class="diff-block-title">对白头像</div>' +
          '<div class="crop-preview-box">' + avatarImgHtml(avatarUrl, crop) + "</div>" +
          '<div class="diff-block-hint">点击上方角色头像可剪裁</div>' +
          '<button class="btn small" data-act="upload-character-avatar" data-id="' + c.id + '">选择图片</button>' +
        "</div>" +
        '<div class="diff-block">' +
          '<div class="diff-block-title">资源操作</div>' +
          '<button class="btn small" data-act="upload-expression" data-id="' + selId + '"' + disabled + '>替换图片</button>' +
          '<button class="btn danger small" data-act="delete-expression" data-id="' + selId + '"' + disabled + '>删除表情</button>' +
        "</div>" +
      "</aside>" +
    "</div>"
  );
}

function expressionRowHtml(e, crop, index) {
  const src = e.previewUrl || e.url;
  const thumb = src && categoryOf(e.asset_key) === "image"
    ? avatarImgHtml(src, crop)
    : iconFor(e.asset_key);
  const active = e.id === state.selectedExpressionId ? " active" : "";
  const badge = index === 0 ? '<span class="exp-badge">默认</span>' : "";
  return (
    '<div class="exp-item' + active + '" data-exp-row data-exp-id="' + e.id + '">' +
      '<div class="exp-thumb">' + thumb + "</div>" +
      '<div class="exp-main">' +
        '<input class="exp-name" data-exp-field="name" value="' + escapeHtml(e.name) + '" placeholder="表情名" />' +
        '<input class="exp-key" data-exp-field="asset_key" value="' + escapeHtml(e.asset_key) + '" placeholder="资源键" />' +
      "</div>" + badge +
    "</div>"
  );
}

function renderCharacterDetail() {
  const d = state.detail;
  if (!d) return '<div class="detail-empty">从左侧选择一个角色</div>';
  const c = d.character;

  const crop = parseCrop(c.avatar_crop);

  const expressions = d.expressions.map(function (e, index) {
    return expressionRowHtml(e, crop, index);
  }).join("");
  const selExp = d.expressions.find(function (e) { return e.id === state.selectedExpressionId; }) || null;

  return (
    '<div class="detail-head">' +
      detailHeadAvatar(c.avatar_key, c.avatarPreviewUrl || c.avatarUrl, crop, { id: c.id }) +
      '<div class="detail-head-main">' +
        "<h2>" + escapeHtml(c.display_name || c.name) + "</h2>" +
        '<div class="detail-head-sub">' + d.expressions.length + " 个表情</div>" +
      "</div>" +
      '<div class="detail-head-actions">' +
        '<button class="btn danger" data-act="delete-character" data-id="' + c.id + '">删除角色</button>' +
        '<button class="btn primary" data-act="save-character" data-id="' + c.id + '">保存</button>' +
      "</div>" +
    "</div>" +
    '<div class="section">' +
      '<div class="section-title">角色属性</div>' +
      '<div id="char-form">' +
        '<div class="grid-2">' +
          '<div class="field"><label>名称</label><input type="text" data-field="name" value="' + escapeHtml(c.name) + '" /></div>' +
          '<div class="field"><label>显示名</label><input type="text" data-field="display_name" value="' + escapeHtml(c.display_name) + '" /></div>' +
        "</div>" +
        '<div class="field"><label>备注</label><textarea data-field="note">' + escapeHtml(c.note) + "</textarea></div>" +
        '<input type="hidden" data-field="avatar_crop" value="' + escapeHtml(c.avatar_crop || "") + '" />' +
      "</div>" +
    "</div>" +
    '<div class="section">' +
      '<div class="section-title">立绘差分</div>' +
      diffEditorHtml(c, expressions, selExp) +
    "</div>"
  );
}

function renderAssetDetail() {
  const asset = state.assets.find(function (a) { return a.id === state.selectedAssetId; });
  if (!asset) return '<div class="detail-empty">从左侧选择一项资源</div>';
  const nav = currentNav();
  return (
    '<div class="detail-head">' +
      detailHeadAvatar(asset.asset_key, asset.previewUrl || asset.url) +
      '<div class="detail-head-main">' +
        "<h2>" + escapeHtml(asset.name) + "</h2>" +
        '<div class="detail-head-sub">' + escapeHtml(nav.label) + "</div>" +
      "</div>" +
      '<div class="detail-head-actions">' +
        '<button class="btn danger" data-act="delete-asset" data-id="' + asset.id + '">删除</button>' +
        '<button class="btn primary" data-act="save-asset" data-id="' + asset.id + '">保存</button>' +
      "</div>" +
    "</div>" +
    '<div class="section">' +
      '<div class="section-title">资源属性</div>' +
      '<div id="asset-form">' +
        '<div class="field"><label>名称</label><input type="text" data-field="name" value="' + escapeHtml(asset.name) + '" /></div>' +
        '<div class="field"><label>资源键</label><input type="text" data-field="asset_key" value="' + escapeHtml(asset.asset_key) + '" placeholder="例如 images/bg_street.jpg" /></div>' +
        '<div class="field"><label>备注</label><textarea data-field="note">' + escapeHtml(asset.note) + "</textarea></div>" +
      "</div>" +
    "</div>" +
    '<div class="section">' +
      '<div class="section-title"><span>预览</span>' +
        '<button class="btn small" data-act="upload-asset" data-id="' + asset.id + '">上传资源</button></div>' +
      '<div class="preview-box">' + previewHtml(asset.asset_key, asset.url, asset.previewUrl, {
        audioUrl: asset.previewAudioUrl || asset.url,
        downloadUrl: asset.url,
        downloadName: asset.name,
      }) + "</div>" +
      '<dl class="meta-list">' +
        "<dt>资源大小</dt><dd>" + sizeText(asset.size) + "</dd>" +
        (asset.preview_key
          ? "<dt>预览大小</dt><dd>" + sizeText(asset.previewSize) + " · " + escapeHtml(asset.preview_key) + "</dd>"
          : "") +
      "</dl>" +
    "</div>"
  );
}

function renderObjectDetail() {
  const obj = state.objects.find(function (o) { return o.relativeKey === state.selectedObjectKey; });
  if (!obj) return '<div class="detail-empty">从左侧选择一个对象</div>';
  return (
    '<div class="detail-head">' +
      detailHeadAvatar(obj.relativeKey, obj.previewUrl || obj.url) +
      '<div class="detail-head-main">' +
        "<h2>" + escapeHtml(obj.relativeKey.split("/").pop()) + "</h2>" +
        '<div class="detail-head-sub">存储对象</div>' +
      "</div>" +
      '<div class="detail-head-actions">' +
        '<button class="btn danger" data-act="delete-object" data-key="' + escapeHtml(obj.relativeKey) + '">删除对象</button>' +
        '<button class="btn" data-act="copy-url" data-key="' + escapeHtml(obj.relativeKey) + '">复制链接</button>' +
      "</div>" +
    "</div>" +
    '<div class="section">' +
      '<div class="section-title">预览</div>' +
      '<div class="preview-box">' + previewHtml(obj.relativeKey, obj.url, obj.previewUrl) + "</div>" +
    "</div>" +
    '<div class="section">' +
      '<div class="section-title">对象信息</div>' +
      '<dl class="meta-list">' +
        "<dt>资源键</dt><dd>" + escapeHtml(obj.relativeKey) + "</dd>" +
        "<dt>大小</dt><dd>" + humanSize(obj.size) + "</dd>" +
        "<dt>修改时间</dt><dd>" + escapeHtml(obj.lastModified) + "</dd>" +
      "</dl>" +
    "</div>"
  );
}

function renderDetail() {
  const cropDialog = document.getElementById("crop-dialog");
  if (cropDialog && cropDialog.open) cropDialog.close();
  const nav = currentNav();
  if (nav.kind === "characters") {
    el.detail.innerHTML = renderCharacterDetail();
    syncExpressionRoving();
  } else if (nav.kind === "assets") {
    el.detail.innerHTML = renderAssetDetail();
  } else {
    el.detail.innerHTML = renderObjectDetail();
  }
}

function refreshHeadAvatar(url, crop) {
  const btn = el.detail.querySelector(".detail-avatar-btn");
  if (!btn) return;
  const hint = btn.querySelector(".avatar-edit-hint");
  btn.innerHTML = avatarImgHtml(url, crop) + (hint ? hint.outerHTML : "");
}

function openCropModal() {
  const dialog = document.getElementById("crop-dialog");
  const stage = document.getElementById("crop-stage");
  const source = document.getElementById("crop-source");
  const rectEl = document.getElementById("crop-rect");
  const handle = document.getElementById("crop-handle");
  const previewBox = document.getElementById("crop-preview");
  if (!dialog || !stage || !source || !rectEl || !handle || !previewBox) return;
  if (typeof dialog.showModal !== "function") return;

  const d = state.detail;
  const c = d && d.character;
  if (!c) return;
  const avatarUrl = c.avatarPreviewUrl || c.avatarUrl || "";
  if (!avatarUrl) {
    toast("该角色尚未设置立绘，无法剪裁", { error: true });
    return;
  }

  if (cropAbort) {
    cropAbort.abort();
    cropAbort = null;
  }
  const abort = new AbortController();
  cropAbort = abort;
  const sig = { signal: abort.signal };

  source.setAttribute("src", avatarUrl);
  const dialogTitle = document.getElementById("crop-dialog-title");
  if (dialogTitle) dialogTitle.textContent = "剪裁对白头像 · " + (c.display_name || c.name);

  const hidden = document.querySelector('#char-form [data-field="avatar_crop"]');
  let crop = parseCrop(hidden ? hidden.value : "");

  function paint() {
    rectEl.style.cssText = cropRectStyle(crop);
    previewBox.innerHTML = avatarImgHtml(avatarUrl, crop);
  }

  function applyDefault() {
    crop = defaultCrop(source.naturalWidth, source.naturalHeight);
    paint();
  }

  if (crop) {
    paint();
  } else if (source.complete && source.naturalWidth) {
    applyDefault();
  } else {
    source.addEventListener("load", applyDefault, { once: true, signal: abort.signal });
  }

  let drag = null;

  rectEl.addEventListener("pointerdown", function (event) {
    if (event.target === handle) return;
    const r = stage.getBoundingClientRect();
    drag = { mode: "move", x: event.clientX, y: event.clientY, start: crop, rw: r.width, rh: r.height };
    rectEl.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, sig);

  handle.addEventListener("pointerdown", function (event) {
    const r = stage.getBoundingClientRect();
    drag = { mode: "resize", start: crop, left: r.left, top: r.top, rw: r.width, rh: r.height };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, sig);

  function onMove(event) {
    if (!drag) return;
    if (drag.mode === "move") {
      const dx = (event.clientX - drag.x) / drag.rw;
      const dy = (event.clientY - drag.y) / drag.rh;
      crop = {
        x: clamp(drag.start.x + dx, 0, 1 - drag.start.w),
        y: clamp(drag.start.y + dy, 0, 1 - drag.start.h),
        w: drag.start.w,
        h: drag.start.h,
      };
    } else {
      const sideX = event.clientX - drag.left - drag.start.x * drag.rw;
      const sideY = event.clientY - drag.top - drag.start.y * drag.rh;
      const maxPx = Math.min((1 - drag.start.x) * drag.rw, (1 - drag.start.y) * drag.rh);
      const side = clamp(Math.max(sideX, sideY), 24, maxPx);
      crop = {
        x: drag.start.x,
        y: drag.start.y,
        w: round4(side / drag.rw),
        h: round4(side / drag.rh),
      };
    }
    paint();
  }

  function onUp() {
    drag = null;
  }

  window.addEventListener("pointermove", onMove, sig);
  window.addEventListener("pointerup", onUp, sig);
  window.addEventListener("pointercancel", onUp, sig);

  function commit() {
    if (hidden) hidden.value = serializeCrop(crop);
    refreshHeadAvatar(avatarUrl, crop);
  }

  const applyBtn = document.getElementById("crop-apply");
  const cancelBtn = document.getElementById("crop-cancel");
  const resetBtn = document.getElementById("crop-reset");
  const closeBtn = document.getElementById("crop-close");
  if (applyBtn) applyBtn.addEventListener("click", function () { commit(); dialog.close(); }, sig);
  if (cancelBtn) cancelBtn.addEventListener("click", function () { dialog.close(); }, sig);
  if (closeBtn) closeBtn.addEventListener("click", function () { dialog.close(); }, sig);
  if (resetBtn) resetBtn.addEventListener("click", function () { applyDefault(); }, sig);

  dialog.addEventListener("close", function () {
    if (cropAbort === abort) cropAbort = null;
    abort.abort();
  }, { once: true });

  dialog.showModal();
}

function render() {
  renderNav();
  renderList();
  renderDetail();
}

/* ---------------------------- script view ---------------------------- */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function timeLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function blockTitleText(blocks) {
  const list = blocks || [];
  for (let i = 0; i < list.length; i += 1) {
    const b = list[i];
    const text = String(b.text || "").trim();
    if (!text) continue;
    if (b.type === "card") return text.length > 28 ? text.slice(0, 28) + "…" : text;
    if (b.type === "narr" || b.type === "cue" || b.type === "line") {
      return text.length > 22 ? text.slice(0, 22) + "…" : text;
    }
  }
  return "";
}

function scriptLabelList() {
  const doc = state.scriptDoc || { labels: {} };
  const labels = doc.labels || {};
  let order = Array.isArray(doc.order) ? doc.order.filter(function (id) { return labels[id]; }) : [];
  if (!order.length) order = Object.keys(labels);
  return order.map(function (id) {
    const entry = labels[id] || {};
    return {
      id: id,
      no: entry.no || id.toUpperCase(),
      title: entry.title || blockTitleText(entry.blocks) || id,
    };
  });
}

function currentScriptLabel() {
  if (!state.scriptLabelId) return null;
  return { id: state.scriptLabelId };
}

function labelMeta(label) {
  const view = labelViewFromBlocks(labelBlocks(label.id));
  const parts = [];
  const lines = view.nodes.filter(function (n) { return n.type === "line"; }).length;
  if (lines) parts.push(lines + " 句台词");
  if (view.cast.length) parts.push(view.cast.length + " 角色");
  if (view.bgm.length) parts.push(view.bgm.length + " BGM");
  return parts.join(" · ");
}

/* ---------------------------- block model ---------------------------- */

const BLOCK_META = {
  card: { icon: "▤", label: "卡片" },
  scene: { icon: "▧", label: "背景" },
  show: { icon: "◐", label: "登场" },
  hide: { icon: "◑", label: "退场" },
  music: { icon: "♪", label: "音乐" },
  audio: { icon: "♬", label: "音效" },
  cue: { icon: "·", label: "提示" },
  narr: { icon: "¶", label: "旁白" },
  line: { icon: "❝", label: "台词" },
  menu: { icon: "⑃", label: "选项" },
  screen: { icon: "▢", label: "界面" },
};

const CARD_KIND_LABEL = {
  card: "卡片",
  date: "日期",
  title: "标题",
  section: "章节",
  quote: "引用",
};

function newBlockId() {
  blockSeq += 1;
  return "b" + Date.now().toString(36) + blockSeq.toString(36);
}

function characterIndex() {
  const map = {};
  (state.script.characters || []).forEach(function (c) { map[c.id] = c; });
  return map;
}

const DIALOGUE_OPEN = "\u300c";
const DIALOGUE_CLOSE = "\u300d";

function stripDialogueQuotes(text) {
  const out = text == null ? "" : String(text);
  if (out.length >= 2 && out.charAt(0) === DIALOGUE_OPEN && out.charAt(out.length - 1) === DIALOGUE_CLOSE) {
    return out.slice(1, -1);
  }
  return out;
}

function lineBlock(c) {
  return {
    type: "line",
    charId: c ? c.id : "",
    speaker: c ? c.name : "",
    color: c ? c.color : "",
    avatarUrl: c ? c.avatarUrl : "",
    avatarPreviewUrl: c ? c.avatarPreviewUrl : "",
    avatarCrop: c ? c.avatarCrop : "",
    text: "",
  };
}

function sceneBlock(img) {
  return {
    type: "scene",
    image: img.image,
    imageKey: img.key,
    display: img.display,
    url: img.url,
    previewUrl: img.previewUrl,
  };
}

function musicBlock(a) {
  return {
    type: "music",
    action: "play",
    audioId: a.id,
    key: a.key,
    display: a.display,
    url: a.url,
  };
}

function nodeToBlock(n) {
  if (n.type === "card") return { id: newBlockId(), type: "card", kind: n.kind, text: n.text || "" };
  if (n.type === "scene") return { id: newBlockId(), type: "scene", image: n.image, imageKey: n.key, display: n.display, url: n.url, previewUrl: n.previewUrl };
  if (n.type === "show") return { id: newBlockId(), type: "show", charId: n.char, attr: n.attr, display: n.display, imageKey: n.key, url: n.url, previewUrl: n.previewUrl };
  if (n.type === "hide") return { id: newBlockId(), type: "hide", charId: n.char };
  if (n.type === "audio") {
    if (n.channel === "music") return { id: newBlockId(), type: "music", action: n.action, audioId: n.clip, key: n.key, display: n.display, url: n.url };
    return { id: newBlockId(), type: "audio", action: n.action, channel: n.channel, clip: n.clip, display: n.display, url: n.url };
  }
  if (n.type === "cue") return { id: newBlockId(), type: "cue", text: n.text || "" };
  if (n.type === "narr") return { id: newBlockId(), type: "narr", text: n.text || "" };
  if (n.type === "line") {
    return {
      id: newBlockId(), type: "line", charId: n.char, attr: n.attr,
      speaker: n.speaker, color: n.color,
      avatarUrl: n.avatarUrl, avatarPreviewUrl: n.avatarPreviewUrl, avatarCrop: n.avatarCrop,
      text: stripDialogueQuotes(n.text || ""),
    };
  }
  if (n.type === "menu") {
    return {
      id: newBlockId(), type: "menu", prompt: n.prompt || "",
      choices: (n.choices || []).map(function (c) {
        return { id: newBlockId(), text: c.text, blocks: seedBlocksFromNodes(c.nodes) };
      }),
    };
  }
  if (n.type === "screen") return { id: newBlockId(), type: "screen", action: n.action, name: n.name };
  return null;
}

function seedBlocksFromNodes(nodes) {
  return (nodes || []).map(nodeToBlock).filter(Boolean);
}

function seedDoc(labels) {
  if (!state.scriptDoc || typeof state.scriptDoc !== "object") state.scriptDoc = { version: 1, labels: {} };
  if (!state.scriptDoc.labels || typeof state.scriptDoc.labels !== "object") state.scriptDoc.labels = {};
  labels.forEach(function (label) {
    if (!state.scriptDoc.labels[label.id]) {
      state.scriptDoc.labels[label.id] = { blocks: seedBlocksFromNodes(label.nodes) };
    }
  });
}

function labelBlocks(labelId) {
  if (!state.scriptDoc) state.scriptDoc = { version: 1, labels: {} };
  if (!state.scriptDoc.labels) state.scriptDoc.labels = {};
  if (!state.scriptDoc.labels[labelId]) state.scriptDoc.labels[labelId] = { blocks: [] };
  if (!Array.isArray(state.scriptDoc.labels[labelId].blocks)) state.scriptDoc.labels[labelId].blocks = [];
  return state.scriptDoc.labels[labelId].blocks;
}

function blockToPreviewNode(b) {
  if (b.type === "card") return { type: "card", kind: b.kind, text: b.text };
  if (b.type === "scene") return { type: "scene", image: b.image, display: b.display, key: b.imageKey, url: b.url, previewUrl: b.previewUrl };
  if (b.type === "show") return { type: "show", char: b.charId, attr: b.attr, display: b.display, key: b.imageKey, url: b.url, previewUrl: b.previewUrl };
  if (b.type === "hide") return { type: "hide", char: b.charId };
  if (b.type === "music") return { type: "audio", action: b.action || "play", channel: "music", clip: b.audioId, display: b.display, url: b.url };
  if (b.type === "audio") return { type: "audio", action: b.action, channel: b.channel, clip: b.clip, display: b.display, url: b.url };
  if (b.type === "cue") return { type: "cue", text: b.text };
  if (b.type === "narr") return { type: "narr", text: b.text };
  if (b.type === "line") {
    return {
      type: "line", speaker: b.speaker, color: b.color,
      avatarUrl: b.avatarUrl, avatarPreviewUrl: b.avatarPreviewUrl, avatarCrop: b.avatarCrop,
      text: b.text,
    };
  }
  if (b.type === "menu") {
    return {
      type: "menu", prompt: b.prompt,
      choices: (b.choices || []).map(function (c) {
        return { text: c.text, nodes: (c.blocks || []).map(blockToPreviewNode) };
      }),
    };
  }
  if (b.type === "screen") return { type: "screen", action: b.action, name: b.name };
  return { type: "narr", text: "" };
}

function labelViewFromBlocks(blocks) {
  const nodes = blocks.map(blockToPreviewNode);
  const map = characterIndex();
  const castIds = [];
  const bgm = [];
  let background = null;
  blocks.forEach(function (b) {
    if (b.type === "scene") background = blockToPreviewNode(b);
    if ((b.type === "line" || b.type === "show" || b.type === "hide") && b.charId && castIds.indexOf(b.charId) === -1) {
      castIds.push(b.charId);
    }
    if (b.type === "music" && b.action !== "stop" && b.key) {
      const exists = bgm.some(function (x) { return x.key === b.key; });
      if (!exists) bgm.push({ key: b.key, display: b.display, url: b.url });
    }
  });
  return {
    nodes: nodes,
    background: background,
    cast: castIds.map(function (id) { return map[id]; }).filter(Boolean),
    bgm: bgm,
  };
}

function findBlock(id) {
  if (!state.scriptLabelId) return null;
  return labelBlocks(state.scriptLabelId).find(function (b) { return b.id === id; }) || null;
}

function findChoice(id) {
  if (!state.scriptLabelId) return null;
  const blocks = labelBlocks(state.scriptLabelId);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "menu" && b.choices) {
      const hit = b.choices.find(function (c) { return c.id === id; });
      if (hit) return hit;
    }
  }
  return null;
}

/* ---------------------------- block render ---------------------------- */

function blockRowHtml(block) {
  const meta = BLOCK_META[block.type] || { icon: "•", label: block.type };
  return (
    '<div class="blk type-' + escapeHtml(block.type) + '" data-block="' + escapeHtml(block.id) + '">' +
      '<div class="blk-gutter">' +
        '<button class="blk-add" data-act="block-menu" data-after="' + escapeHtml(block.id) + '" title="在下方插入区块">+</button>' +
        '<span class="blk-icon" title="' + escapeHtml(meta.label) + '">' + escapeHtml(meta.icon) + "</span>" +
      "</div>" +
      '<div class="blk-body">' + blockBodyHtml(block) + "</div>" +
      '<button class="blk-del" data-act="block-del" data-id="' + escapeHtml(block.id) + '" title="删除区块">✕</button>' +
    "</div>"
  );
}

function blockTextarea(attr, id, value, placeholder, cls) {
  return '<textarea class="blk-text ' + (cls || "") + '" data-block-' + attr + '="' + escapeHtml(id) +
    '" rows="1" spellcheck="false" placeholder="' + escapeHtml(placeholder) + '">' + escapeHtml(value || "") + "</textarea>";
}

function blockBodyHtml(block) {
  if (block.type === "line") {
    const crop = parseCrop(block.avatarCrop);
    const src = block.avatarPreviewUrl || block.avatarUrl;
    const av = src
      ? avatarImgHtml(src, crop)
      : '<span class="cast-initial">' + escapeHtml((block.speaker || "?").slice(0, 1)) + "</span>";
    const style = block.color ? ' style="color:' + escapeHtml(block.color) + '"' : "";
    return (
      '<div class="blk-line">' +
        '<div class="blk-avatar" data-act="pick-char" data-id="' + escapeHtml(block.id) + '" title="更换角色">' + av + "</div>" +
        '<div class="blk-line-main">' +
          '<button class="blk-speaker" data-act="pick-char" data-id="' + escapeHtml(block.id) + '"' + style + ">" +
            escapeHtml(block.speaker || "选择角色") + "</button>" +
          '<div class="blk-dialogue-wrap">' +
            '<span class="blk-quote" aria-hidden="true">&#12300;</span>' +
            blockTextarea("text", block.id, stripDialogueQuotes(block.text), "输入台词…", "blk-dialogue") +
            '<span class="blk-quote" aria-hidden="true">&#12301;</span>' +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }
  if (block.type === "narr") {
    return blockTextarea("text", block.id, block.text, "输入旁白…", "blk-narr");
  }
  if (block.type === "cue") {
    return blockTextarea("text", block.id, block.text, "舞台提示，如 pause / 转场…", "blk-cue");
  }
  if (block.type === "card") {
    const kind = CARD_KIND_LABEL[block.kind] || block.kind;
    return (
      '<div class="blk-card">' +
        '<span class="blk-card-kind">' + escapeHtml(kind) + "</span>" +
        blockTextarea("text", block.id, block.text, "卡片文字…", "blk-card-text") +
      "</div>"
    );
  }
  if (block.type === "scene") {
    const src = block.previewUrl || block.url;
    const thumb = src ? '<img src="' + escapeHtml(src) + '" alt="" />' : '<span class="blk-missing">无图</span>';
    return (
      '<div class="blk-asset">' +
        '<div class="blk-asset-thumb">' + thumb + "</div>" +
        '<div class="blk-asset-info">' +
          '<div class="blk-asset-kind">背景</div>' +
          '<div class="blk-asset-name">' + escapeHtml(block.display || block.image || "未选择") + "</div>" +
        "</div>" +
        '<button class="btn tiny" data-act="pick-bg" data-id="' + escapeHtml(block.id) + '">更换</button>' +
      "</div>"
    );
  }
  if (block.type === "music") {
    return (
      '<div class="blk-asset tone-music">' +
        '<div class="blk-asset-thumb music">♪</div>' +
        '<div class="blk-asset-info">' +
          '<div class="blk-asset-kind">' + (block.action === "stop" ? "停止音乐" : "音乐") + "</div>" +
          '<div class="blk-asset-name">' + escapeHtml(block.display || block.audioId || "未选择") + "</div>" +
          (block.url ? audioPlayerHtml(block.url) : "") +
        "</div>" +
        '<button class="btn tiny" data-act="pick-music" data-id="' + escapeHtml(block.id) + '">更换</button>' +
      "</div>"
    );
  }
  if (block.type === "menu") {
    const prompt = block.prompt ? blockTextarea("prompt", block.id, block.prompt, "选项提示…", "blk-prompt") : "";
    const choices = (block.choices || []).map(function (c, i) {
      return (
        '<div class="blk-choice">' +
          '<span class="blk-choice-tag">选项 ' + (i + 1) + "</span>" +
          '<textarea class="blk-text" data-choice-text="' + escapeHtml(c.id) + '" rows="1" spellcheck="false" ' +
            'placeholder="选项文字…">' + escapeHtml(c.text || "") + "</textarea>" +
        "</div>"
      );
    }).join("");
    return '<div class="blk-choices">' + prompt + choices + "</div>";
  }
  if (block.type === "show") {
    return '<span class="blk-chip tone-show">登场 · ' + escapeHtml(block.display || block.charId || "?") + "</span>";
  }
  if (block.type === "hide") {
    return '<span class="blk-chip tone-hide">退场 · ' + escapeHtml(block.charId || "?") + "</span>";
  }
  if (block.type === "audio") {
    const verb = block.action === "stop" ? "停止" : "播放";
    return '<span class="blk-chip tone-audio">♪ ' + verb + " · " + escapeHtml(block.display || block.clip || "") + "</span>";
  }
  if (block.type === "screen") {
    const verb = block.action === "show" ? "显示" : "隐藏";
    return '<span class="blk-chip">' + verb + "界面 · " + escapeHtml(block.name || "") + "</span>";
  }
  return "";
}

function audioPlayerHtml(url) {
  return '<audio class="blk-audio" controls preload="none" src="' + escapeHtml(url) + '"></audio>';
}

function blocksInner(label) {
  if (!label) return '<div class="blocks-empty">请选择一个章节</div>';
  const blocks = labelBlocks(label.id);
  const rows = blocks.length
    ? blocks.map(blockRowHtml).join("")
    : '<div class="blocks-empty">空章节，输入 <b>/</b> 插入区块</div>';
  return rows + addBlockRowHtml();
}

function addBlockRowHtml() {
  return '<button class="blk-add-row" data-act="block-menu" data-after="__end__">' +
    '<span class="blk-add-plus">+</span> 添加区块 <span class="kbd">/</span></button>';
}

/* ---------------------------- block menu ---------------------------- */

function commandBase(key, group, label, hint, icon, build) {
  return { key: key, group: group, label: label, hint: hint, icon: icon, build: build, pick: null };
}

function buildCommands(filter) {
  const s = state.script;
  const items = [];
  if (!filter) {
    const first = s.characters[0] || null;
    const firstBg = s.images.filter(function (i) { return i.kind === "bg"; })[0] || null;
    const firstBgm = s.audio.filter(function (a) { return /bgm/i.test(a.id) || /bgm/i.test(a.key); })[0] || null;
    items.push(commandBase("narr", "基础", "旁白", "叙述段落", "¶", function () {
      return { type: "narr", text: "" };
    }));
    items.push(commandBase("line", "基础", "台词", "角色对白", "❝", function () {
      return lineBlock(first);
    }));
    items.push(commandBase("scene", "基础", "背景", "设置场景背景", "▧", function () {
      return firstBg ? sceneBlock(firstBg) : { type: "scene", display: "", url: "", previewUrl: "" };
    }));
    items.push(commandBase("music", "基础", "音乐", "播放 BGM", "♪", function () {
      return firstBgm ? musicBlock(firstBgm) : { type: "music", action: "play", display: "", url: "" };
    }));
    items.push(commandBase("cue", "基础", "舞台提示", "pause / 转场 等", "·", function () {
      return { type: "cue", text: "" };
    }));
    items.push(commandBase("card", "基础", "卡片", "标题 / 日期 / 引用", "▤", function () {
      return { type: "card", kind: "card", text: "" };
    }));
    items.push(commandBase("menu", "基础", "选项", "分支选择", "⑃", function () {
      return {
        type: "menu", prompt: "",
        choices: [
          { id: newBlockId(), text: "", blocks: [] },
          { id: newBlockId(), text: "", blocks: [] },
        ],
      };
    }));
  }
  if (!filter || filter === "char") {
    s.characters.forEach(function (c) {
      items.push({
        key: "char:" + c.id, group: "人物", label: c.name || c.id, hint: "插入台词", icon: "❝",
        avatarUrl: c.avatarPreviewUrl || c.avatarUrl, avatarCrop: c.avatarCrop, avatarColor: c.color,
        build: function () { return lineBlock(c); },
        pick: { kind: "char", payload: c },
      });
    });
  }
  if (!filter || filter === "bg") {
    s.images.filter(function (i) { return i.kind === "bg"; }).forEach(function (img) {
      items.push({
        key: "bg:" + img.name, group: "背景", label: img.display, hint: img.name, icon: "▧",
        thumbUrl: img.previewUrl || img.url,
        build: function () { return sceneBlock(img); },
        pick: { kind: "bg", payload: img },
      });
    });
  }
  if (!filter || filter === "music") {
    s.audio.filter(function (a) { return /bgm/i.test(a.id) || /bgm/i.test(a.key); }).forEach(function (a) {
      items.push({
        key: "music:" + a.id, group: "音乐", label: a.display || a.id, hint: a.key, icon: "♪",
        build: function () { return musicBlock(a); },
        pick: { kind: "music", payload: a },
      });
    });
  }
  return items;
}

function blockMenuInner() {
  return (
    '<input class="blk-menu-search" type="text" placeholder="搜索 人物 / 背景 / 音乐…" autocomplete="off" />' +
    '<div class="blk-menu-list" data-blk-menu-list></div>' +
    '<div class="blk-menu-foot">↑↓ 选择 · Enter 确认 · Esc 关闭</div>'
  );
}

function blockMenuListHtml() {
  if (!blockMenuShown.length) return '<div class="blk-menu-empty">无匹配项</div>';
  let out = "";
  let group = "";
  blockMenuShown.forEach(function (it, i) {
    if (it.group !== group) {
      group = it.group;
      out += '<div class="blk-menu-group">' + escapeHtml(group) + "</div>";
    }
    let lead;
    if (it.avatarUrl) {
      lead = '<span class="blk-menu-ava">' + avatarImgHtml(it.avatarUrl, parseCrop(it.avatarCrop)) + "</span>";
    } else if (it.avatarColor || it.thumbUrl) {
      lead = it.thumbUrl
        ? '<span class="blk-menu-thumb"><img src="' + escapeHtml(it.thumbUrl) + '" alt="" /></span>'
        : '<span class="blk-menu-ico">' + escapeHtml(it.icon) + "</span>";
    } else {
      lead = '<span class="blk-menu-ico">' + escapeHtml(it.icon) + "</span>";
    }
    out += (
      '<div class="blk-menu-item' + (i === blockMenuActive ? " active" : "") + '" data-idx="' + i + '">' +
        lead +
        '<span class="blk-menu-main">' +
          '<span class="blk-menu-label">' + escapeHtml(it.label || "") + "</span>" +
          (it.hint ? '<span class="blk-menu-hint">' + escapeHtml(it.hint) + "</span>" : "") +
        "</span>" +
      "</div>"
    );
  });
  return out;
}

function renderBlockMenuList() {
  const list = blockMenuEl.querySelector("[data-blk-menu-list]");
  if (list) list.innerHTML = blockMenuListHtml();
  const active = blockMenuEl.querySelector(".blk-menu-item.active");
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
}

function filterBlockMenu() {
  const q = blockMenuQuery.trim().toLowerCase();
  blockMenuShown = blockMenuItems.filter(function (it) {
    if (!q) return true;
    return String(it.label || "").toLowerCase().indexOf(q) !== -1 ||
      String(it.group || "").toLowerCase().indexOf(q) !== -1 ||
      String(it.hint || "").toLowerCase().indexOf(q) !== -1;
  });
  if (blockMenuActive >= blockMenuShown.length) blockMenuActive = 0;
  renderBlockMenuList();
}

function positionBlockMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = 320;
  let left = rect.left;
  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
  if (left < 12) left = 12;
  blockMenuEl.style.left = left + "px";
  blockMenuEl.style.top = rect.bottom + 6 + "px";
  const height = blockMenuEl.offsetHeight;
  if (rect.bottom + 6 + height > window.innerHeight - 12) {
    const up = rect.top - height - 6;
    blockMenuEl.style.top = Math.max(12, up) + "px";
  }
}

function openBlockMenu(ctx) {
  closeBlockMenu();
  blockMenuCtx = ctx;
  blockMenuQuery = "";
  blockMenuActive = 0;
  blockMenuItems = buildCommands(ctx.filter);
  blockMenuEl = document.createElement("div");
  blockMenuEl.className = "blk-menu";
  blockMenuEl.innerHTML = blockMenuInner();
  document.body.appendChild(blockMenuEl);
  filterBlockMenu();
  positionBlockMenu(ctx.anchor);

  const search = blockMenuEl.querySelector(".blk-menu-search");
  search.addEventListener("input", function () {
    blockMenuQuery = search.value;
    filterBlockMenu();
  });
  search.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (blockMenuShown.length) blockMenuActive = (blockMenuActive + 1) % blockMenuShown.length;
      renderBlockMenuList();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (blockMenuShown.length) blockMenuActive = (blockMenuActive - 1 + blockMenuShown.length) % blockMenuShown.length;
      renderBlockMenuList();
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseCommand(blockMenuShown[blockMenuActive]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeBlockMenu();
    }
  });
  blockMenuEl.addEventListener("mousemove", function (event) {
    const item = event.target.closest("[data-idx]");
    if (!item) return;
    const idx = Number(item.dataset.idx);
    if (idx === blockMenuActive) return;
    blockMenuActive = idx;
    renderBlockMenuList();
  });
  blockMenuEl.addEventListener("click", function (event) {
    const item = event.target.closest("[data-idx]");
    if (!item) return;
    chooseCommand(blockMenuShown[Number(item.dataset.idx)]);
  });
  setTimeout(function () {
    document.addEventListener("mousedown", blockMenuOutside, true);
  }, 0);
  search.focus();
}

function blockMenuOutside(event) {
  if (blockMenuEl && !blockMenuEl.contains(event.target)) closeBlockMenu();
}

function closeBlockMenu() {
  document.removeEventListener("mousedown", blockMenuOutside, true);
  if (blockMenuEl && blockMenuEl.parentNode) blockMenuEl.parentNode.removeChild(blockMenuEl);
  blockMenuEl = null;
  blockMenuCtx = null;
}

function applyPick(block, kind, payload) {
  if (kind === "char") {
    Object.assign(block, lineBlock(payload));
    if (block.text === undefined) block.text = "";
  } else if (kind === "bg") {
    Object.assign(block, sceneBlock(payload));
  } else if (kind === "music") {
    Object.assign(block, musicBlock(payload));
  }
}

function insertBlock(ctx, block) {
  const blocks = labelBlocks(ctx.labelId);
  if (ctx.replaceId) {
    const idx = blocks.findIndex(function (b) { return b.id === ctx.replaceId; });
    if (idx !== -1) {
      blocks[idx] = block;
      return block.id;
    }
  }
  if (ctx.afterId && ctx.afterId !== "__end__") {
    const idx = blocks.findIndex(function (b) { return b.id === ctx.afterId; });
    if (idx !== -1) {
      blocks.splice(idx + 1, 0, block);
      return block.id;
    }
  }
  blocks.push(block);
  return block.id;
}

function chooseCommand(item) {
  const ctx = blockMenuCtx;
  closeBlockMenu();
  if (!ctx || !item) return;
  if (ctx.mode === "pick") {
    const block = findBlock(ctx.blockId);
    if (block && item.pick && item.pick.kind === ctx.filter) {
      applyPick(block, ctx.filter, item.pick.payload);
      scheduleScriptSave();
      updateScriptMeta();
      renderEditor();
      focusBlock(ctx.blockId);
    }
    return;
  }
  const block = item.build();
  block.id = newBlockId();
  const id = insertBlock(ctx, block);
  scheduleScriptSave();
  updateScriptMeta();
  renderEditor();
  focusBlock(id);
}

/* ---------------------------- block editing ---------------------------- */

function autoGrow(node) {
  if (!node || node.tagName !== "TEXTAREA") return;
  node.style.height = "auto";
  node.style.height = Math.max(node.scrollHeight, 24) + "px";
}

function autoGrowAll() {
  if (!scriptEls || !scriptEls.blocks) return;
  scriptEls.blocks.querySelectorAll("textarea").forEach(autoGrow);
}

function focusBlock(id) {
  if (!scriptEls || !scriptEls.blocks) return;
  const row = scriptEls.blocks.querySelector('[data-block="' + id + '"]');
  if (!row) return;
  const field = row.querySelector(".blk-text") ||
    row.querySelector(".blk-prompt") ||
    row.querySelector(".blk-speaker") ||
    row.querySelector("[data-act='pick-char'], [data-act='pick-bg'], [data-act='pick-music']");
  if (field) field.focus();
}

function setBlockText(id, field, value) {
  const block = findBlock(id);
  if (!block) return;
  if (field === "prompt") block.prompt = value;
  else block.text = value;
}

function deleteBlock(id) {
  if (!state.scriptLabelId) return;
  const blocks = labelBlocks(state.scriptLabelId);
  const idx = blocks.findIndex(function (b) { return b.id === id; });
  if (idx === -1) return;
  blocks.splice(idx, 1);
  scheduleScriptSave();
  updateScriptMeta();
  renderEditor();
}

function renderEditor() {
  if (!scriptEls || !scriptEls.blocks) return;
  const label = currentScriptLabel();
  scriptEls.blocks.innerHTML = blocksInner(label);
  scriptEls.labelId = state.scriptLabelId;
  autoGrowAll();
}

/* ---------------------------- command items ---------------------------- */

function scriptListInner() {
  const q = state.scriptSearch.toLowerCase();
  const labels = scriptLabelList().filter(function (l) {
    if (!q) return true;
    return String(l.title || "").toLowerCase().indexOf(q) !== -1 ||
      l.id.toLowerCase().indexOf(q) !== -1 ||
      String(l.no || "").toLowerCase().indexOf(q) !== -1;
  });
  if (!labels.length) {
    return state.scriptSearch
      ? '<div class="empty-state compact">' +
          '<div class="empty-icon" aria-hidden="true">⌕</div>' +
          '<div class="empty-title">未找到章节</div>' +
          '<div class="empty-desc">没有与「' + escapeHtml(state.scriptSearch) + '」匹配的场景。</div>' +
        "</div>"
      : '<div class="empty-state">' +
          '<div class="empty-icon" aria-hidden="true">▤</div>' +
          '<div class="empty-title">还没有场景</div>' +
          '<div class="empty-desc">点击右上角 <span class="kbd">+</span> 新建一个场景开始编写。</div>' +
        "</div>";
  }
  return labels.map(function (l) {
    const active = l.id === state.scriptLabelId ? " active" : "";
    const bg = labelViewFromBlocks(labelBlocks(l.id)).background;
    const thumb = bg && (bg.previewUrl || bg.url)
      ? '<img src="' + escapeHtml(bg.previewUrl || bg.url) + '" alt="" />'
      : "▤";
    return (
      '<div class="row' + active + '" data-label="' + escapeHtml(l.id) + '">' +
        '<div class="row-thumb">' + thumb + "</div>" +
        '<div class="row-main">' +
          '<div class="row-name">' + escapeHtml(l.no + " · " + l.title) + "</div>" +
          '<div class="row-sub">' + escapeHtml(labelMeta(l)) + "</div>" +
        "</div>" +
      "</div>"
    );
  }).join("");
}

function scriptLabelsInner() {
  return (
    '<header class="list-head">' +
      '<div class="list-head-title">' +
        '<h1 id="script-list-title">剧本</h1>' +
        '<span class="pill" data-script-label-count>' + scriptLabelList().length + "</span>" +
      "</div>" +
      '<button class="icon-btn" data-act="add-scene" title="新增场景" aria-label="新增场景">+</button>' +
    "</header>" +
    '<div class="list-search">' +
      '<label class="sr-only" for="script-search-input">搜索场景</label>' +
      '<input id="script-search-input" data-script-search type="text" placeholder="搜索场景…" autocomplete="off" value="' +
        escapeHtml(state.scriptSearch) + '" />' +
    "</div>" +
    '<div class="list" data-script-label-list role="listbox" aria-label="场景列表"></div>'
  );
}

function renderLabelList() {
  if (!scriptEls || !scriptEls.labelList) return;
  scriptEls.labelList.innerHTML = scriptListInner();
  applyRoving(scriptEls.labelList, "[data-label]");
  if (scriptFocusPending) {
    scriptFocusPending = false;
    const active = scriptEls.labelList.querySelector("[data-label].active") ||
      scriptEls.labelList.querySelector("[data-label]");
    if (active) active.focus();
  }
}

function scriptEditorInner() {
  return (
    '<div class="editor-head">' +
      '<div class="editor-title">剧本编辑</div>' +
      '<div class="editor-head-right">' +
        '<div class="editor-status" data-script-status>就绪</div>' +
        '<button class="btn danger small" data-act="delete-scene">删除场景</button>' +
      "</div>" +
    "</div>" +
    '<div class="blocks" data-script-blocks></div>' +
    '<div class="editor-foot">' +
      '<span class="editor-file" data-script-file></span>' +
      '<button class="btn small" data-act="save-script">立即保存</button>' +
    "</div>"
  );
}

function cacheScriptEls() {
  scriptEls = {
    labelList: el.viewScript.querySelector("[data-script-label-list]"),
    labelCount: el.viewScript.querySelector("[data-script-label-count]"),
    status: el.viewScript.querySelector("[data-script-status]"),
    blocks: el.viewScript.querySelector("[data-script-blocks]"),
    file: el.viewScript.querySelector("[data-script-file]"),
    labelId: null,
  };
}

function renderScript() {
  if (!state.script) {
    el.viewScript.innerHTML =
      '<section class="list-pane"><div class="list">' + skeletonHtml(6) + "</div></section>" +
      '<aside class="script-editor"><div class="blocks">' + skeletonHtml(5) + "</div></aside>";
    return;
  }
  el.viewScript.innerHTML =
    '<section class="list-pane">' + scriptLabelsInner() + "</section>" +
    '<aside class="script-editor">' + scriptEditorInner() + "</aside>";
  cacheScriptEls();
  updateScriptPanes();
}

function renderScriptError(message) {
  scriptEls = null;
  el.viewScript.innerHTML =
    '<section class="list-pane"></section>' +
    '<aside class="script-editor">' +
      '<div class="empty-state is-error detail-empty-state">' +
        '<div class="empty-icon" aria-hidden="true">!</div>' +
        '<div class="empty-title">剧本加载失败</div>' +
        '<div class="empty-desc">' + escapeHtml(message || "无法读取剧本数据，请稍后重试。") + "</div>" +
        '<button class="btn small empty-action" data-act="retry-script">重试</button>' +
      "</div>" +
    "</aside>";
}

function updateScriptPanes() {
  if (!scriptEls || !state.script) return;
  if (scriptEls.labelList) {
    scriptEls.labelList.innerHTML = scriptListInner();
    applyRoving(scriptEls.labelList, "[data-label]");
  }
  if (scriptEls.labelCount) scriptEls.labelCount.textContent = String(scriptLabelList().length);
  updateScriptStatus();
  renderEditor();
}

function updateScriptStatus() {
  if (scriptEls && scriptEls.status) {
    scriptEls.status.textContent = scriptStatus.text;
    scriptEls.status.className = "editor-status " + scriptStatus.cls;
  }
  if (scriptEls && scriptEls.file) {
    const info = state.scriptDocFile;
    scriptEls.file.textContent = (info && info.path ? info.path : "script-doc.json") +
      (info && info.bytes ? " · " + humanSize(info.bytes) : "");
  }
}

function updateScriptMeta() {
  if (!scriptEls || !state.script) return;
  if (scriptEls.labelList) {
    scriptEls.labelList.innerHTML = scriptListInner();
    applyRoving(scriptEls.labelList, "[data-label]");
  }
  updateScriptStatus();
}

function setScriptStatus(text, cls) {
  scriptStatus = { text: text, cls: cls || "" };
  if (scriptEls && scriptEls.status) {
    scriptEls.status.textContent = scriptStatus.text;
    scriptEls.status.className = "editor-status " + scriptStatus.cls;
  }
}

async function refreshScript() {
  const data = await api("/api/script");
  state.script = data;
  const docData = await api("/api/script-doc");
  state.scriptDoc = docData.doc && docData.doc.labels ? docData.doc : { version: 1, labels: {} };
  state.scriptDocFile = docData.file || null;
  seedDoc(state.script.labels || []);
  const list = scriptLabelList();
  if (!state.scriptLabelId || !list.some(function (l) { return l.id === state.scriptLabelId; })) {
    state.scriptLabelId = list.length ? list[0].id : null;
  }
}

async function ensureScript() {
  if (!state.script) {
    if (!el.viewScript.querySelector(".pane-skeleton")) renderScript();
    try {
      await refreshScript();
    } catch (err) {
      renderScriptError(err.message);
      throw err;
    }
  }
  const mounted = scriptEls && el.viewScript.contains(scriptEls.blocks);
  if (!mounted) renderScript();
  else updateScriptPanes();
}

function scheduleScriptSave() {
  scriptDirty = true;
  setScriptStatus("未保存…", "");
  clearTimeout(scriptSaveTimer);
  scriptSaveTimer = setTimeout(function () { saveScript(); }, 700);
}

async function saveScript() {
  if (!state.scriptDoc) return;
  clearTimeout(scriptSaveTimer);
  setScriptStatus("保存中…", "busy");
  try {
    const data = await api("/api/script-doc", { method: "PUT", body: { doc: state.scriptDoc } });
    if (data.saved) state.scriptDocFile = data.saved;
    scriptDirty = false;
    scriptStatus = { text: "已保存 · " + timeLabel(data.saved && data.saved.updatedAt), cls: "saved" };
    updateScriptStatus();
  } catch (err) {
    scriptStatus = { text: "保存失败", cls: "error" };
    updateScriptStatus();
    toast(err.message, true);
  }
}

async function flushScriptSave() {
  if (scriptDirty) await saveScript();
}

async function addScene() {
  closeBlockMenu();
  clearTimeout(scriptSaveTimer);
  try {
    await saveScript();
    const data = await api("/api/script-scenes", { method: "POST" });
    if (data && data.doc && data.doc.labels) state.scriptDoc = data.doc;
    if (data && data.id) state.scriptLabelId = data.id;
    scriptDirty = false;
    scriptStatus = { text: "已新增场景", cls: "saved" };
    updateScriptPanes();
    toast("已新增 " + (data && data.no ? data.no : "场景"));
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeScene() {
  if (!state.scriptLabelId) return;
  const target = scriptLabelList().find(function (l) { return l.id === state.scriptLabelId; });
  const name = target ? target.no + " · " + target.title : state.scriptLabelId;
  const ok = await confirmAction({
    title: "删除场景「" + name + "」？",
    text: "该场景及其全部剧本块将被移除，此操作不可撤销。",
    okText: "删除场景",
  });
  if (!ok) return;
  closeBlockMenu();
  clearTimeout(scriptSaveTimer);
  try {
    await saveScript();
    const id = state.scriptLabelId;
    const data = await api("/api/script-scenes/" + encodeURIComponent(id), { method: "DELETE" });
    if (data && data.doc && data.doc.labels) state.scriptDoc = data.doc;
    const list = scriptLabelList();
    state.scriptLabelId = list.length ? list[0].id : null;
    scriptDirty = false;
    scriptStatus = { text: "已删除场景", cls: "saved" };
    updateScriptPanes();
    toast("已删除场景");
  } catch (err) {
    toast(err.message, true);
  }
}

async function switchTab(tab) {
  if (tab === state.tab) return;
  if (state.tab === "script" && tab !== "script") {
    closeBlockMenu();
    flushScriptSave().catch(function () {});
  }
  state.tab = tab;
  Array.prototype.forEach.call(document.querySelectorAll(".top-tab"), function (btn) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.tabIndex = on ? 0 : -1;
  });
  const isScript = tab === "script";
  el.viewAssets.hidden = isScript;
  el.viewScript.hidden = !isScript;
  if (isScript) {
    ensureScript().catch(function () {});
  }
}

/* ---------------------------- actions ---------------------------- */

function readFields(container) {
  const out = {};
  container.querySelectorAll("[data-field]").forEach(function (input) {
    out[input.dataset.field] = input.value;
  });
  return out;
}

async function addItem() {
  const nav = currentNav();
  try {
    if (nav.kind === "characters") {
      const created = await api("/api/characters", { method: "POST", body: { name: "新角色" } });
      await refreshData();
      await selectCharacter(created.id);
      focusField("#char-form", "name");
    } else if (nav.kind === "assets") {
      const created = await api("/api/assets", { method: "POST", body: { type: nav.type, name: "新资源" } });
      await refreshData();
      selectAsset(created.id);
      focusField("#asset-form", "name");
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function focusField(selector, field) {
  const input = document.querySelector(selector + ' [data-field="' + field + '"]');
  if (input) {
    input.focus();
    input.select();
  }
}

async function saveCharacter(id) {
  const form = document.getElementById("char-form");
  const values = readFields(form);
  try {
    await api("/api/characters/" + id, { method: "PUT", body: values });
    await refreshData();
    await selectCharacter(Number(id));
    toast("已保存");
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteCharacter(id) {
  const char = state.characters.find(function (c) { return c.id === Number(id); });
  const name = char ? (char.display_name || char.name) : "该角色";
  const count = char ? char.expression_count : 0;
  const hint = count ? "，其 " + count + " 个表情也会被一并删除" : "";
  const ok = await confirmAction({
    title: "删除「" + name + "」？",
    text: "确定删除该角色" + hint + "。此操作不可撤销。",
    okText: "删除角色",
  });
  if (!ok) return;
  try {
    await api("/api/characters/" + id, { method: "DELETE" });
    state.selectedCharacterId = null;
    state.detail = null;
    await refreshData();
    renderDetail();
    toast("已删除「" + name + "」");
  } catch (err) {
    toast(err.message, true);
  }
}

async function addExpression(characterId) {
  try {
    await api("/api/characters/" + characterId + "/expressions", {
      method: "POST",
      body: { name: "新表情" },
    });
    await refreshData();
    await selectCharacter(Number(characterId));
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveExpression(id) {
  const row = document.querySelector('.exp-item[data-exp-id="' + id + '"]');
  if (!row) return;
  const values = {};
  row.querySelectorAll("[data-exp-field]").forEach(function (input) {
    values[input.dataset.expField] = input.value;
  });
  try {
    await api("/api/expressions/" + id, { method: "PUT", body: values });
    await refreshData();
    await selectCharacter(state.selectedCharacterId);
    toast("表情已保存");
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteExpression(id) {
  const list = (state.detail && state.detail.expressions) || [];
  const target = list.find(function (e) { return e.id === Number(id); });
  const snapshot = target ? {
    characterId: state.selectedCharacterId,
    name: target.name,
    asset_key: target.asset_key || "",
    note: target.note || "",
    sort_order: target.sort_order,
  } : null;
  const label = target ? target.name : "该表情";
  try {
    await api("/api/expressions/" + id, { method: "DELETE" });
    await refreshData();
    await selectCharacter(state.selectedCharacterId);
    toast("已删除表情「" + label + "」", {
      action: { label: "撤销", onClick: function () { restoreExpression(snapshot); } },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

async function restoreExpression(snapshot) {
  if (!snapshot || snapshot.characterId === null || snapshot.characterId === undefined) return;
  try {
    const created = await api("/api/characters/" + snapshot.characterId + "/expressions", {
      method: "POST",
      body: { name: snapshot.name },
    });
    await api("/api/expressions/" + created.id, {
      method: "PUT",
      body: {
        name: snapshot.name,
        asset_key: snapshot.asset_key,
        note: snapshot.note,
        sort_order: snapshot.sort_order,
      },
    });
    await refreshData();
    await selectCharacter(Number(snapshot.characterId));
    toast("已恢复表情「" + snapshot.name + "」");
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveAsset(id) {
  const form = document.getElementById("asset-form");
  const values = readFields(form);
  try {
    await api("/api/assets/" + id, { method: "PUT", body: values });
    await refreshData();
    selectAsset(Number(id));
    toast("已保存");
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteAsset(id) {
  const asset = state.assets.find(function (a) { return a.id === Number(id); });
  const snapshot = asset ? {
    type: asset.type,
    name: asset.name,
    asset_key: asset.asset_key || "",
    preview_key: asset.previewKey || asset.preview_key || "",
    note: asset.note || "",
    sort_order: asset.sort_order,
  } : null;
  const label = asset ? asset.name : "该资源";
  try {
    await api("/api/assets/" + id, { method: "DELETE" });
    state.selectedAssetId = null;
    await refreshData();
    renderDetail();
    toast("已删除「" + label + "」", {
      action: { label: "撤销", onClick: function () { restoreAsset(snapshot); } },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

async function restoreAsset(snapshot) {
  if (!snapshot) return;
  try {
    const created = await api("/api/assets", {
      method: "POST",
      body: { type: snapshot.type, name: snapshot.name },
    });
    await api("/api/assets/" + created.id, {
      method: "PUT",
      body: {
        type: snapshot.type,
        name: snapshot.name,
        asset_key: snapshot.asset_key,
        preview_key: snapshot.preview_key,
        note: snapshot.note,
        sort_order: snapshot.sort_order,
      },
    });
    await refreshData();
    selectAsset(Number(created.id));
    toast("已恢复「" + snapshot.name + "」");
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteObject(key) {
  const ok = await confirmAction({
    title: "从对象存储删除？",
    text: "将永久删除「" + key + "」，此操作不可撤销，且不会同步删除本地数据库中的记录。",
    okText: "永久删除",
  });
  if (!ok) return;
  try {
    await api("/api/cos/objects?key=" + encodeURIComponent(key), { method: "DELETE" });
    state.selectedObjectKey = null;
    await refreshData();
    renderDetail();
    toast("对象已删除");
  } catch (err) {
    toast(err.message, true);
  }
}

function copyUrl(key) {
  const obj = state.objects.find(function (o) { return o.relativeKey === key; });
  if (!obj) return;
  const done = function () { toast("链接已复制"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(obj.url).then(done).catch(function () { toast("复制失败", true); });
  } else {
    toast("当前环境不支持复制", true);
  }
}

/* ---------------------------- upload ---------------------------- */

function openPicker(target) {
  pendingUpload = target;
  el.fileInput.value = "";
  el.fileInput.click();
}

async function handleFile(file) {
  const target = pendingUpload;
  pendingUpload = null;
  if (!target || !file) return;
  const name = safeFileName(file.name);
  const sizeLabel = humanSize(file.size);
  const onProgress = function (loaded, total) {
    const pct = total ? (loaded / total) * 100 : 0;
    setUploadProgress(pct, false);
    updateUploadOverlay("正在上传 " + name, sizeLabel + " · " + Math.round(pct) + "%");
  };
  try {
    if (target.kind === "character-avatar") {
      showUploadOverlay("正在上传 " + name, sizeLabel, ["上传文件", "更新角色"]);
      const key = "images/" + name;
      await uploadToCos(file, key, onProgress);
      setUploadStep(1);
      setUploadProgress(100, false);
      await api("/api/characters/" + target.id, { method: "PUT", body: { avatar_key: key } });
      finishUploadSteps();
      await refreshData();
      await selectCharacter(Number(target.id));
    } else if (target.kind === "expression") {
      showUploadOverlay("正在上传 " + name, sizeLabel, ["上传文件", "更新表情"]);
      const key = "images/" + name;
      await uploadToCos(file, key, onProgress);
      setUploadStep(1);
      setUploadProgress(100, false);
      await api("/api/expressions/" + target.id, { method: "PUT", body: { asset_key: key } });
      finishUploadSteps();
      await refreshData();
      await selectCharacter(state.selectedCharacterId);
    } else if (target.kind === "asset") {
      const asset = state.assets.find(function (a) { return a.id === target.id; });
      const key = dirForType(asset ? asset.type : "") + name;
      const isAudio = categoryOf(key) === "audio";
      const steps = isAudio
        ? ["上传文件", "生成音频预览", "更新资源"]
        : ["上传文件", "更新资源"];
      showUploadOverlay("正在上传 " + name, sizeLabel, steps);
      await uploadToCos(file, key, onProgress);
      let previewKey = "";
      if (isAudio) {
        setUploadStep(1);
        setUploadProgress(0, true);
        updateUploadOverlay("正在压缩音频…", name);
        try {
          const compressed = await api("/api/audio/compress", {
            method: "POST",
            body: { key: key },
          });
          previewKey = compressed.previewKey || "";
        } catch (err) {
          // Compression unavailable (e.g. ffmpeg missing) or failed: fall back
          // to previewing the original. The upload itself already succeeded.
          console.warn("audio compression skipped:", err.message);
        }
      }
      setUploadStep(isAudio ? 2 : 1);
      setUploadProgress(100, false);
      await api("/api/assets/" + target.id, { method: "PUT", body: { asset_key: key, preview_key: previewKey } });
      finishUploadSteps();
      await refreshData();
      selectAsset(Number(target.id));
    }
    toast("上传成功");
  } catch (err) {
    toast(err.message, true);
  } finally {
    hideUploadOverlay();
  }
}

/* ---------------------------- drag and drop ---------------------------- */

let dragDepth = 0;

function dragHasFiles(event) {
  const dt = event.dataTransfer;
  if (!dt) return false;
  const types = dt.types ? Array.prototype.slice.call(dt.types) : [];
  return types.indexOf("Files") !== -1;
}

function currentDropTarget() {
  const nav = currentNav();
  if (!nav) return null;
  if (nav.kind === "characters" && state.selectedCharacterId) {
    const char = state.characters.find(function (c) {
      return c.id === Number(state.selectedCharacterId);
    });
    const who = char ? char.display_name || char.name : "";
    return {
      kind: "character-avatar",
      id: state.selectedCharacterId,
      hint: "松开以更新「" + who + "」的头像",
    };
  }
  if (nav.kind === "assets" && state.selectedAssetId) {
    const asset = state.assets.find(function (a) {
      return a.id === Number(state.selectedAssetId);
    });
    const label = asset ? asset.name : "";
    return {
      kind: "asset",
      id: state.selectedAssetId,
      hint: "松开以替换「" + label + "」的文件",
    };
  }
  return null;
}

function showDropZone(on) {
  if (!el.viewAssets) return;
  el.viewAssets.classList.toggle("drop-active", !!on);
}

function handleDropFiles(fileList) {
  const file = fileList && fileList[0];
  if (!file) return;
  const target = currentDropTarget();
  if (!target) {
    toast("请先在左侧选择要更新的条目", true);
    return;
  }
  pendingUpload = target;
  handleFile(file);
}

const viewAssetsEl = el.viewAssets;
if (viewAssetsEl) {
  viewAssetsEl.addEventListener("dragenter", function (event) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    const target = currentDropTarget();
    if (el.dropHint) {
      el.dropHint.textContent = target ? target.hint : "请先在左侧选择要更新的条目";
    }
    showDropZone(true);
  });
  viewAssetsEl.addEventListener("dragover", function (event) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  viewAssetsEl.addEventListener("dragleave", function (event) {
    if (!dragHasFiles(event)) return;
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      showDropZone(false);
    }
  });
  viewAssetsEl.addEventListener("drop", function (event) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    showDropZone(false);
    handleDropFiles(event.dataTransfer ? event.dataTransfer.files : null);
  });
}

/* ---------------------------- events ---------------------------- */

function openNavView(view, focusList) {
  if (!view || view === state.view) return;
  state.view = view;
  state.search = "";
  el.searchInput.value = "";
  state.detail = null;
  listFocusPending = !!focusList;
  const nav = currentNav();
  if (nav.kind === "characters" && state.characters[0]) {
    refreshData().then(function () {
      if (state.characters[0]) return selectCharacter(state.characters[0].id);
      render();
    }).catch(function (e) { toast(e.message, true); });
  } else if (nav.kind === "bucket") {
    refreshData().then(function () {
      render();
    }).catch(function (e) { toast(e.message, true); });
  } else {
    render();
  }
}

el.nav.addEventListener("click", function (event) {
  const btn = event.target.closest("[data-view]");
  if (!btn) return;
  openNavView(btn.dataset.view, event.detail === 0);
});

el.nav.addEventListener("keydown", function (event) {
  moveRovingFocus(event, el.nav, "[data-view]");
});

el.list.addEventListener("click", function (event) {
  if (event.target.closest('[data-act="retry-load"]')) {
    boot();
    return;
  }
  const row = event.target.closest("[data-row]");
  if (!row) return;
  activateListRow(row);
});

el.list.addEventListener("keydown", function (event) {
  const row = event.target.closest("[data-row]");
  if (!row) return;
  if (isActivationKey(event)) {
    event.preventDefault();
    activateListRow(row);
    return;
  }
  moveRovingFocus(event, el.list, "[data-row]");
});

el.detail.addEventListener("click", function (event) {
  const expRow = event.target.closest("[data-exp-row]");
  if (expRow) {
    const field = event.target.closest("[data-exp-field]");
    selectExpressionRow(Number(expRow.dataset.expId), field ? field.dataset.expField : null);
    return;
  }
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (act === "save-character") return saveCharacter(id);
  if (act === "delete-character") return deleteCharacter(id);
  if (act === "open-crop") return openCropModal();
  if (act === "upload-character-avatar") return openPicker({ kind: "character-avatar", id: Number(id) });
  if (act === "add-expression") return addExpression(id);
  if (act === "save-expression") return saveExpression(id);
  if (act === "delete-expression") return deleteExpression(id);
  if (act === "upload-expression") return openPicker({ kind: "expression", id: Number(id) });
  if (act === "save-asset") return saveAsset(id);
  if (act === "delete-asset") return deleteAsset(id);
  if (act === "upload-asset") return openPicker({ kind: "asset", id: Number(id) });
  if (act === "delete-object") return deleteObject(btn.dataset.key);
  if (act === "copy-url") return copyUrl(btn.dataset.key);
});

el.detail.addEventListener("change", function (event) {
  const input = event.target.closest("[data-exp-field]");
  if (!input) return;
  const row = input.closest("[data-exp-row]");
  if (!row) return;
  saveExpression(row.dataset.expId);
});

el.detail.addEventListener("keydown", function (event) {
  const expRow = event.target.closest("[data-exp-row]");
  if (!expRow || event.target !== expRow) return;
  const eid = Number(expRow.dataset.expId);
  if (isActivationKey(event)) {
    event.preventDefault();
    if (eid !== state.selectedExpressionId) {
      state.selectedExpressionId = eid;
      renderDetail();
      const next = el.detail.querySelector('[data-exp-row][data-exp-id="' + eid + '"]');
      if (next) next.focus();
    } else {
      const input = el.detail.querySelector(
        '[data-exp-row][data-exp-id="' + eid + '"] [data-exp-field="name"]'
      );
      if (input) input.focus();
    }
    return;
  }
  moveRovingFocus(event, el.detail, "[data-exp-row]");
});

el.addBtn.addEventListener("click", addItem);

el.searchInput.addEventListener("input", function () {
  state.search = el.searchInput.value.trim();
  renderList();
});

el.fileInput.addEventListener("change", function () {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (file) handleFile(file);
});

function isTypingTarget(node) {
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable === true;
}

function focusSearch() {
  if (state.tab !== "assets") switchTab("assets");
  el.searchInput.focus();
  el.searchInput.select();
}

document.addEventListener("keydown", function (event) {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && String(event.key).toLowerCase() === "k") {
    event.preventDefault();
    focusSearch();
    return;
  }
  if (isTypingTarget(event.target)) {
    if (event.key === "Escape" && event.target === el.searchInput && el.searchInput.value) {
      el.searchInput.value = "";
      state.search = "";
      renderList();
    }
    return;
  }
  if (meta || event.altKey) return;
  if (event.key === "/") {
    if (state.tab !== "assets") return;
    event.preventDefault();
    focusSearch();
  } else if (event.key === "n" || event.key === "N") {
    if (state.tab !== "assets") return;
    const nav = currentNav();
    if (!nav || nav.kind === "bucket") return;
    event.preventDefault();
    addItem();
  } else if (event.key === "Escape" && state.tab === "assets" && el.searchInput.value) {
    el.searchInput.value = "";
    state.search = "";
    renderList();
  }
});

el.topTabs.addEventListener("click", function (event) {
  const btn = event.target.closest("[data-tab]");
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

el.topTabs.addEventListener("keydown", function (event) {
  const tabs = Array.prototype.slice.call(el.topTabs.querySelectorAll("[data-tab]"));
  if (!tabs.length) return;
  let index = tabs.indexOf(document.activeElement);
  if (index === -1) index = 0;
  if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft") index = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = tabs.length - 1;
  else if (isActivationKey(event)) {
    event.preventDefault();
    const btn = event.target.closest("[data-tab]");
    if (btn) switchTab(btn.dataset.tab);
    return;
  } else {
    return;
  }
  event.preventDefault();
  const next = tabs[index];
  tabs.forEach(function (b) { b.tabIndex = b === next ? 0 : -1; });
  next.focus();
  switchTab(next.dataset.tab);
});

el.viewScript.addEventListener("input", function (event) {
  const target = event.target;
  if (target.matches("[data-block-text]")) {
    setBlockText(target.dataset.blockText, "text", target.value);
    autoGrow(target);
    scheduleScriptSave();
    return;
  }
  if (target.matches("[data-block-prompt]")) {
    setBlockText(target.dataset.blockPrompt, "prompt", target.value);
    autoGrow(target);
    scheduleScriptSave();
    return;
  }
  if (target.matches("[data-choice-text]")) {
    const choice = findChoice(target.dataset.choiceText);
    if (choice) choice.text = target.value;
    autoGrow(target);
    scheduleScriptSave();
    return;
  }
  if (target.matches("[data-script-search]")) {
    state.scriptSearch = target.value;
    renderLabelList();
    return;
  }
});

el.viewScript.addEventListener("keydown", function (event) {
  if (event.key !== "/" || blockMenuEl) return;
  const target = event.target;
  if (!target.matches || !target.matches("[data-block-text], [data-block-prompt]")) return;
  if (target.value) return;
  event.preventDefault();
  const id = target.dataset.blockText || target.dataset.blockPrompt || "";
  const block = id ? findBlock(id) : null;
  const ctx = { mode: "insert", labelId: state.scriptLabelId, anchor: target };
  if (block && block.type !== "menu" && !block.text) ctx.replaceId = id;
  else ctx.afterId = id || "__end__";
  openBlockMenu(ctx);
});

el.viewScript.addEventListener("keydown", function (event) {
  const labelRow = event.target.closest("[data-label]");
  if (!labelRow || event.target !== labelRow) return;
  if (isActivationKey(event)) {
    event.preventDefault();
    selectScriptLabel(labelRow.dataset.label, true);
    return;
  }
  moveRovingFocus(event, scriptEls && scriptEls.labelList, "[data-label]");
});

function selectScriptLabel(id, focusList) {
  if (!id) return;
  if (id === state.scriptLabelId) {
    if (focusList) {
      scriptFocusPending = true;
      renderLabelList();
    }
    return;
  }
  closeBlockMenu();
  state.scriptLabelId = id;
  scriptFocusPending = !!focusList;
  updateScriptPanes();
  if (focusList) renderLabelList();
}

el.viewScript.addEventListener("click", function (event) {
  const labelRow = event.target.closest("[data-label]");
  if (labelRow) {
    selectScriptLabel(labelRow.dataset.label, false);
    return;
  }
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "retry-script") {
    ensureScript().catch(function (e) { toast(e.message, true); });
    return;
  }
  if (act === "save-script") {
    saveScript();
    return;
  }
  if (act === "add-scene") {
    addScene();
    return;
  }
  if (act === "delete-scene") {
    removeScene();
    return;
  }
  if (act === "block-menu") {
    openBlockMenu({
      mode: "insert",
      labelId: state.scriptLabelId,
      afterId: btn.dataset.after || "__end__",
      anchor: btn,
    });
    return;
  }
  if (act === "block-del") {
    deleteBlock(btn.dataset.id);
    return;
  }
  if (act === "pick-char" || act === "pick-bg" || act === "pick-music") {
    openBlockMenu({
      mode: "pick",
      filter: act === "pick-char" ? "char" : act === "pick-bg" ? "bg" : "music",
      blockId: btn.dataset.id,
      labelId: state.scriptLabelId,
      anchor: btn,
    });
  }
});

window.addEventListener("beforeunload", function () {
  if (scriptDirty) flushScriptSave();
});

/* ---------------------------- boot ---------------------------- */

async function boot() {
  showListSkeleton(7);
  showDetailSkeleton();
  try {
    await refreshData();
    if (state.view === "characters" && state.characters[0]) {
      await selectCharacter(state.characters[0].id);
    }
  } catch (err) {
    el.list.removeAttribute("aria-busy");
    el.list.innerHTML = listErrorHtml(err.message);
    el.listCount.textContent = "0";
    el.listTotal.hidden = true;
    el.detail.innerHTML = "";
    toast(err.message, true);
  }
}

boot();
