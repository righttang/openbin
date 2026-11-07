import SwiftUI

@main struct RemindMeApp: App {
    @UIApplicationDelegateAdaptor(RemindMeAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            HomeView().environmentObject(store).tint(Color.accentColor)
                .task { if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil { await store.activate() } }
                .onChange(of: phase) { _, next in
                    if next == .active && ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil { Task { await store.activate() } }
                    else if next == .background { store.queue.stop(); Task { await PhotoImageLoader.shared.clear() } }
                }
        }
    }
}

enum LibrarySheet: String, Identifiable { case places, history, connection; var id: String { rawValue } }
struct HomeView: View {
    @EnvironmentObject var store: AppStore
    @State private var tab = 0
    @State private var sheet: LibrarySheet?
    var body: some View {
        TabView(selection: $tab) {
            NavigationStack {
                ScanView(queue: store.queue, managePlaces: { sheet = .places })
                    .toolbar { tools }.safeAreaInset(edge: .bottom) { UndoBanner() }
            }.tabItem { Label("扫描", systemImage: "camera.fill") }.tag(0)
            NavigationStack {
                FindView().toolbar { tools }.safeAreaInset(edge: .bottom) { UndoBanner() }
            }.tabItem { Label("查找", systemImage: "magnifyingglass") }.tag(1)
        }
        .sheet(item: $sheet) { target in
            NavigationStack {
                Group {
                    switch target {
                    case .places: PlacesView { tab = 0; sheet = nil }
                    case .history: HistoryView()
                    case .connection: ConnectionView()
                    }
                }.toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { sheet = nil } } }
            }
        }
    }
    @ToolbarContentBuilder private var tools: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) { Button { sheet = .history } label: { Image(systemName: "clock") }.accessibilityLabel("照片历史") }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("管理地点", systemImage: "mappin.and.ellipse") { sheet = .places }
                Button("服务器连接", systemImage: "wifi") { sheet = .connection }
            } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("更多")
        }
    }
}

struct UndoBanner: View {
    @EnvironmentObject var store: AppStore
    @State private var busy = false
    var body: some View {
        if let last = store.undo.last {
            HStack {
                Text("已删除“\(last.name)”").font(.subheadline).lineLimit(2)
                Spacer()
                Button("撤销") { busy = true; Task { await store.undoLast(); busy = false } }.fontWeight(.semibold).disabled(busy)
            }.padding().background(.regularMaterial).accessibilityElement(children: .contain)
        }
    }
}

struct LocalThumbnail: View {
    let url: URL
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            if let image { Image(uiImage: image).resizable().scaledToFill() }
            else { Rectangle().fill(.quaternary).overlay { Image(systemName: "photo").foregroundStyle(.secondary) } }
        }.task(id: url) { image = try? await PhotoImageLoader.shared.image(url, maxPixels: 240) }
            .onDisappear { image = nil }
    }
}
struct CaptureThumbnail: View {
    @EnvironmentObject var store: AppStore
    let draft: PhotoDraft
    let queue: CaptureQueue
    var body: some View {
        if let photo = store.history.first(where: { $0.capture_id == draft.id && ["applied", "superseded"].contains($0.state) }), let preview = photo.preview_url {
            RemotePhoto(path: preview)
        } else { LocalThumbnail(url: queue.thumbnailURL(draft.id)) }
    }
}
struct RemotePhoto: View {
    @EnvironmentObject var store: AppStore
    let path: String?
    var fallback: String? = nil
    var fit = false
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            if let image {
                if fit { Image(uiImage: image).resizable().scaledToFit() }
                else { Image(uiImage: image).resizable().scaledToFill() }
            } else { Rectangle().fill(.quaternary).overlay { Image(systemName: "photo").foregroundStyle(.secondary) } }
        }.task(id: "\(store.server)|\(path ?? "")|\(fallback ?? "")|\(fit)") {
            image = nil
            for source in [path, fallback] {
                guard let url = store.imageURL(source) else { continue }
                do {
                    let loaded = try await PhotoImageLoader.shared.image(url, maxPixels: fit ? 1200 : 240)
                    try Task.checkCancellation(); image = loaded; break
                } catch { if Task.isCancelled { return } }
            }
        }.onDisappear { image = nil }
    }
}

struct ConnectionNote: View {
    @EnvironmentObject var store: AppStore
    var body: some View {
        if let error = store.error {
            HStack(alignment: .top) {
                Image(systemName: store.connected ? "exclamationmark.circle" : "wifi.slash")
                Text(error).font(.footnote)
                Spacer(minLength: 0)
                Button("重试") { Task { await store.activate() } }.font(.footnote.weight(.semibold))
            }.padding().background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}
