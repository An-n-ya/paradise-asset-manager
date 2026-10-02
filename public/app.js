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

const el = {
  topTabs: document.getElementById("top-tabs"),
  viewAssets: document.getElementById("view-assets"),
  viewScript: document.getElementById("view-script"),
  nav: document.getElementById("nav"),
  listTitle: document.getElementById("list-title"),
  listCount: document.getElementById("list-count"),
  addBtn: document.getElementById("add-btn"),
  searchInput: document.getElementById("search-input"),
  list: document.getElementById("list"),
  detail: document.getElementById("detail"),
  cosDot: document.getElementById("cos-dot"),
  cosLabel: document.getElementById("cos-label"),
  toast: document.getElementById("toast"),
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

function defaultCrop(naturalWidth, naturalHeight) {
  const nw = naturalWidth || 1;
  const nh = naturalHeight || 1;
  const side = Math.min(nw, nh);
  const w = side / nw;
  const h = side / nh;
  return {
    x: round4((1 - w) / 2),
    y: round4((1 - h) * 0.08),
    w: round4(w),
    h: round4(h),
  };
}

function humanSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

let toastTimer = null;
function toast(message, isError) {
  el.toast.textContent = message;
  el.toast.className = "toast show" + (isError ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    el.toast.className = "toast";
  }, 2200);
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

async function uploadToCos(file, relativeKey) {
  const contentType = file.type || "application/octet-stream";
  const info = await api("/api/cos/presign-upload", {
    method: "POST",
    body: { key: relativeKey, contentType: contentType },
  });
  const res = await fetch(info.url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: file,
  });
  if (!res.ok) throw new Error("上传失败 (" + res.status + ")");
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
      const active = item.view === state.view ? " active" : "";
      return (
        '<button class="nav-item' + active + '" data-view="' + item.view + '">' +
          '<span class="nav-icon">' + item.icon + "</span>" +
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

function renderList() {
  const nav = currentNav();
  el.listTitle.textContent = nav.label;

  let rows = "";
  let count = 0;
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
      return (
        '<div class="row' + active + '" data-row="asset" data-id="' + a.id + '">' +
          rowThumb(a.asset_key, a.previewUrl || a.url) +
          '<div class="row-main">' +
            '<div class="row-name">' + escapeHtml(a.name) + "</div>" +
            '<div class="row-sub">' + escapeHtml(a.asset_key || "未设置资源") + "</div>" +
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
  el.list.innerHTML = rows || '<div class="list-empty">暂无数据</div>';
}

/* ---------------------------- detail ---------------------------- */

function previewHtml(key, url, previewUrl) {
  if (!key) return '<div class="preview-empty">未设置资源</div>';
  const c = categoryOf(key);
  if (c === "image") {
    const src = previewUrl || url;
    return src ? '<img src="' + escapeHtml(src) + '" alt="" />'
      : '<div class="preview-empty">资源不可预览</div>';
  }
  if (c === "audio") {
    return url ? '<audio controls src="' + escapeHtml(url) + '"></audio>'
      : '<div class="preview-empty">资源不可预览</div>';
  }
  if (c === "video") {
    return url ? '<video controls src="' + escapeHtml(url) + '"></video>'
      : '<div class="preview-empty">资源不可预览</div>';
  }
  return url
    ? '<a class="tag" href="' + escapeHtml(url) + '" target="_blank">下载 / 打开资源</a>'
    : '<div class="preview-empty">未设置资源</div>';
}

function detailHeadAvatar(key, url, crop) {
  if (url && categoryOf(key) === "image") {
    return '<div class="detail-avatar">' + avatarImgHtml(url, crop) + "</div>";
  }
  return '<div class="detail-avatar">' + iconFor(key) + "</div>";
}

function diffEditorHtml(c, expressions, selExp) {
  const activeKey = selExp && selExp.asset_key ? selExp.asset_key : c.avatar_key;
  const imgUrl = (selExp && (selExp.previewUrl || selExp.url)) || c.avatarPreviewUrl || c.avatarUrl;
  const hasImage = imgUrl && categoryOf(activeKey) === "image";
  const crop = parseCrop(c.avatar_crop);
  const fileName = activeKey ? activeKey.split("/").pop() : "";
  const selId = state.selectedExpressionId || "";
  const disabled = state.selectedExpressionId ? "" : " disabled";

  const stage = hasImage
    ? '<div class="crop-stage" data-crop-stage>' +
        '<img class="crop-source" data-crop-source src="' + escapeHtml(imgUrl) + '" alt="" />' +
        '<div class="crop-rect" data-crop-rect style="' + cropRectStyle(crop) + '">' +
          '<span class="crop-handle" data-crop-handle></span>' +
        "</div>" +
      "</div>"
    : '<div class="preview-box">' + previewHtml(c.avatar_key, c.avatarUrl, c.avatarPreviewUrl) + "</div>";

  return (
    '<div class="diff-editor" data-crop-editor>' +
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
          '<div class="crop-preview-box" data-crop-preview>' + avatarImgHtml(imgUrl, crop) + "</div>" +
          '<button class="btn small" data-act="upload-character-avatar" data-id="' + c.id + '">选择图片</button>' +
          '<button class="btn small" data-act="reset-avatar-crop" data-id="' + c.id + '">重置裁剪</button>' +
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
      detailHeadAvatar(c.avatar_key, c.avatarPreviewUrl || c.avatarUrl, crop) +
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
      '<div class="preview-box">' + previewHtml(asset.asset_key, asset.url, asset.previewUrl) + "</div>" +
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
  if (cropAbort) {
    cropAbort.abort();
    cropAbort = null;
  }
  const nav = currentNav();
  if (nav.kind === "characters") {
    el.detail.innerHTML = renderCharacterDetail();
    initCropEditor();
  } else if (nav.kind === "assets") {
    el.detail.innerHTML = renderAssetDetail();
  } else {
    el.detail.innerHTML = renderObjectDetail();
  }
}

function initCropEditor() {
  const editor = el.detail.querySelector("[data-crop-editor]");
  if (!editor) return;
  const stage = editor.querySelector("[data-crop-stage]");
  const source = editor.querySelector("[data-crop-source]");
  const rectEl = editor.querySelector("[data-crop-rect]");
  const handle = editor.querySelector("[data-crop-handle]");
  if (!stage || !source || !rectEl || !handle) return;
  const previewBox = editor.querySelector("[data-crop-preview]");
  const resetBtn = editor.querySelector('[data-act="reset-avatar-crop"]');
  const hidden = document.querySelector('#char-form [data-field="avatar_crop"]');
  const url = source.getAttribute("src");
  const abort = new AbortController();
  cropAbort = abort;

  let crop = parseCrop(hidden ? hidden.value : "");

  function paint() {
    rectEl.style.cssText = cropRectStyle(crop);
    previewBox.innerHTML = avatarImgHtml(url, crop);
    if (hidden) hidden.value = serializeCrop(crop);
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
    source.addEventListener("load", applyDefault, { once: true });
  }

  let drag = null;

  rectEl.addEventListener("pointerdown", function (event) {
    if (event.target === handle) return;
    const r = stage.getBoundingClientRect();
    drag = { mode: "move", x: event.clientX, y: event.clientY, start: crop, rw: r.width, rh: r.height };
    rectEl.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  handle.addEventListener("pointerdown", function (event) {
    const r = stage.getBoundingClientRect();
    drag = { mode: "resize", start: crop, left: r.left, top: r.top, rw: r.width, rh: r.height };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  });

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

  window.addEventListener("pointermove", onMove, { signal: abort.signal });
  window.addEventListener("pointerup", onUp, { signal: abort.signal });
  window.addEventListener("pointercancel", onUp, { signal: abort.signal });

  if (resetBtn) {
    resetBtn.addEventListener("click", function () {
      applyDefault();
    });
  }
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
  if (!labels.length) return '<div class="list-empty">暂无章节</div>';
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
        "<h1>剧本</h1>" +
        '<span class="pill" data-script-label-count>' + scriptLabelList().length + "</span>" +
      "</div>" +
    "</header>" +
    '<div class="list-search">' +
      '<input data-script-search type="text" placeholder="搜索章节…" autocomplete="off" value="' +
        escapeHtml(state.scriptSearch) + '" />' +
    "</div>" +
    '<div class="list" data-script-label-list></div>'
  );
}

function scriptEditorInner() {
  return (
    '<div class="editor-head">' +
      '<div class="editor-title">剧本编辑</div>' +
      '<div class="editor-status" data-script-status>就绪</div>' +
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
    el.viewScript.innerHTML = '<div class="script-empty">加载中…</div>';
    return;
  }
  el.viewScript.innerHTML =
    '<section class="list-pane">' + scriptLabelsInner() + "</section>" +
    '<aside class="script-editor">' + scriptEditorInner() + "</aside>";
  cacheScriptEls();
  updateScriptPanes();
}

function updateScriptPanes() {
  if (!scriptEls || !state.script) return;
  if (scriptEls.labelList) scriptEls.labelList.innerHTML = scriptListInner();
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
  if (scriptEls.labelList) scriptEls.labelList.innerHTML = scriptListInner();
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
  if (!state.script) await refreshScript();
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

async function switchTab(tab) {
  if (tab === state.tab) return;
  if (state.tab === "script" && tab !== "script") {
    closeBlockMenu();
    flushScriptSave().catch(function () {});
  }
  state.tab = tab;
  Array.prototype.forEach.call(document.querySelectorAll(".top-tab"), function (btn) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  const isScript = tab === "script";
  el.viewAssets.hidden = isScript;
  el.viewScript.hidden = !isScript;
  if (isScript) {
    ensureScript().catch(function (e) { toast(e.message, true); });
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
  if (!confirm("确定删除该角色及其全部表情？")) return;
  try {
    await api("/api/characters/" + id, { method: "DELETE" });
    state.selectedCharacterId = null;
    state.detail = null;
    await refreshData();
    renderDetail();
    toast("已删除");
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
  if (!confirm("确定删除该表情？")) return;
  try {
    await api("/api/expressions/" + id, { method: "DELETE" });
    await refreshData();
    await selectCharacter(state.selectedCharacterId);
    toast("已删除");
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
  if (!confirm("确定删除该资源？")) return;
  try {
    await api("/api/assets/" + id, { method: "DELETE" });
    state.selectedAssetId = null;
    await refreshData();
    renderDetail();
    toast("已删除");
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteObject(key) {
  if (!confirm("确定从对象存储中删除该对象？")) return;
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
  try {
    const name = safeFileName(file.name);
    if (target.kind === "character-avatar") {
      const key = "images/" + name;
      await uploadToCos(file, key);
      await api("/api/characters/" + target.id, { method: "PUT", body: { avatar_key: key } });
      await refreshData();
      await selectCharacter(Number(target.id));
    } else if (target.kind === "expression") {
      const key = "images/" + name;
      await uploadToCos(file, key);
      await api("/api/expressions/" + target.id, { method: "PUT", body: { asset_key: key } });
      await refreshData();
      await selectCharacter(state.selectedCharacterId);
    } else if (target.kind === "asset") {
      const asset = state.assets.find(function (a) { return a.id === target.id; });
      const key = dirForType(asset ? asset.type : "") + name;
      await uploadToCos(file, key);
      await api("/api/assets/" + target.id, { method: "PUT", body: { asset_key: key } });
      await refreshData();
      selectAsset(Number(target.id));
    }
    toast("上传成功");
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------- events ---------------------------- */

el.nav.addEventListener("click", function (event) {
  const btn = event.target.closest("[data-view]");
  if (!btn) return;
  const view = btn.dataset.view;
  if (view === state.view) return;
  state.view = view;
  state.search = "";
  el.searchInput.value = "";
  state.detail = null;
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
});

el.list.addEventListener("click", function (event) {
  const row = event.target.closest("[data-row]");
  if (!row) return;
  const kind = row.dataset.row;
  if (kind === "character") {
    selectCharacter(Number(row.dataset.id)).catch(function (e) { toast(e.message, true); });
  } else if (kind === "asset") {
    selectAsset(Number(row.dataset.id));
  } else if (kind === "object") {
    selectObject(row.dataset.key);
  }
});

el.detail.addEventListener("click", function (event) {
  const expRow = event.target.closest("[data-exp-row]");
  if (expRow) {
    const eid = Number(expRow.dataset.expId);
    if (eid !== state.selectedExpressionId) {
      const field = event.target.closest("[data-exp-field]");
      state.selectedExpressionId = eid;
      renderDetail();
      if (field) {
        const next = el.detail.querySelector('[data-exp-row][data-exp-id="' + eid + '"] [data-exp-field="' + field.dataset.expField + '"]');
        if (next) next.focus();
      }
    }
    return;
  }
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (act === "save-character") return saveCharacter(id);
  if (act === "delete-character") return deleteCharacter(id);
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

el.addBtn.addEventListener("click", addItem);

el.searchInput.addEventListener("input", function () {
  state.search = el.searchInput.value.trim();
  renderList();
});

el.fileInput.addEventListener("change", function () {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (file) handleFile(file);
});

el.topTabs.addEventListener("click", function (event) {
  const btn = event.target.closest("[data-tab]");
  if (!btn) return;
  switchTab(btn.dataset.tab);
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
    if (scriptEls && scriptEls.labelList) scriptEls.labelList.innerHTML = scriptListInner();
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

el.viewScript.addEventListener("click", function (event) {
  const labelRow = event.target.closest("[data-label]");
  if (labelRow) {
    closeBlockMenu();
    state.scriptLabelId = labelRow.dataset.label;
    updateScriptPanes();
    return;
  }
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "save-script") {
    saveScript();
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

refreshData()
  .then(function () {
    if (state.view === "characters" && state.characters[0]) {
      return selectCharacter(state.characters[0].id);
    }
  })
  .catch(function (err) { toast(err.message, true); });
