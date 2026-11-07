import Foundation

struct LocalProfile: Decodable { let id: String; let activeLocationId: String }
struct ServerStatus: Decodable { let localMode: Bool }
struct Place: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var notes: String? = nil
}
struct PlaceList: Decodable { let results: [Place]; let count: Int }
struct Inventory: Decodable { let items: [InventoryItem] }
struct InventoryItem: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let aliases: [String]
    let quantity: Int?
    let bin_id: String
    var bin_name: String
    let last_seen_at: String?
    let crop_url: String?
    let photo_preview_url: String?
}
struct HistoryList: Decodable { let photos: [HistoryPhoto] }
struct HistoryPhoto: Codable, Identifiable, Hashable {
    var id: String { "\(capture_id)/\(photo_id)" }
    let capture_id: String
    let photo_id: String
    let bin_id: String
    var bin_name: String
    let captured_at: String
    let state: String
    let preview_url: String?
    var items: [Observation]
}
struct Observation: Codable, Identifiable, Hashable {
    var id: String { observation_id }
    let observation_id: String
    let item_id: String?
    let name: String
    let description: String
    let aliases: [String]
    let quantity: Int?
    let crop_url: String?
}
struct Capture: Codable {
    let id: String
    let state: String
    var accepted: Bool { ["queued", "processing", "applied", "superseded", "failed"].contains(state) }
    var terminal: Bool { ["applied", "superseded", "failed", "expired", "cancelled"].contains(state) }
}
struct CaptureSettings: Decodable { let modelConfigured: Bool; let maxPhotoBytes: Int }
struct PhotoManifest: Codable {
    let id: String
    let sha256: String
    let size: Int
    let order: Int
}
struct PhotoDraft: Codable, Identifiable {
    var id: String
    var photo: PhotoManifest
    let place: Place
    let capturedAt: String
    var state = "waiting"
    var accepted = false
    var cancelRequested = false
    var error: String?
    var pending: Bool { !["applied", "superseded", "cancelled", "expired"].contains(state) && !(accepted && state == "failed") }
    var label: String {
        if cancelRequested { return state == "cancelled" ? "已取消" : "等待取消" }
        return ["waiting": "等待上传", "uploading": "后台上传中", "queued": "已上传 · 服务器排队", "processing": "已上传 · 识别中", "applied": "识别完成", "superseded": "识别完成", "failed": accepted ? "识别失败，请重拍" : "等待重试", "expired": "上传已过期", "cancelled": "已取消"][state] ?? state
    }
}

enum ServerAddress {
    static let production = "http://192.168.50.84:1453"
    static func parse(_ value: String) throws -> URL {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text.contains("://") ? text : "http://" + text),
              ["http", "https"].contains(url.scheme), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw APIError.message("请输入服务器地址，例如 192.168.50.84:1453") }
        return URL(string: url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")))!
    }
}

func captureTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

func photoDate(_ raw: String?) -> String {
    guard let raw else { return "尚无拍摄记录" }
    let normalized = raw.contains("T") ? raw : raw.replacingOccurrences(of: " ", with: "T") + "Z"
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = parser.date(from: normalized) ?? ISO8601DateFormatter().date(from: normalized)
    return date?.formatted(.dateTime.month().day().hour().minute().locale(Locale(identifier: "zh_CN"))) ?? raw
}

struct ItemRefinement: Decodable {
    let name: String
    let description: String
    let aliases: [String]
    let item_id: String?
    let observation_id: String?
}
struct PlaceDeduplication: Codable {
    struct Redirect: Codable { let from_id: String; let into_id: String }
    let merged_items: Int
    let merged_groups: Int
    let redirects: [Redirect]
}
struct PlaceJob: Codable, Identifiable {
    let id: String
    let bin_id: String
    let state: String
    let result: PlaceDeduplication?
    let error_category: String?
    var pending: Bool { ["queued", "processing", "retry"].contains(state) }
    var label: String {
        switch state {
        case "queued": return "去重已排队 · 可以关闭 App"
        case "retry": return "去重等待重试 · 服务器会继续处理"
        case "processing": return "服务器正在识别并合并…"
        case "completed": return result?.merged_items == 0 ? "去重完成 · 没有发现可确认的重复物品" : "去重完成 · 已合并 \(result?.merged_items ?? 0) 条重复记录，照片历史已保留"
        case "cancelled": return "去重已取消"
        default: return "去重未完成，原记录已保留，可重新尝试"
        }
    }
}
struct PlaceJobList: Decodable { let jobs: [PlaceJob] }
extension InventoryItem {
    func corrected(name: String, description: String, aliases: [String]) -> InventoryItem {
        InventoryItem(id: id, name: name, description: description, aliases: aliases, quantity: quantity,
                      bin_id: bin_id, bin_name: bin_name, last_seen_at: last_seen_at,
                      crop_url: crop_url, photo_preview_url: photo_preview_url)
    }
}

/// Keep the same row identities in place while an edit changes the matching text.
enum StableItemOrder {
    static func merge(previous: [InventoryItem], incoming: [InventoryItem], edited: [String: InventoryItem]) -> [InventoryItem] {
        let latest = Dictionary(uniqueKeysWithValues: incoming.map { ($0.id, $0) }).merging(edited) { _, correction in correction }
        let retained = previous.compactMap { latest[$0.id] }
        let retainedIDs = Set(retained.map(\.id))
        return retained + incoming.filter { !retainedIDs.contains($0.id) }.map { edited[$0.id] ?? $0 }
    }
}

enum StablePlaceOrder {
    static func merge(previous: [Place], incoming: [Place]) -> [Place] {
        let latest = Dictionary(uniqueKeysWithValues: incoming.map { ($0.id, $0) })
        let retained = previous.compactMap { latest[$0.id] }
        let retainedIDs = Set(retained.map(\.id))
        return retained + incoming.filter { !retainedIDs.contains($0.id) }
    }
}
