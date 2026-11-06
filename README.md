# RemindMe

提供 [原生 iOS 客户端](ios/README.md)：内网免登录，持续取景拍摄、自动识别、物品查找与删除撤销。用 Xcode 打开 `ios/RemindMe.xcodeproj` 即可构建。

家中物品查找工具：选一个地点，点拍照直接打开相机；每拍一张便自动上传识别，可以接着拍下一张。之后按名称、描述或别名搜索，查看位置、最后看到的时间和数量。

第一版基于 [OpenBin](https://github.com/akifbayram/openbin/tree/7ffc01a086c8d8c52afcb8db2faed50b93a3d3d5)，基线固定为 `7ffc01a086c8d8c52afcb8db2faed50b93a3d3d5`。界面只提供扫描、查找、地点管理和照片历史四个平级页面，无需登录和注册。[原项目说明](README.upstream.md)、[许可证](LICENSE) 和代码中的版权声明保留；本项目使用自托管社区版本。详细设计见 [PLAN.md](PLAN.md)。

## 本地运行

需要 Node.js 22 或更新版本、npm，以及可接收多张图片的 OpenAI 兼容 LiteLLM 服务。

```sh
npm ci
npm --prefix server ci
npm run setup:local
# 编辑 .env 中的 AI_ENDPOINT_URL / AI_API_KEY / AI_MODEL
npm run dev:all
```

打开 <http://localhost:5173> 即可使用，不需要注册或登录。先添加一个地点，例如“书桌抽屉”，然后拍照。地点是平级列表，不需要创建家庭、区域或多层容器。

- **扫描** `/scan`：选地点、拍照并提交后台识别。
- **查找** `/find`：按名称、描述或别名搜索，查看地点与物品裁剪图，删除不需要的物品并支持撤销。
- **地点** `/places`：新增、改名和删除地点。
- **历史** `/history`：按照片查看结果、筛选地点、删除不需要的记录。

`REMINDME_LOCAL_MODE=true` 启用共享家庭模式：所有能够访问服务的设备共用同一份物品数据，账号管理和登录注册接口关闭，写请求仍校验 CSRF。仅在 `SELF_HOSTED=true` 时生效。已有数据可通过 `REMINDME_LOCAL_USER_ID` 指定原用户 ID 继续使用；未指定时创建独立本地档案，不删除或合并旧账号。此模式用于受信任的家庭局域网。

`.env` 不进入 Git，初始化不会覆盖已有配置。服务端读取密钥，浏览器不会获得它。本地数据库位于 `server/data/remindme.db`，临时照片位于 `server/capture-scratch/`。开发命令从 `server/` 启动 API，因此 `.env` 中的相对存储路径以该目录为准。

```dotenv
AI_PROVIDER=openai-compatible
AI_ENDPOINT_URL=http://your-litellm-host:4000/v1
AI_API_KEY=your-application-specific-key
AI_MODEL=home-vision
```

### 同一 Wi-Fi 下用 iPhone 测试

先停止正在运行的 `dev:all`，然后执行：

```sh
npm run dev:lan
# Mac 当前 Wi-Fi 地址通常可这样查看；若无输出，在系统设置 → Wi-Fi → 详细信息中查看
ipconfig getifaddr en0
```

手机与 Mac 连接同一 Wi-Fi，在 Safari 打开 `http://<Mac 的内网 IP>:5173/remindme` 即可直接使用。保留 Mac 终端运行；若 macOS 防火墙提示，请允许 Node 接收本地网络连接。浏览器通过 Vite 代理访问 API，不需要另外打开 API 端口。

本地 HTTP 支持照片选择和系统拍照上传；“拍照”使用文件选择器的相机提示，由浏览器决定是否直接打开系统相机。它不提供需要安全上下文的网页内实时相机。UUID 始终使用安全随机数；SHA-256 在 WebCrypto 不可用时使用固定版本的 `@noble/hashes`，保留 CSRF 校验。本方式仅供受信任 Wi-Fi 下本地测试；正式访问仍使用 HTTPS。

## 本地 Postgres 测试库

Tomubuntu 使用独立的生产数据库；本地测试不会连接生产库。本地开发可启动持久化的 Postgres 16：

```sh
docker compose -f docker-compose.remindme.test.yml up -d --wait
```

本地 `.env` 设置：

```dotenv
DATABASE_URL=postgres://openbin_test:openbin_test@127.0.0.1:5433/remindme_local_test
```

然后运行 `npm run dev:all`。测试数据库只绑定本机 5433 端口；数据保存在 `remindme-postgres-test-data` volume，普通停止、重启不会清空。初次启动还会创建 `openbin_test`、`remindme_capture_test`、`remindme_migration_test`，供自动化测试重建；日常开发数据放在 `remindme_local_test`，不使用这些会被清理的测试库。

```sh
# PostgreSQL 上的完整拍照、识别、历史和并发验证
REMINDME_TEST_DATABASE_URL=postgres://openbin_test:openbin_test@127.0.0.1:5433/remindme_capture_test npm --prefix server test -- --config vitest.captures-pg.config.ts
# SQLite → PostgreSQL 导入、内容校验与回滚测试
MIGRATION_TEST_DATABASE_URL=postgres://openbin_test:openbin_test@127.0.0.1:5433/remindme_migration_test node --test server/scripts/migrate-sqlite-to-postgres.test.mjs
```

## 拍摄和恢复

1. 选择地点，点“拍照”直接打开系统相机，也可以从相册选择照片。
2. 每张照片回到页面后自动保存、上传并开始识别，不需要先开始一批或再点提交。
3. 页面保持可继续拍照，每张照片分别显示上传、识别、完成或失败状态；识别上一张时可以继续下一张。
4. 拍错了可点该照片的取消。取消会停止排队或尽力中止正在进行的模型请求，撤回这张照片的独有结果；其他照片支持的物品继续保留。离线取消会保留取消意图，联网后重试。
5. 上传尚未确认时保持页面打开；只有服务器确认收到之后，识别才可独立于页面继续。上传失败可重试，重试使用相同 ID，不重复生成记录。
6. 查找页可删除单个物品，删除后可撤销。第二张没拍到的物品继续保留最后一次记录，不会因局部照片未出现而自动删除。

新扫描每张照片是独立的 `web-instant` 任务。较早照片因慢上传或重试而晚完成时，其中独有物品仍会加入记录，同一物品较新的识别信息不会被旧照片覆盖。旧版本已保存的多图草稿仍可按原清单恢复。

支持 JPEG、PNG、WebP。照片在浏览器和服务端按方向旋转并缩小；无法解码的 HEIC 请转成 JPEG，或在 iPhone 相机里使用“兼容性最佳”。浏览器通过有容量限制的 IndexedDB 保存待上传照片；重新打开后按原批次和照片 ID 恢复。浏览器清理本地存储时，需要重新选择缺失的照片。

成功或取消后，清理服务端临时原图；旧版整批任务被更新批次取代时也会清理。删除失败会重试；上传未完成和最终识别失败的原图默认 1 小时过期。照片历史另保留压缩预览和物品裁剪图，存入数据库（PostgreSQL 或 SQLite），随数据库一起备份；不保存 base64 或模型原始响应。

### 照片识别历史和详情

每张照片独立显示识别状态及该照片支持的物品结果。点物品可查看局部裁剪、数量、描述、别名和位置。裁剪来自照片实际像素，模型提供定位框；无法定位时显示整张预览并说明原因。升级之前已删除的照片只有文字结果，不能补回预览或裁剪图。

点历史卡片右上角的叉会删除该照片记录和保留的图片，并撤掉只由它支持的识别结果。同一物品如果还有其他照片记录，继续保留，恢复为剩余记录中的最近信息；手动录入或后来手动修改的物品不被无条件覆盖。删除正在识别的照片也不会让其结果在任务结束后重新出现。

预览最长边 960 像素、单张不超过 256 KiB；物品裁剪最长边 512 像素、单张不超过 128 KiB。`CAPTURE_HISTORY_QUOTA_BYTES` 默认给历史图片 512 MiB 预算；达到预算后继续保留文字结果，不自动删除旧记录。删除图片后数据库空间可被后续写入复用，存储文件不一定立刻缩小。

## Capture API

本地共享模式无需登录：先 GET `/api/auth/me` 获取 `openbin-csrf` cookie，写请求同时携带该 cookie 和同值的 `X-CSRF-Token` 请求头。关闭本地模式后需要登录 cookie（写请求携带 CSRF token）或应用 API key。LiteLLM Key 仅供服务端调用模型，不能用作应用 API key。支持 PostgreSQL 和 SQLite；临时原图仍由单个应用实例管理。

| 接口 | 内容 |
| --- | --- |
| `GET /api/captures/config` | 图片数量、大小、格式限制及模型是否已配置 |
| `POST /api/captures` | `{id, bin_id, source?, device_id?, event_id?, captured_at?}`；先在线注册，返回固定 `sequence` |
| `PUT /api/captures/:id/photos/:photoId` | 原始图片 body；`Content-Type`、`X-Photo-SHA256`、`X-Photo-Size`；同 ID 同内容可重试 |
| `POST /api/captures/:id/complete` | `{photos:[{id, sha256, size, order}]}`；所有照片收到后才封存并入队 |
| `POST /api/captures/:id/cancel` | `{bin_id}`；幂等取消，撤回独有结果；先于创建到达的取消也阻止迟到创建复活 |
| `GET /api/captures/:id` | 批次 `state`、逐图 `received_at`、任务错误类别、`cleanup_completed_at` |
| `GET /api/captures?bin_id=…` | 最近批次，返回 `{captures:[…]}` |
| `GET /api/captures/history?bin_id=…&location_id=…` | 按照片分组的历史、预览链接和识别结果 |
| `GET /api/captures/:id/photos/:photoId/preview` | 读取保留的照片预览 |
| `GET /api/captures/observations/:observationId/photos/:photoId/crop` | 读取物品局部裁剪图 |
| `DELETE /api/captures/:id/photos/:photoId/history` | 删除该照片记录并撤回独有的识别结果 |
| `GET /api/captures/inventory?q=…&location_id=…&bin_id=…` | 名称、别名、描述及位置搜索，返回 `{items:[…]}`；筛选参数可选 |
| `POST /api/items/bulk-delete` | `{ids:[itemId]}`；从查找结果软删除单个物品，保留历史关联 |
| `POST /api/items/bulk-restore` | `{ids:[itemId]}`；撤销物品软删除 |

批次和照片 ID 使用客户端生成的 UUID。照片校验使用 SHA-256 十六进制，`order` 从 0 连续编号。完成后清单不可改变；网络中断必须复用原 ID。响应状态可能是 `uploading / queued / processing / applied / superseded / failed / expired / cancelled`；只有退出 `uploading` 且服务器已接受完整批次后，客户端才能清理本地照片。`expired` 的上传未被接受，不可误报成功；`cancelled` 表示主动取消，不能作为识别成功。

## 校验

```sh
npm run check
npm run build
npm --prefix server run build
npm test -- src/features/remindme
npm --prefix server test -- src/lib/captures src/__tests__/captures.test.ts
# 实际调用 .env 中的模型；生成 20 张数字卡片，只验证多图输入和 JSON 返回
npm run verify:vision -- 20
# 完整 API → 后台识别 → 自动更新 → 删除图片，使用独立临时数据库
server/node_modules/.bin/tsx --env-file=.env server/scripts/smoke-capture.ts
```

`verify:vision` 在内存生成合成图片，不读取私人照片。2026-11-06 已通过 Tomubuntu 的 `chatgpt/gpt-6.1-sol` 完成一次 20 图联合请求和 JSON 校验。该检查不能证明真实抽屉的识别或视觉去重准确率；真实 iPhone 14、HEIC 和遮挡场景仍需实物验收。

## Docker 部署

镜像包含前端和 API，运行时只开放一个端口，不需要 Vite。Dockerfile 使用锁定的 npm 依赖构建两个阶段，运行层以非 root 用户运行；构建上下文只包含代码、静态资源和构建配置，不会复制 `.env`、本地数据库或用户照片。

先准备独立的服务器 `.env`，填入容器可访问的 LiteLLM 地址和密钥。`localhost` 在容器内指向该容器，不代表宿主机。保留现有密钥配置在服务器上，不写入 Git 或镜像。

同一家庭局域网使用 HTTP 的配置示例：

```dotenv
HOST_BIND_IP=192.168.50.84
HOST_PORT=1453
CORS_ORIGIN=http://192.168.50.84:1453
COOKIE_SECURE=false
REMINDME_LOCAL_MODE=true
```

```sh
docker compose -f docker-compose.remindme.yml config --quiet
docker compose -f docker-compose.remindme.yml up --build -d --wait
docker compose -f docker-compose.remindme.yml ps
```

打开 `http://<服务器内网 IP>:1453`。默认只绑定 `127.0.0.1`，供同机反向代理使用；需要手机直接访问时，将 `HOST_BIND_IP` 设为服务器局域网地址。可信 HTTPS 入口使用 `COOKIE_SECURE=true`，`CORS_ORIGIN` 设为实际 HTTPS 地址；代理配置同时遵循上游的 `TRUST_PROXY` 设置。

Compose 使用独立的 `remindme_data` 数据 volume 和 `remindme_scratch` 临时图片 volume，容器根文件系统只读，支持健康检查、自动重启和优雅停止。`docker compose down` 保留数据；不要使用 `down -v`，除非确实要清空实例。更新时重新构建并执行 `up -d --wait` 即可。

新实例不需要设置 `REMINDME_LOCAL_USER_ID`，会自动创建“我的家”。从 Mac 迁移已有记录时，应复制一致的 SQLite 备份到数据 volume 的 `/data/remindme.db`，并保留对应的 `REMINDME_LOCAL_USER_ID` 和 `JWT_SECRET`。不要复制正在写入的数据库文件而漏掉 WAL；使用 SQLite 备份或先停止应用再复制。

PostgreSQL 模式可以复用已有服务，使用独立的 RemindMe 数据库和应用账号。新数据库设置 `DATABASE_URL` 即可；已有 SQLite 数据必须先迁移，不能仅修改连接串。省略 `DATABASE_URL` 时继续使用 SQLite，SQLite volume 必须放在本地磁盘。两种数据库都只运行一个应用实例，因为临时原图仍存放在该实例的 scratch volume。

连接同一台 Docker 主机上已有的 Postgres：

```dotenv
DATABASE_URL=postgres://remindme_app:YOUR_PASSWORD@postgres:5432/remindme
POSTGRES_NETWORK=shared-services
```

```sh
docker compose -f docker-compose.remindme.yml -f docker-compose.remindme.postgres.yml up --build -d --wait
```

覆盖文件只将应用加入指定的已有 Docker 网络，不创建、重启或替换 Postgres。数据库保存物品、照片历史和裁剪图，`remindme_data` volume 继续保留附件及原 SQLite 数据，`remindme_scratch` 仍只保存临时原图。

### 已有 SQLite 数据的可选迁移

新生产实例可以直接从空数据库开始，不必导入测试记录。需要保留旧数据时，先停止源应用并制作一致的 SQLite 备份，再对**空的专用目标数据库**运行导入工具。不要先启动目标应用，否则初始化数据会使导入被拒绝。

```sh
# DATABASE_URL 从安全的本地环境或 env file 提供，不写入脚本
node server/scripts/migrate-sqlite-to-postgres.mjs --source /path/snapshot.db --database-name remindme --dry-run --report /path/dry-run.json
# 仅在验证成功后提交；使用另一个报告路径
node server/scripts/migrate-sqlite-to-postgres.mjs --source /path/snapshot.db --database-name remindme --apply --report /path/applied.json
```

镜像中同一工具位于 `/app/scripts/migrate-sqlite-to-postgres.mjs`。默认完整试导入后回滚；目标已有任何数据时拒绝操作。导入保留 ID、关联、预览和裁剪二进制，并逐表验证数量及内容 SHA-256。文件目录中的普通附件、头像和未完成原图另行迁移；完成切换前保留源数据库及旧配置。

备份数据库和安全保存的配置，排除整个 `remindme_scratch` volume。数据库备份包含历史预览和裁剪图；已有备份中的图片不会随在线记录删除而自动抹除。恢复后缺失输入的未完成任务会失败，不会生成虚假库存。应用备份保留 OpenBin 的普通附件目录；RemindMe 临时原图不放入该目录。

识别请求发送 `no-log: true`、`store: false` 及禁用缓存选项。LiteLLM 的日志策略仍需允许这些设置；上线前检查代理、回调和推理供应商的保留策略。参考 [LiteLLM 日志配置](https://docs.litellm.ai/docs/proxy/logging)。

可调参数见 [.env.example](.env.example) 的 RemindMe 部分。默认并发为 1，scratch 预算 512 MiB（含 32 MiB 预留空间），最低空闲磁盘 64 MiB。
