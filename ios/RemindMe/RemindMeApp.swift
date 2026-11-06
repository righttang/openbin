import SwiftUI

@main struct RemindMeApp: App {
    @StateObject private var store = AppStore()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            HomeView().environmentObject(store).tint(Color.accentColor)
                .task { if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil { await store.activate() } }
                .onChange(of: phase) { _, next in
                    if next == .active && ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil { Task { await store.activate() } }
                    else if next == .background { store.queue.stop() }
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
    var body: some View {
        if let image = UIImage(contentsOfFile: url.path) { Image(uiImage: image).resizable().scaledToFill() }
        else { Rectangle().fill(.quaternary).overlay { Image(systemName: "photo").foregroundStyle(.secondary) } }
    }
}
struct RemotePhoto: View {
    @EnvironmentObject var store: AppStore
    let path: String?
    var fallback: String? = nil
    var fit = false
    @State private var useFallback = false
    var body: some View {
        AsyncImage(url: store.imageURL(useFallback ? fallback : path)) { phase in
            if let image = phase.image {
                if fit { image.resizable().scaledToFit() } else { image.resizable().scaledToFill() }
            } else {
                Rectangle().fill(.quaternary).overlay { Image(systemName: phase.error == nil && path != nil ? "photo" : "photo.badge.exclamationmark").foregroundStyle(.secondary) }
                    .onChange(of: phase.error != nil, initial: true) { _, failed in
                        if failed && fallback != nil && !useFallback { useFallback = true }
                    }
            }
        }.onChange(of: path) { _, _ in useFallback = false }
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
