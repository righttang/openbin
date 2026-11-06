# RemindMe for iOS

原生 SwiftUI 客户端，iOS 17 及以上。默认连接 Tomubuntu `http://192.168.50.84:1453`，与网页共用生产 PostgreSQL。没有注册、登录、验证码或模型密钥输入页面。

## 使用上的变化

| 原来的阻力 | 第一版处理方式 |
| --- | --- |
| 四个入口同等突出 | 底部只有「扫描」「查找」；照片历史在右上角时钟，地点管理在更多菜单 |
| 系统相机每张都要退出 | 原生取景；按快门即保存和上传，取景画面保持打开 |
| 拍完不知道处理到哪 | 每张缩略图显示上传、识别、完成状态，可单独取消 |
| 查看结果需要找历史 | 直接点最近照片查看本次结果，再点物品看裁剪图 |
| 查找页一开始是空白 | 直接显示最近物品；按名称、描述、别名、地点搜索和筛选 |
| 删错后难恢复 | 物品左滑或详情页删除，底部提供撤销；地点删除也可撤销 |
| 照片误删会影响物品 | 删除历史前说明只撤回独有结果，并确认不可撤销；其他照片支持的物品保留 |

网页同步增加「最近看到」列表和直达单张照片识别结果的链接。

## 在手机上使用

1. 与 Tomubuntu 连接同一家庭网络，打开 RemindMe。
2. 首次使用允许 iOS 的「本地网络」「相机」权限。这是系统隐私权限，不是应用登录。
3. 选地点或添加地点，点拍照。快门后自动识别，可继续拍。
4. 右上角时钟查看照片历史；查找页点物品看裁剪图和最后位置。

服务器地址可在「更多 → 服务器连接」修改。相册使用系统 PhotosPicker，无需读取整个照片库。
第二张照片没有出现的物品不会自动删除；保留最后一次记录，需要时手动删除。

## 恢复和边界

- JPEG 缩小到最长边 1600 px；拍摄时的地点固定到该照片。
- 每张照片先原子写入应用私有目录，再上传。最多同时上传两张，识别不占上传通道。
- 创建、上传和封存沿用相同 UUID 与 SHA-256，安全重试丢失响应；服务器确认接受后才删除本地上传原图。
- 上传过期会保留手机原图，点重试即可重新上传，并保留原拍摄时间。离线补传按拍摄先后更新记录，较旧的照片不会覆盖较新的物品信息。
- 取消意图先落盘，服务器确认取消后清除本地照片。断网取消、重启恢复、请求乱序有测试覆盖。
- 待上传上限 30 张或 100 MiB，满后提示；不淘汰尚未确认的照片。完成缓存随服务器历史刷新清理。
- iOS 可能暂停后台上传。未上传完时保持应用前台；退出后重新打开继续。已确认上传的识别在服务器继续。
- 离线可查看缓存文字记录，图片不保证离线可用。离线拍摄仍保存到手机。切换服务器前需完成或取消待处理照片。
- 当前服务返回最近 100 张历史和最多 200 条搜索结果，可按地点或关键词缩小范围。
- 模拟器没有真实后置摄像头，会提供提示。真实取景需在 iPhone 上使用。

## 构建

仓库包含可直接打开的 `RemindMe.xcodeproj`，无需第三方 iOS 依赖。

```sh
open ios/RemindMe.xcodeproj
```

选择 RemindMe scheme 和 iPhone 模拟器后 Run。真机在 Signing & Capabilities 选择已有 Apple 开发团队。证书、私钥、provisioning profiles 留在 Xcode/钥匙串，不入库。

```sh
xcodebuild -project ios/RemindMe.xcodeproj -scheme RemindMe \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath ios/build-device DEVELOPMENT_TEAM=YOUR_TEAM_ID build
xcrun devicectl device install app --device YOUR_DEVICE \
  ios/build-device/Build/Products/Release-iphoneos/RemindMe.app
```

新增 Swift 文件后可运行 `ruby ios/generate-project.rb`（需要 `xcodeproj` Ruby gem；打开工程不需要）。图标生成器在 `ios/scripts/generate-icon.swift`。

## 测试

```sh
# 无需服务器：队列持久化、取消竞态、丢失 ACK、并发、恢复、照片处理。
xcodebuild test -project ios/RemindMe.xcodeproj -scheme RemindMe \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:RemindMeTests/CaptureQueueTests

# 在 Xcode 创建名为 RemindMe QA 的 iPhone 模拟器。
# 先启动本地测试服务器，再跑 PostgreSQL API 和原生界面验收。
python3 ios/scripts/test-local.py
```

集成脚本检查本地测试 PostgreSQL 配置。API 和界面测试只连接 Mac 的 `127.0.0.1:1453`，不会向 Tomubuntu 写测试数据。界面测试检查无登录启动、查找、物品详情、删除撤销与照片历史，并保存 XCTest 截图。

## 实现参考

相机采用 Apple 的 [AVFoundation 捕获会话](https://developer.apple.com/documentation/avfoundation/setting-up-a-capture-session)。内网访问声明[本地网络用途](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)，HTTP 例外仅配置私有 IPv4 网段和 localhost，参见 [ATS 本地网络设置](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)。
