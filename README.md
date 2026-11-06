# RemindMe

家中物品查找工具：选一个抽屉、盒子或架子，拍一组照片，后台自动更新物品记录。之后按名称、描述或别名搜索，查看位置、最后看到的时间和数量。

第一版基于 [OpenBin](https://github.com/akifbayram/openbin/tree/7ffc01a086c8d8c52afcb8db2faed50b93a3d3d5)，基线固定为 `7ffc01a086c8d8c52afcb8db2faed50b93a3d3d5`。保留家庭位置、区域、收纳容器和搜索功能，本地版无需登录和注册。[原项目说明](README.upstream.md)、[许可证](LICENSE) 和代码中的版权声明保留；本项目使用自托管社区版本。详细设计见 [PLAN.md](PLAN.md)。

## 本地运行

需要 Node.js 22 或更新版本、npm，以及可接收多张图片的 OpenAI 兼容 LiteLLM 服务。

```sh
npm ci
npm --prefix server ci
npm run setup:local
# 编辑 .env 中的 AI_ENDPOINT_URL / AI_API_KEY / AI_MODEL
npm run dev:all
```

打开 <http://localhost:5173/remindme> 即可使用，不需要注册或登录。首次运行自动创建“我的家”，然后添加收纳容器。OpenBin 中的 Location 表示家庭或场所，Area 表示房间或柜子，Bin 表示本次拍摄的抽屉、盒子或架子。新拍摄流程从 RemindMe 入口进入。

`REMINDME_LOCAL_MODE=true` 启用共享家庭模式：所有能够访问服务的设备共用同一份物品数据，账号管理和登录注册接口关闭，写请求仍校验 CSRF。仅在 `SELF_HOSTED=true` 时生效。已有数据可通过 `REMINDME_LOCAL_USER_ID` 指定原用户 ID 继续使用；未指定时创建独立本地档案，不删除或合并旧账号。此模式用于受信任的家庭局域网。需要恢复账号访问时设置 `REMINDME_LOCAL_MODE=false` 并重启。

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

## 拍摄和恢复

1. 选择收纳容器，在线开始新一批拍摄，服务端先分配顺序号。
2. 添加全景及细节照片，每批最多 20 张，单张上传不超过 5 MiB。
3. 完成拍摄并上传。上传过程中保持页面打开；Safari 锁屏或退出可能中断尚未完成的上传。
4. 只有服务器接受完整批次后，页面才显示可以离开。识别在服务端继续，不需要 Apply 或确认。
5. 后续通过 RemindMe 搜索查看结果。未在新照片里出现的物品保留最后已知位置；未知数量不会被猜成 1。

支持 JPEG、PNG、WebP。照片在浏览器和服务端按方向旋转并缩小；无法解码的 HEIC 请转成 JPEG，或在 iPhone 相机里使用“兼容性最佳”。浏览器通过有容量限制的 IndexedDB 保存待上传照片；重新打开后按原批次和照片 ID 恢复。浏览器清理本地存储时，需要重新选择缺失的照片。

成功或被更新批次取代后，立即删除服务端临时原图。删除失败会重试；上传未完成和最终识别失败的原图默认 1 小时过期。照片历史另保留压缩预览和物品裁剪图，存入 SQLite，随数据库一起备份；不保存 base64 或模型原始响应。

### 照片识别历史和详情

每张照片独立显示识别状态及该照片支持的物品结果。点物品可查看局部裁剪、数量、描述、别名和位置。裁剪来自照片实际像素，模型提供定位框；无法定位时显示整张预览并说明原因。升级之前已删除的照片只有文字结果，不能补回预览或裁剪图。

点历史卡片右上角的叉会删除该照片记录和保留的图片，并撤掉只由它支持的识别结果。同一物品如果还有其他照片记录，继续保留，恢复为剩余记录中的最近信息；手动录入或后来手动修改的物品不被无条件覆盖。删除正在识别的照片也不会让其结果在任务结束后重新出现。

预览最长边 960 像素、单张不超过 256 KiB；物品裁剪最长边 512 像素、单张不超过 128 KiB。`CAPTURE_HISTORY_QUOTA_BYTES` 默认给历史图片 512 MiB 预算；达到预算后继续保留文字结果，不自动删除旧记录。删除图片释放的是可复用的 SQLite 空间，数据库文件不一定立刻缩小。

## Capture API

本地共享模式无需登录：先 GET `/api/auth/me` 获取 `openbin-csrf` cookie，写请求同时携带该 cookie 和同值的 `X-CSRF-Token` 请求头。关闭本地模式后需要登录 cookie（写请求携带 CSRF token）或应用 API key。LiteLLM Key 仅供服务端调用模型，不能用作应用 API key。v1 使用单进程 SQLite。

| 接口 | 内容 |
| --- | --- |
| `GET /api/captures/config` | 图片数量、大小、格式限制及模型是否已配置 |
| `POST /api/captures` | `{id, bin_id, source?, device_id?, event_id?, captured_at?}`；先在线注册，返回固定 `sequence` |
| `PUT /api/captures/:id/photos/:photoId` | 原始图片 body；`Content-Type`、`X-Photo-SHA256`、`X-Photo-Size`；同 ID 同内容可重试 |
| `POST /api/captures/:id/complete` | `{photos:[{id, sha256, size, order}]}`；所有照片收到后才封存并入队 |
| `GET /api/captures/:id` | 批次 `state`、逐图 `received_at`、任务错误类别、`cleanup_completed_at` |
| `GET /api/captures?bin_id=…` | 最近批次，返回 `{captures:[…]}` |
| `GET /api/captures/history?bin_id=…&location_id=…` | 按照片分组的历史、预览链接和识别结果 |
| `GET /api/captures/:id/photos/:photoId/preview` | 读取保留的照片预览 |
| `GET /api/captures/observations/:observationId/photos/:photoId/crop` | 读取物品局部裁剪图 |
| `DELETE /api/captures/:id/photos/:photoId/history` | 删除该照片记录并撤回独有的识别结果 |
| `GET /api/captures/inventory?q=…&location_id=…&bin_id=…` | 名称、别名、描述及位置搜索，返回 `{items:[…]}`；筛选参数可选 |

批次和照片 ID 使用客户端生成的 UUID。照片校验使用 SHA-256 十六进制，`order` 从 0 连续编号。完成后清单不可改变；网络中断必须复用原 ID。响应状态可能是 `uploading / queued / processing / applied / superseded / failed / expired`；只有退出 `uploading` 且服务器已接受完整批次后，客户端才能清理本地照片。`expired` 的上传未被接受，不可误报成功。

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

打开 `http://<服务器内网 IP>:1453/remindme`。默认只绑定 `127.0.0.1`，供同机反向代理使用；需要手机直接访问时，将 `HOST_BIND_IP` 设为服务器局域网地址。可信 HTTPS 入口使用 `COOKIE_SECURE=true`，`CORS_ORIGIN` 设为实际 HTTPS 地址；代理配置同时遵循上游的 `TRUST_PROXY` 设置。

Compose 使用独立的 `remindme_data` 数据 volume 和 `remindme_scratch` 临时图片 volume，容器根文件系统只读，支持健康检查、自动重启和优雅停止。`docker compose down` 保留数据；不要使用 `down -v`，除非确实要清空实例。更新时重新构建并执行 `up -d --wait` 即可。

新实例不需要设置 `REMINDME_LOCAL_USER_ID`，会自动创建“我的家”。从 Mac 迁移已有记录时，应复制一致的 SQLite 备份到数据 volume 的 `/data/remindme.db`，并保留对应的 `REMINDME_LOCAL_USER_ID` 和 `JWT_SECRET`。不要复制正在写入的数据库文件而漏掉 WAL；使用 SQLite 备份或先停止应用再复制。

当前拍摄、历史和裁剪功能只支持 SQLite 与单应用进程，不能通过设置 `DATABASE_URL` 直接改为 PostgreSQL。该 Compose 明确清空 `DATABASE_URL`，防止误连共享数据库；SQLite volume 必须放在服务器本地磁盘。

备份数据库和安全保存的配置，排除整个 `remindme_scratch` volume。数据库备份包含历史预览和裁剪图；已有备份中的图片不会随在线记录删除而自动抹除。恢复后缺失输入的未完成任务会失败，不会生成虚假库存。应用备份保留 OpenBin 的普通附件目录；RemindMe 临时原图不放入该目录。

识别请求发送 `no-log: true`、`store: false` 及禁用缓存选项。LiteLLM 的日志策略仍需允许这些设置；上线前检查代理、回调和推理供应商的保留策略。参考 [LiteLLM 日志配置](https://docs.litellm.ai/docs/proxy/logging)。

可调参数见 [.env.example](.env.example) 的 RemindMe 部分。默认并发为 1，scratch 预算 512 MiB（含 32 MiB 预留空间），最低空闲磁盘 64 MiB。
