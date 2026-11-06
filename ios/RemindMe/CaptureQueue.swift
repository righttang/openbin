import Foundation
import CryptoKit
import UIKit

enum PhotoProcessor {
    static func jpeg(_ data: Data, longestSide: CGFloat = 1600) throws -> Data {
        guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else { throw APIError.message("这张照片无法读取，请重新拍摄。") }
        let scale = min(1, longestSide / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let result = resized.jpegData(compressionQuality: 0.82), result.count <= 5 * 1024 * 1024 else { throw APIError.message("照片太大，请重新拍摄。") }
        return result
    }
}

/// Disk is the source of truth until the server acknowledges receipt or cancellation.
@MainActor final class CaptureQueue: ObservableObject {
    @Published private(set) var drafts: [PhotoDraft] = []
    @Published var storageError: String?
    var onChange: (() -> Void)?
    let folder: URL
    private let api: any CaptureTransport
    private var workers: [String: Task<Void, Never>] = [:]
    private var cancellations: [String: Task<Void, Never>] = [:]
    private var retryAfter: [String: Date] = [:]
    private var replacements: Set<String> = []
    private var monitor: Task<Void, Never>?
    private var enabled = false

    init(api: any CaptureTransport, folder: URL) {
        self.api = api; self.folder = folder
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            drafts = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" }.map { try JSONDecoder().decode(PhotoDraft.self, from: Data(contentsOf: $0)) }
                .sorted { $0.capturedAt > $1.capturedAt }
        } catch { storageError = "待上传照片暂时无法读取：\(error.localizedDescription)" }
    }
    var pendingCount: Int { drafts.filter { $0.pending || ($0.cancelRequested && $0.state != "cancelled") }.count }
    var unsubmittedCount: Int { drafts.filter { !$0.accepted && $0.state != "cancelled" }.count }
    func photoURL(_ id: String) -> URL { folder.appendingPathComponent(id + ".jpg") }
    func thumbnailURL(_ id: String) -> URL { folder.appendingPathComponent(id + ".thumb.jpg") }

    private func save(_ draft: PhotoDraft) throws {
        try JSONEncoder().encode(draft).write(to: folder.appendingPathComponent(draft.id + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        if let index = drafts.firstIndex(where: { $0.id == draft.id }) { drafts[index] = draft }
        else { drafts.insert(draft, at: 0) }
    }
    func enqueue(jpeg: Data, place: Place, capturedAt: String? = nil) throws {
        if let storageError { throw APIError.message(storageError) }
        guard drafts.filter({ !$0.accepted && $0.state != "cancelled" }).count < 30 else { throw APIError.message("已有 30 张待上传照片，请联网后继续。") }
        let used = drafts.filter { !$0.accepted && $0.state != "cancelled" }.reduce(0) { $0 + $1.photo.size }
        guard used + jpeg.count <= 100 * 1024 * 1024 else { throw APIError.message("待上传照片已达 100 MB，请先完成上传。") }
        let id = UUID().uuidString.lowercased()
        let draft = PhotoDraft(id: id, photo: .init(id: UUID().uuidString.lowercased(), sha256: SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined(), size: jpeg.count, order: 0), place: place, capturedAt: capturedAt ?? captureTimestamp())
        try jpeg.write(to: photoURL(id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        do {
            try PhotoProcessor.jpeg(jpeg, longestSide: 240).write(to: thumbnailURL(id), options: .atomic)
            try save(draft)
        } catch {
            try? FileManager.default.removeItem(at: photoURL(id)); try? FileManager.default.removeItem(at: thumbnailURL(id))
            throw error
        }
        pump()
    }
    func start() {
        enabled = true; pump()
        guard monitor == nil else { return }
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.poll(); self.pump()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
    func stop() { enabled = false; monitor?.cancel(); monitor = nil }
    func retry(_ id: String) {
        guard var draft = drafts.first(where: { $0.id == id }) else { return }
        retryAfter[id] = nil
        if draft.state == "expired" {
            Task { await replaceExpired(draft) }; return
        }
        if !draft.accepted && !draft.cancelRequested { draft.state = "waiting"; draft.error = nil; do { try save(draft) } catch { storageError = error.localizedDescription } }
        pump()
    }
    func cancel(_ id: String) {
        guard var draft = drafts.first(where: { $0.id == id }), draft.state != "cancelled" else { return }
        draft.cancelRequested = true; draft.error = nil
        do { try save(draft) } catch { storageError = "取消尚未保存，请重试。"; return }
        workers[id]?.cancel(); retryAfter[id] = nil
        launchCancellation(draft)
    }
    func hideDeletedHistory(_ photo: HistoryPhoto) {
        if drafts.contains(where: { $0.id == photo.capture_id && $0.photo.id == photo.photo_id }) { try? markCancelled(photo.capture_id) }
    }
    /// Confirmed history owns completed results; retain local files only for unsettled work.
    func reconcileHistory(_ photos: [HistoryPhoto]) {
        let keys = Set(photos.map(\.id))
        let obsolete = drafts.filter { draft in
            draft.state == "cancelled" || (draft.accepted && !draft.cancelRequested && ["applied", "superseded", "failed"].contains(draft.state) && !keys.contains("\(draft.id)/\(draft.photo.id)"))
        }
        for draft in obsolete {
            do {
                try FileManager.default.removeItem(at: folder.appendingPathComponent(draft.id + ".json"))
                drafts.removeAll { $0.id == draft.id }
                try? FileManager.default.removeItem(at: thumbnailURL(draft.id))
            } catch { /* A completed cache can be cleaned on the next successful refresh. */ }
        }
    }
    private func launchCancellation(_ draft: PhotoDraft) {
        guard cancellations[draft.id] == nil else { return }
        cancellations[draft.id] = Task { [weak self] in
            guard let self else { return }
            defer { self.cancellations[draft.id] = nil }
            do {
                try await api.cancel(draft.id, placeID: draft.place.id)
                guard var current = self.drafts.first(where: { $0.id == draft.id }) else { return }
                current.state = "cancelled"; current.error = nil
                try save(current)
                try? FileManager.default.removeItem(at: photoURL(draft.id))
                try? FileManager.default.removeItem(at: thumbnailURL(draft.id))
                onChange?()
            } catch { recordError(draft.id, message: "取消已保存，联网后自动重试。") }
        }
    }
    private func pump() {
        guard enabled, storageError == nil else { return }
        for draft in drafts.sorted(by: { $0.capturedAt < $1.capturedAt }) where (retryAfter[draft.id] ?? .distantPast) <= Date() {
            if draft.cancelRequested && draft.state != "cancelled" { launchCancellation(draft); continue }
            guard workers.count < 2, workers[draft.id] == nil, !draft.accepted, !draft.cancelRequested, ["waiting", "uploading", "failed"].contains(draft.state) else { continue }
            workers[draft.id] = Task { [weak self] in
                guard let self else { return }
                await transfer(draft)
                workers[draft.id] = nil; pump()
            }
        }
    }
    private func checkActive(_ id: String) throws {
        try Task.checkCancellation()
        guard drafts.contains(where: { $0.id == id && !$0.cancelRequested }) else { throw CancellationError() }
    }
    private func transfer(_ draft: PhotoDraft) async {
        do {
            try checkActive(draft.id)
            var current = draft; current.state = "uploading"; current.error = nil; try save(current)
            let created = try await api.create(draft)
            try checkActive(draft.id)
            if created.state == "cancelled" { try markCancelled(draft.id); return }
            if created.state == "expired" { current.state = "expired"; try save(current); return }
            var accepted = created
            if !created.accepted {
                try await api.upload(draft, file: photoURL(draft.id))
                try checkActive(draft.id)
                accepted = try await api.complete(draft)
                try checkActive(draft.id)
            }
            if accepted.state == "cancelled" { try markCancelled(draft.id); return }
            guard accepted.accepted else { throw APIError.message("服务器尚未收齐照片，请重试。") }
            current.state = accepted.state; current.accepted = true; current.error = nil
            try save(current)
            try? FileManager.default.removeItem(at: photoURL(draft.id))
            onChange?()
        } catch is CancellationError { /* Cancellation intent is already on disk. */ }
        catch {
            if (error as? APIError)?.code == "CAPTURE_CANCELLED" { try? markCancelled(draft.id) }
            else if (error as? APIError)?.code == "CAPTURE_EXPIRED" {
                guard var current = drafts.first(where: { $0.id == draft.id }), !current.cancelRequested else { return }
                current.state = "expired"; current.error = "上传已过期，原照片仍保留。请点重试重新上传。"
                do { try save(current) } catch { storageError = error.localizedDescription }
            } else { recordError(draft.id, message: "照片已保存在手机，联网后会重试。") }
        }
    }
    private func markCancelled(_ id: String) throws {
        guard var current = drafts.first(where: { $0.id == id }) else { return }
        current.state = "cancelled"; current.cancelRequested = true; current.error = nil; try save(current)
        try? FileManager.default.removeItem(at: photoURL(id)); try? FileManager.default.removeItem(at: thumbnailURL(id))
        onChange?()
    }
    private func recordError(_ id: String, message: String) {
        guard var draft = drafts.first(where: { $0.id == id }), draft.state != "cancelled" else { return }
        draft.error = message
        if !draft.accepted && !draft.cancelRequested && draft.state != "expired" { draft.state = "failed" }
        do { try save(draft) } catch { storageError = "照片状态无法保存，请释放手机空间后重试。" }
        retryAfter[id] = Date().addingTimeInterval(15)
    }
    private func poll() async {
        for draft in drafts where draft.accepted && !draft.cancelRequested && !["applied", "superseded", "failed", "cancelled"].contains(draft.state) {
            guard !Task.isCancelled else { return }
            do {
                let result = try await api.capture(draft.id)
                guard var current = drafts.first(where: { $0.id == draft.id }), !current.cancelRequested else { continue }
                if result.state == "cancelled" { try markCancelled(draft.id); continue }
                if result.state != current.state {
                    current.state = result.state; current.error = nil; try save(current); onChange?()
                }
            } catch { /* Keep accepted state: a polling failure is not a failed recognition. */ }
        }
    }
    private func replaceExpired(_ old: PhotoDraft) async {
        guard workers[old.id] == nil, !replacements.contains(old.id) else { return }
        replacements.insert(old.id)
        defer { replacements.remove(old.id) }
        do {
            let data = try Data(contentsOf: photoURL(old.id))
            try await api.cancel(old.id, placeID: old.place.id)
            guard drafts.contains(where: { $0.id == old.id && !$0.cancelRequested }) else { return }
            // Save the replacement first. Disk failures retain the original for another retry.
            try enqueue(jpeg: data, place: old.place, capturedAt: old.capturedAt)
            try markCancelled(old.id)
        } catch { recordError(old.id, message: "重新上传失败，原照片仍保留在手机。") }
    }
}
