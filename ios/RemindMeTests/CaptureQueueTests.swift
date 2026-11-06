import XCTest
import UIKit
@testable import RemindMe

actor FakeCaptureAPI: CaptureTransport {
    var records: [String: Capture] = [:]
    var uploads = 0
    var creates = 0
    var activeUploads = 0
    var peakUploads = 0
    var delay: Duration = .zero
    var failCancel = false
    var loseCompletion = false
    var expired = false
    var cancelDelay: Duration = .zero
    func configure(delay: Duration = .zero, failCancel: Bool = false, loseCompletion: Bool = false, expired: Bool = false, cancelDelay: Duration = .zero) { self.delay = delay; self.failCancel = failCancel; self.loseCompletion = loseCompletion; self.expired = expired; self.cancelDelay = cancelDelay }
    func create(_ draft: PhotoDraft) async throws -> Capture {
        creates += 1
        if let current = records[draft.id] { return current }
        let value = Capture(id: draft.id, state: expired ? "expired" : "uploading"); records[draft.id] = value; return value
    }
    func upload(_ draft: PhotoDraft, file: URL) async throws {
        _ = try Data(contentsOf: file); uploads += 1; activeUploads += 1; peakUploads = max(peakUploads, activeUploads)
        defer { activeUploads -= 1 }
        try await Task.sleep(for: delay)
    }
    func complete(_ draft: PhotoDraft) async throws -> Capture {
        let result = Capture(id: draft.id, state: "queued"); records[draft.id] = result
        if loseCompletion { loseCompletion = false; throw URLError(.networkConnectionLost) }
        return result
    }
    func capture(_ id: String) async throws -> Capture { records[id] ?? Capture(id: id, state: "queued") }
    func cancel(_ id: String, placeID: String) async throws {
        try await Task.sleep(for: cancelDelay)
        if failCancel { throw URLError(.notConnectedToInternet) }
        records[id] = Capture(id: id, state: "cancelled")
    }
}

@MainActor final class CaptureQueueTests: XCTestCase {
    var folder: URL!
    override func setUp() { folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    override func tearDown() { try? FileManager.default.removeItem(at: folder) }
    func image() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 40, height: 20)).jpegData(withCompressionQuality: 0.8) { context in UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 20)) }
    }
    func waitUntil(_ condition: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<100 { if condition() { return }; try await Task.sleep(for: .milliseconds(25)) }
        XCTFail("State did not settle")
    }
    func testPhotoIsDurableBeforeNetworkAndSurvivesRelaunch() throws {
        let api = FakeCaptureAPI(), queue = CaptureQueue(api: FakeCaptureAPI(), folder: folder)
        try queue.enqueue(jpeg: image(), place: Place(id: "drawer", name: "书桌抽屉"))
        let first = try XCTUnwrap(queue.drafts.first)
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.photoURL(first.id).path))
        let restored = CaptureQueue(api: api, folder: folder)
        XCTAssertEqual(restored.drafts.first?.id, first.id)
        XCTAssertEqual(restored.drafts.first?.place.name, "书桌抽屉")
        XCTAssertEqual(restored.drafts.first?.state, "waiting")
    }
    func testLostCompletionResponseRetriesSameIDWithoutUploadingAgain() async throws {
        let api = FakeCaptureAPI(); await api.configure(loseCompletion: true)
        let queue = CaptureQueue(api: api, folder: folder); defer { queue.stop() }
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉")); let id = queue.drafts[0].id
        queue.start(); try await waitUntil { queue.drafts[0].state == "failed" }
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.photoURL(id).path))
        queue.retry(id); try await waitUntil { queue.drafts[0].accepted }
        XCTAssertEqual(queue.drafts[0].id, id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: queue.photoURL(id).path))
        let uploads = await api.uploads; XCTAssertEqual(uploads, 1)
    }
    func testCancelWhileUploadingDoesNotReviveResults() async throws {
        let api = FakeCaptureAPI(); await api.configure(delay: .seconds(1))
        let queue = CaptureQueue(api: api, folder: folder); defer { queue.stop() }
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉")); let id = queue.drafts[0].id
        queue.start(); try await waitUntil { queue.drafts[0].state == "uploading" }
        queue.cancel(id); try await waitUntil { queue.drafts[0].state == "cancelled" }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(queue.drafts[0].state, "cancelled")
        XCTAssertFalse(FileManager.default.fileExists(atPath: queue.photoURL(id).path))
    }
    func testOfflineCancelSurvivesRelaunchAndNeverCreatesPhoto() async throws {
        let api = FakeCaptureAPI(); await api.configure(failCancel: true)
        let queue = CaptureQueue(api: api, folder: folder)
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉")); let id = queue.drafts[0].id
        queue.cancel(id); try await waitUntil { queue.drafts[0].error != nil }
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.photoURL(id).path))
        await api.configure()
        let restored = CaptureQueue(api: api, folder: folder); defer { restored.stop() }
        restored.start(); try await waitUntil { restored.drafts[0].state == "cancelled" }
        let creates = await api.creates; XCTAssertEqual(creates, 0)
    }
    func testContinuousCaptureKeepsPlaceAtShutterAndLimitsUploads() async throws {
        let api = FakeCaptureAPI(); await api.configure(delay: .milliseconds(200))
        let queue = CaptureQueue(api: api, folder: folder); defer { queue.stop() }
        for n in 0..<4 { try queue.enqueue(jpeg: image(), place: .init(id: "place-\(n)", name: "地点\(n)")) }
        queue.start(); try await waitUntil { queue.drafts.allSatisfy(\.accepted) }
        XCTAssertEqual(Set(queue.drafts.map(\.place.id)).count, 4)
        let peak = await api.peakUploads; XCTAssertEqual(peak, 2)
        XCTAssertEqual(Set(queue.drafts.map(\.id)).count, 4)
    }
    func testExpiredPhotoCanBeReplacedWithoutDroppingOriginalBeforeSave() async throws {
        let api = FakeCaptureAPI(); await api.configure(expired: true)
        let queue = CaptureQueue(api: api, folder: folder); defer { queue.stop() }
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉")); let old = queue.drafts[0].id
        queue.start(); try await waitUntil { queue.drafts[0].state == "expired" }
        await api.configure(cancelDelay: .milliseconds(50)); queue.retry(old); queue.retry(old)
        try await waitUntil { queue.drafts.contains { $0.id != old && $0.accepted } }
        XCTAssertEqual(queue.drafts.first { $0.id == old }?.state, "cancelled")
        XCTAssertEqual(queue.drafts.filter { $0.id != old }.count, 1)
    }
    func testCancelWinsOverExpiredPhotoReplacement() async throws {
        let api = FakeCaptureAPI(); await api.configure(expired: true)
        let queue = CaptureQueue(api: api, folder: folder); defer { queue.stop() }
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉")); let old = queue.drafts[0].id
        queue.start(); try await waitUntil { queue.drafts[0].state == "expired" }
        await api.configure(cancelDelay: .milliseconds(100)); queue.retry(old)
        try await Task.sleep(for: .milliseconds(20)); queue.cancel(old)
        try await waitUntil { queue.drafts[0].state == "cancelled" }
        XCTAssertEqual(queue.drafts.count, 1)
    }
    func testInvalidServerAddressesAreRejectedAndLocalAddressNormalized() throws {
        XCTAssertEqual(try ServerAddress.parse(" 192.168.50.84:1453/ ").absoluteString, ServerAddress.production)
        for value in ["file:///tmp/a", "http://user:password@host", "http://host/path", "http://host?secret=1"] { XCTAssertThrowsError(try ServerAddress.parse(value)) }
    }
    func testHistoryRefreshNeverDropsUnacknowledgedPhotos() throws {
        let queue = CaptureQueue(api: FakeCaptureAPI(), folder: folder)
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉"))
        let id = queue.drafts[0].id
        queue.reconcileHistory([])
        XCTAssertEqual(queue.drafts.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.photoURL(id).path))
    }
    func testPhotoProcessingNormalizesOrientationAndBoundsSize() throws {
        let data = try PhotoProcessor.jpeg(image(), longestSide: 16)
        let output = try XCTUnwrap(UIImage(data: data)); XCTAssertLessThanOrEqual(max(output.size.width, output.size.height), 16)
        XCTAssertThrowsError(try PhotoProcessor.jpeg(Data("not an image".utf8)))
    }
}
