import SwiftUI
import CryptoKit

struct LibraryCache: Codable { let places: [Place]; let items: [InventoryItem]; let history: [HistoryPhoto] }
struct UndoRecord: Identifiable {
    let id = UUID()
    let name: String
    let itemID: String?
    let placeID: String?
}

@MainActor final class AppStore: ObservableObject {
    @Published var server: String
    @Published var places: [Place] = []
    @Published var items: [InventoryItem] = []
    @Published var history: [HistoryPhoto] = []
    @Published var selectedPlaceID: String { didSet { UserDefaults.standard.set(selectedPlaceID, forKey: "place:\(server)") } }
    @Published var connected = false
    @Published var loading = false
    @Published var error: String?
    @Published var notice: String?
    @Published var undo: [UndoRecord] = []
    @Published var deletedItemIDs: Set<String> = []
    @Published var revision = 0
    @Published var queue: CaptureQueue
    @Published private(set) var preparingPhotos = 0
    private(set) var api: APIClient
    private var locationID: String?
    private var removedPhotoIDs: Set<String> = []
    private var scope: URL
    private var refreshing = false
    private var refreshAgain = false
    var selectedPlace: Place? { places.first { $0.id == selectedPlaceID } }

    init() {
        var address = UserDefaults.standard.string(forKey: "remindme-server") ?? ServerAddress.production
        #if DEBUG
        if let test = ProcessInfo.processInfo.environment["REMINDME_TEST_URL"], let url = URL(string: test), ["localhost", "127.0.0.1"].contains(url.host) { address = test }
        #endif
        let url = (try? ServerAddress.parse(address)) ?? URL(string: ServerAddress.production)!
        server = url.absoluteString
        selectedPlaceID = UserDefaults.standard.string(forKey: "place:\(url.absoluteString)") ?? ""
        scope = Self.folder(url.absoluteString)
        api = APIClient(baseURL: url)
        queue = CaptureQueue(api: api, folder: scope.appendingPathComponent("uploads"))
        loadCache(); wireQueue()
    }
    static func folder(_ server: String) -> URL {
        let hash = SHA256.hash(data: Data(server.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RemindMe/\(hash)")
    }
    private func wireQueue() {
        queue.onChange = { [weak self] in Task { await self?.refresh() } }
    }
    private func loadCache() {
        if let data = try? Data(contentsOf: scope.appendingPathComponent("library.json")), let cached = try? JSONDecoder().decode(LibraryCache.self, from: data) {
            places = cached.places; items = cached.items; history = cached.history
        }
    }
    private func saveCache() {
        try? JSONEncoder().encode(LibraryCache(places: places, items: items, history: history)).write(to: scope.appendingPathComponent("library.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func activate() async { queue.start(); await refresh() }
    func refresh() async {
        guard !refreshing else { refreshAgain = true; return }
        refreshing = true; loading = places.isEmpty
        defer {
            refreshing = false; loading = false
            if refreshAgain { refreshAgain = false; Task { await refresh() } }
        }
        do {
            let profile = try await api.connect(); locationID = profile.activeLocationId
            async let newPlaces = api.places(locationID: profile.activeLocationId)
            async let newItems = api.inventory()
            async let newHistory = api.history()
            let values = try await (newPlaces, newItems, newHistory)
            places = values.0
            items = values.1.filter { !deletedItemIDs.contains($0.id) }
            history = values.2.filter { !removedPhotoIDs.contains($0.id) }
            queue.reconcileHistory(history)
            if !places.contains(where: { $0.id == selectedPlaceID }) { selectedPlaceID = places.first?.id ?? "" }
            connected = true; error = nil; revision += 1; saveCache()
        } catch {
            connected = false
            self.error = "暂时连不上服务器。请检查家庭 Wi-Fi；已保存的照片和记录仍在。"
        }
    }
    func connect(to value: String) async throws {
        let url = try ServerAddress.parse(value)
        if url.absoluteString == server { _ = try await api.connect(); await activate(); return }
        if preparingPhotos > 0 || queue.pendingCount > 0 || queue.unsubmittedCount > 0 { throw APIError.message("请先上传或取消待处理照片，再切换服务器。") }
        let candidate = APIClient(baseURL: url)
        _ = try await candidate.connect()
        if preparingPhotos > 0 || queue.pendingCount > 0 || queue.unsubmittedCount > 0 { throw APIError.message("请先上传或取消待处理照片，再切换服务器。") }
        guard !refreshing else { throw APIError.message("正在刷新，请稍后再试。") }
        queue.stop(); api = candidate; server = url.absoluteString; scope = Self.folder(server)
        queue = CaptureQueue(api: candidate, folder: scope.appendingPathComponent("uploads")); wireQueue()
        places = []; items = []; history = []; undo = []; deletedItemIDs = []; removedPhotoIDs = []
        selectedPlaceID = UserDefaults.standard.string(forKey: "place:\(server)") ?? ""
        UserDefaults.standard.set(server, forKey: "remindme-server")
        loadCache(); await activate()
    }
    func imageURL(_ path: String?) -> URL? {
        guard let path, path.hasPrefix("/api/captures/") else { return nil }
        return URL(string: path, relativeTo: URL(string: server)!)
    }
    func receive(_ data: Data, at place: Place) async {
        preparingPhotos += 1
        let targetQueue = queue
        let capturedAt = captureTimestamp()
        defer { preparingPhotos -= 1 }
        do {
            let jpeg = try await Task.detached(priority: .userInitiated) { try PhotoProcessor.jpeg(data) }.value
            try targetQueue.enqueue(jpeg: jpeg, place: place, capturedAt: capturedAt)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch { self.error = error.localizedDescription }
    }
    func beginImport() { preparingPhotos += 1 }
    func finishImport() { preparingPhotos -= 1 }
    func search(_ query: String, place: String) async throws -> [InventoryItem] {
        if !connected {
            return items.filter { (place.isEmpty || $0.bin_id == place) && (query.isEmpty || ([$0.name, $0.description, $0.bin_name] + $0.aliases).contains { $0.localizedCaseInsensitiveContains(query) }) }
        }
        return try await api.inventory(query: query, placeID: place).filter { !deletedItemIDs.contains($0.id) }
    }
    func deleteItem(_ item: InventoryItem) async {
        do {
            try await api.mutate("/api/items/bulk-delete", body: ["ids": [item.id]])
            deletedItemIDs.insert(item.id); items.removeAll { $0.id == item.id }
            undo.append(.init(name: item.name, itemID: item.id, placeID: nil)); revision += 1; saveCache()
        } catch { self.error = "删除失败，物品仍保留。请重试。" }
    }
    func undoLast() async {
        guard let action = undo.last else { return }
        do {
            if let id = action.itemID { try await api.mutate("/api/items/bulk-restore", body: ["ids": [id]]); deletedItemIDs.remove(id) }
            if let id = action.placeID { try await api.mutate("/api/bins/\(id)/restore") }
            undo.removeAll { $0.id == action.id }; await refresh()
        } catch { self.error = "撤销失败，请联网后重试。" }
    }
    func addPlace(_ name: String) async throws {
        if locationID == nil { locationID = try await api.connect().activeLocationId }
        guard let locationID else { return }
        let data = try await api.mutate("/api/bins", body: ["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "locationId": locationID])
        let place = try JSONDecoder().decode(Place.self, from: data)
        places.append(place); selectedPlaceID = place.id; await refresh()
    }
    func rename(_ place: Place, to name: String) async throws {
        try await api.mutate("/api/bins/\(place.id)", method: "PUT", body: ["name": name]); await refresh()
    }
    func deletePlace(_ place: Place) async {
        do {
            guard !queue.drafts.contains(where: { $0.place.id == place.id && $0.pending }) else { throw APIError.message("这个地点还有待处理照片，请先完成或取消。") }
            try await api.mutate("/api/bins/\(place.id)", method: "DELETE")
            undo.append(.init(name: place.name, itemID: nil, placeID: place.id)); await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func deletePhoto(_ photo: HistoryPhoto) async throws {
        try await api.mutate("/api/captures/\(photo.capture_id)/photos/\(photo.photo_id)/history", method: "DELETE")
        removedPhotoIDs.insert(photo.id); history.removeAll { $0.id == photo.id }
        queue.hideDeletedHistory(photo)
        await refresh()
    }
    func deleteScan(_ photo: HistoryPhoto) async throws {
        try await api.cancel(photo.capture_id, placeID: photo.bin_id)
        for entry in history where entry.capture_id == photo.capture_id { removedPhotoIDs.insert(entry.id) }
        history.removeAll { $0.capture_id == photo.capture_id }
        queue.hideDeletedHistory(photo)
        await refresh()
    }
}
