# AGENTS.md

本文件面向后续接手本项目的 AI Agent，用于快速理解项目全貌。阅读代码前请先读完本文。

## 1. 项目是什么

失乐园（Paradise Lost）游戏项目的**资产管理 + 剧本编辑器**。它是一个前后端一体的单页应用：

- **资产管理**：管理角色（characters）、角色表情差分（expressions）、各类素材（assets），素材文件存储在腾讯云 COS 对象存储上，数据库只保存对象 key。
- **剧本编辑**：以 Notion 式的块（block）编辑器维护剧本内容，数据落在 `data/script-doc.json`。**不要把剧本转换回 Ren'Py 代码**，编辑目标就是结构化块文档。

面向用户的所有 UI 文案是中文；**代码（标识符、注释、变量名）中不要出现中文**。

## 2. 技术栈与目录结构

- 运行时：Node.js >= 20，ESM（`"type": "module"`）
- 后端：Express 4 + better-sqlite3 12（同步 SQLite）+ 腾讯云 COS（自实现签名，未用官方 SDK）
- 前端：原生 JavaScript SPA，无框架、无打包器（字符串模板 + `innerHTML` + `data-*` 事件委托）
- 依赖仅两个：`express`、`better-sqlite3`

```
asset-manager/
├── .github/workflows/deploy.yml   # 推送 main 自动部署
├── public/                        # 前端静态资源（由 Express 直接托管）
│   ├── index.html                 # 页面骨架：资产 tab + 剧本 tab
│   ├── app.js                     # 全部前端逻辑（单文件 SPA）
│   └── styles.css
├── server/
│   ├── config.js                  # 读取 .env → CONFIG；cosReady()
│   ├── db.js                      # SQLite 建表/迁移/roster 同步
│   ├── cos.js                     # COS 签名、presign、列举/删除对象
│   ├── script.js                  # 剧本文件 + 块文档读写、场景增删
│   └── index.js                   # Express 入口与全部路由
├── data/                          # 运行时数据（.gitignore，不入库）
│   ├── assets.db / -shm / -wal    # SQLite 库文件
│   ├── roster.json                # 初始名册种子（角色 + 素材）
│   ├── script-doc.json            # 剧本块文档（唯一事实来源）
│   └── script.rpy                 # 受管剧本副本（seed 自 SCRIPT_SOURCE）
├── .env.example                   # 环境变量模板
├── .gitignore
└── package.json
```

## 3. 启动与开发命令

```bash
npm install
npm start        # node server/index.js
npm run dev      # node --watch server/index.js（热重载）
```

默认监听 `http://127.0.0.1:8787`，静态资源目录为 `public/`。

## 4. 配置（环境变量）

`server/config.js` 会从进程工作目录读取 `.env`（已存在的环境变量优先，不会被覆盖）。`CONFIG` 字段：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `DB_PATH` | `./data/assets.db` | SQLite 文件 |
| `SCRIPT_PATH` | `./data/script.rpy` | 受管剧本副本 |
| `SCRIPT_SOURCE` | 空 | 首次读取时作为种子来源 |
| `SCRIPT_DOC_PATH` | `./data/script-doc.json` | 剧本块文档 |
| `ROSTER_PATH` | `./data/roster.json` | 名册种子 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 空 | COS 密钥（仅服务端，切勿下发前端） |
| `COS_BUCKET` | `paradise-lost-1301848969` | 存储桶 |
| `COS_REGION` | `ap-nanjing` | 地域 |
| `COS_DOMAIN` | 桶域名 | 会去掉末尾 `/` |
| `COS_CDN_DOMAIN` | 空 | CDN 加速域名；设置后所有读取 URL 走 CDN，末尾 `/` 会被去掉 |
| `COS_PREFIX` | `Paradise Lost/game/` | 对象前缀 |

`cosReady()` 在 `secretId && secretKey && bucket && region` 全有值时为真；缺失时上传/预览会失败（启动日志会告警）。

## 5. 数据模型（SQLite）

`server/db.js` 打开数据库后设置 `journal_mode=WAL`、`foreign_keys=ON`，建表并做最小迁移。

- `characters(id, name, display_name, note, avatar_key, avatar_crop, sort_order, created_at, updated_at)`
  - `avatar_crop` 为归一化裁剪矩形 JSON 字符串 `{x,y,w,h}`（0~1），经 `normalizeCrop()` 校验。
- `expressions(id, character_id → characters ON DELETE CASCADE, name, asset_key, note, sort_order, created_at, updated_at)`
  - 删除角色会级联删除其表情。
- `assets(id, type, name, asset_key, note, sort_order, created_at, updated_at)`
  - `type` 必须属于 `ASSET_TYPES = ["scene","bgm","se","voice","dataset","dynamic"]`。

索引：`expressions(character_id)`、`assets(type)`。

**名册同步**：模块加载时执行 `syncRoster()`，读取 `data/roster.json`（`{characters:[], assets:[]}`），按角色 `name`/`display_name` 与素材 `asset_key` 去重后增量插入，不覆盖人工修改。

## 6. 剧本模型（重要）

剧本的唯一事实来源是 `data/script-doc.json`：

```jsonc
{
  "version": 1,
  "order": ["s1", "s2", "..."],          // 场景顺序
  "labels": {
    "s1": {
      "no": "SCENE 1",
      "title": "...",                     // 可选
      "blocks": [ { "id": "...", "type": "...", ... } ]
    }
  }
}
```

- **一个场景（scene）就是一个 label**，id 形如 `s1`、`s2`。
- `server/script.js` 提供：
  - `readScriptDoc()` / `writeScriptDoc(doc)` / `scriptDocInfo()`
  - `createScene()`：分配下一个 `s{n}`，写入空 blocks，并追加到 `order`
  - `deleteScene(id)`：从 `labels` 与 `order` 移除，并顺带从受管 `.rpy` 中删除对应 `label` 块
  - `readScriptText()` / `writeScriptText()` / `fileInfo()`：受管剧本文本（`.rpy`）
  - `buildModel(text)` / `parseScript(text)`：解析参考用模型
- `readScriptText()` 首次调用时：若受管文件不存在，则从 `SCRIPT_SOURCE` 复制；再不存在则写入 `label start:` 兜底模板。

前端 `public/app.js` 中剧本相关：`scriptLabelList`、`currentScriptLabel`、`labelMeta`、`BLOCK_META`、`CARD_KIND_LABEL`、`newBlockId`、`lineBlock`/`sceneBlock`/`musicBlock` 等构造各类型块；`addScene` / `removeScene` 调用后端场景接口。

## 7. HTTP API（server/index.js）

统一 `express.json({limit:"2mb"})`；异步处理用 `wrap()` 包装；错误由末尾错误中间件返回 `{error}`。

- 元信息
  - `GET /api/status` → `{ cos, counts:{characters,expressions,assets}, assetTypes }`
- 角色
  - `GET /api/characters`、`GET /api/characters/:id`
  - `POST /api/characters`、`PUT /api/characters/:id`、`DELETE /api/characters/:id`
  - `POST /api/characters/:id/expressions`
- 表情
  - `PUT /api/expressions/:id`、`DELETE /api/expressions/:id`
- 素材
  - `GET /api/assets?type=`、`POST /api/assets`、`PUT /api/assets/:id`、`DELETE /api/assets/:id`
- COS
  - `POST /api/cos/presign-upload`（body `{key, contentType?}`）
  - `GET /api/cos/presign-download?key=&expires=`
  - `GET /api/cos/objects?prefix=`（默认用 `COS_PREFIX`）
  - `DELETE /api/cos/objects?key=`（key 也可放 body）
- 剧本
  - `GET /api/script`、`PUT /api/script`（body `{text}`，Ren'Py 文本）
  - `GET /api/script-doc`、`PUT /api/script-doc`（body `{doc}`，块文档）
  - `POST /api/script-scenes`（新建场景）
  - `DELETE /api/script-scenes/:id`（删除场景）
- 静态资源：`express.static(public/)`

列表/详情接口会为对象 key 附加 `url` 与 `previewUrl`（图片走 `imageMogr2` 预览）。读取 URL 优先使用 `COS_CDN_DOMAIN`（CDN 加速），未配置时回退桶域名 / presignGet 签名；上传（presign-upload）与服务端 COS 调用始终走桶源站。

## 8. COS 模块（server/cos.js）

自实现签名（HMAC-SHA1），主要导出：`MIME`、`mimeFor`、`hostFor`、`toObjectKey`、`toRelativeKey`、`readBase`、`publicUrl`、`cdnUrl`、`imagePreviewUrl`、`presign`、`presignPut`、`presignGet`、`listObjects`、`deleteObject`、`status`。默认签名有效期 `EXPIRES = 3600` 秒。

前端上传流程：`app.js` 的 `uploadToCos()` 先取 presign-upload，再 PUT 到 COS，最后把返回的相对 key 保存进数据库。

## 9. 前端结构（public/app.js）

单文件 SPA，关键结构：

- 全局 `state`、`NAV`/`NAV_ITEMS`
- 工具：`escapeHtml`、`api()`、`toast()`、裁剪工具 `parseCrop`/`serializeCrop`/`cropRectStyle`/`defaultCrop`/`initCropEditor`
- 渲染：`renderNav`、`renderList`、`renderDetail`（→ `renderCharacterDetail`/`renderAssetDetail`/`renderObjectDetail`）、`render`、`previewHtml`
- 剧本：见第 6 节

页面有两个顶层 tab：`assets`（资产管理）与 `script`（剧本），对应 `#view-assets` / `#view-script`。

## 10. 部署（自动）

**方式**：GitHub Actions，推送 `main` 或手动 `workflow_dispatch` 触发。工作流文件 `.github/workflows/deploy.yml`。

流程：checkout → 打 tar 包（排除 `.git`/`.github`/`node_modules`/`data`/`.env`）→ 配置 SSH → `scp` 上传到 `/tmp` → SSH 远端解包 → `node --check server/index.js` 与 `server/script.js` → `npm install --omit=dev` → 写 `.deployed-sha` → `systemctl restart paradise-asset-manager` → `curl` 健康检查 `http://127.0.0.1:8787/`。

需要配置的 GitHub Secrets：

- `SSH_HOST`：服务器公网 IP
- `SSH_USER`：SSH 用户
- `SSH_PRIVATE_KEY`：专用部署私钥内容
- `SSH_PORT`（可选，默认 22）
- `DEPLOY_PATH`（可选，默认 `/opt/paradise-asset-manager`）

服务器拓扑要点：

- 部署目录 `/opt/paradise-asset-manager`（**不是** git 仓库，仅接收 tar 包）
- systemd 单元 `paradise-asset-manager`，`WorkingDirectory` 为部署目录，`ExecStart=/usr/bin/node server/index.js`
- 服务监听 `127.0.0.1:8787`
- 服务器**无法访问 github.com**（返回 000），但可访问 npm registry。因此部署使用增量 `npm install --omit=dev`，**不要改成 `npm ci`**（会尝试从 GitHub 拉取预编译产物而失败）。
- `data/` 与 `.env` 在服务器上长期保留，部署包不覆盖它们。

## 11. 约定与红线

- **代码中不要出现中文**（标识符/注释/变量名）；用户界面文案是中文。
- **绝不提交** `.env` 与 `data/`（已在 `.gitignore`）。COS 密钥仅服务端使用，不得下发浏览器。
- 剧本的编辑载体是 `data/script-doc.json` 块文档，**不要把剧本转换回 Ren'Py 代码**。
- 修改深链/部署相关行为时，保持 tar 排除项与 `npm install --omit=dev` 策略，否则会破坏服务器状态或部署失败。
- Git 远端：`https://github.com/An-n-ya/paradise-asset-manager.git`，主分支 `main`。除非用户明确要求，不要主动提交/推送。
