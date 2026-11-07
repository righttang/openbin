import Foundation
import UIKit

extension Notification.Name { static let photoUploadFinished = Notification.Name("remindme.photoUploadFinished") }
struct PhotoTransferReceipt: Codable, Sendable {
    let captureID: String
    let status: Int
    let body: Data
    var cancellation = false
}
@MainActor protocol PhotoUploadScheduling: AnyObject {
    func schedule(_ request: URLRequest, file: URL, captureID: String) async throws
    func cancel(_ captureID: String) async
    func receipts(in folder: URL) -> [PhotoTransferReceipt]
}
private struct UploadIdentity: Codable, Sendable { let server: String; let captureID: String; let operation: String }
private final class UploadResponses: @unchecked Sendable {
    private let lock = NSLock()
    private var buffers: [Int: Data] = [:]
    func append(_ data: Data, task: Int) {
        lock.lock(); defer { lock.unlock() }
        if (buffers[task]?.count ?? 0) + data.count <= 256 * 1024 { buffers[task, default: Data()].append(data) }
    }
    func take(_ task: Int) -> Data {
        lock.lock(); defer { lock.unlock() }
        return buffers.removeValue(forKey: task) ?? Data()
    }
}

/// iOS owns these file transfers, including when the app is suspended or relaunched.
@MainActor final class BackgroundPhotoUploader: NSObject, PhotoUploadScheduling, URLSessionDataDelegate {
    static let shared = BackgroundPhotoUploader()
    static let identifier = "com.righttang.remindme.photo-transfers"
    private nonisolated let responses = UploadResponses()
    private var eventCompletion: (() -> Void)?
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        config.isDiscretionary = false; config.sessionSendsLaunchEvents = true
        config.waitsForConnectivity = true; config.httpShouldSetCookies = false
        config.httpMaximumConnectionsPerHost = 2
        config.timeoutIntervalForRequest = 120; config.timeoutIntervalForResource = 24 * 60 * 60
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        return URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }()
    override init() { super.init(); _ = session }
    func handleEvents(completion: @escaping () -> Void) { eventCompletion = completion; _ = session }
    func schedule(_ request: URLRequest, file: URL, captureID: String) async throws {
        let operation = request.url?.lastPathComponent == "cancel" ? "cancel" : "upload"
        let tasks = await session.allTasks
        if tasks.contains(where: { identity($0)?.captureID == captureID && identity($0)?.operation == operation && $0.state != .completed && $0.state != .canceling }) { return }
        guard let url = request.url, let host = url.host,
              let server = URL(string: "\(url.scheme ?? "http")://\(host)\(url.port.map { ":\($0)" } ?? "")") else { throw APIError.message("服务器地址无效。") }
        let metadata = UploadIdentity(server: server.absoluteString, captureID: captureID, operation: operation)
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = String(data: try JSONEncoder().encode(metadata), encoding: .utf8)
        task.resume()
    }
    func cancel(_ captureID: String) async {
        for task in await session.allTasks where identity(task)?.captureID == captureID && identity(task)?.operation == "upload" { task.cancel() }
    }
    private nonisolated func identity(_ task: URLSessionTask) -> UploadIdentity? {
        task.taskDescription.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(UploadIdentity.self, from: $0) }
    }
    func receipts(in folder: URL) -> [PhotoTransferReceipt] {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "receipt" }.compactMap { file in
            guard let data = try? Data(contentsOf: file), let value = try? JSONDecoder().decode(PhotoTransferReceipt.self, from: data) else { return nil }
            try? FileManager.default.removeItem(at: file)
            return value
        }
    }
    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        responses.append(data, task: dataTask.taskIdentifier)
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = responses.take(task.taskIdentifier)
        guard let identity = identity(task) else { return }
        let receipt = PhotoTransferReceipt(captureID: identity.captureID, status: error == nil ? (task.response as? HTTPURLResponse)?.statusCode ?? 0 : 0, body: body, cancellation: identity.operation == "cancel")
        let folder = AppStore.folder(identity.server).appendingPathComponent("uploads")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try JSONEncoder().encode(receipt).write(to: folder.appendingPathComponent(identity.captureID + "-" + String(task.taskIdentifier) + ".receipt"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { /* The original and stable IDs remain on disk for idempotent recovery. */ }
        Task { @MainActor in NotificationCenter.default.post(name: .photoUploadFinished, object: nil) }
    }
    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in let completion = eventCompletion; eventCompletion = nil; completion?() }
    }
}

final class RemindMeAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == BackgroundPhotoUploader.identifier else { completionHandler(); return }
        BackgroundPhotoUploader.shared.handleEvents(completion: completionHandler)
    }
}
