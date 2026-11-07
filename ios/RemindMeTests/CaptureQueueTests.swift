import XCTest
import UIKit
import ImageIO
import UniformTypeIdentifiers
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

actor ExpiryAtUploadAPI: CaptureTransport {
    func create(_ draft: PhotoDraft) async throws -> Capture { Capture(id: draft.id, state: "uploading") }
    func upload(_ draft: PhotoDraft, file: URL) async throws { throw APIError.response(410, "Capture expired. Start a new capture.", code: "CAPTURE_EXPIRED") }
    func complete(_ draft: PhotoDraft) async throws -> Capture { Capture(id: draft.id, state: "queued") }
    func capture(_ id: String) async throws -> Capture { Capture(id: id, state: "expired") }
    func cancel(_ id: String, placeID: String) async throws { }
}

actor RecordingCaptureAPI: CaptureTransport {
    var createdDates: [String] = []
    func create(_ draft: PhotoDraft) async throws -> Capture { createdDates.append(draft.capturedAt); return Capture(id: draft.id, state: "uploading") }
    func upload(_ draft: PhotoDraft, file: URL) async throws { }
    func complete(_ draft: PhotoDraft) async throws -> Capture { Capture(id: draft.id, state: "queued") }
    func capture(_ id: String) async throws -> Capture { Capture(id: id, state: "queued") }
    func cancel(_ id: String, placeID: String) async throws { }
}

final class CaptureErrorURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let code = request.url!.lastPathComponent
        let response = HTTPURLResponse(url: request.url!, statusCode: 410, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: ["error": code, "message": "Capture unavailable"]))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

extension CaptureQueueTests {
    func image(_ color: UIColor) -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 40, height: 20)).jpegData(withCompressionQuality: 0.8) { context in color.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 20)) }
    }
    func setCapturedAt(_ draft: PhotoDraft, _ value: String) throws {
        let path = folder.appendingPathComponent(draft.id + ".json")
        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]
        json["capturedAt"] = value
        try JSONSerialization.data(withJSONObject: json).write(to: path, options: .atomic)
    }
    func testUploadExpiryKeepsUnacknowledgedOriginal() async throws {
        let queue = CaptureQueue(api: ExpiryAtUploadAPI(), folder: folder); defer { queue.stop() }
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉"))
        let id = queue.drafts[0].id
        queue.start(); try await waitUntil { ["cancelled", "expired", "failed"].contains(queue.drafts[0].state) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.photoURL(id).path), "An expired upload was never accepted or cancelled by the user; its only photo must survive")
        XCTAssertNotEqual(queue.drafts[0].state, "cancelled")
    }
    func testAPIKeepsDistinctExpiryAndCancellationCodes() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CaptureErrorURLProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let api = APIClient(baseURL: URL(string: "http://localhost")!, session: session)
        for code in ["CAPTURE_EXPIRED", "CAPTURE_CANCELLED"] {
            do { _ = try await api.capture(code); XCTFail("Expected a server error") }
            catch { XCTAssertEqual((error as? APIError)?.status, 410); XCTAssertEqual((error as? APIError)?.code, code) }
        }
    }
    func testQuotaFailureDuringReplacementDoesNotLoseOriginal() async throws {
        let api = FakeCaptureAPI(); await api.configure(expired: true)
        let queue = CaptureQueue(api: api, folder: folder); defer { queue.stop() }
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉"))
        let original = queue.drafts[0]
        queue.start(); try await waitUntil { queue.drafts[0].state == "expired" }; queue.stop()
        for _ in 0..<29 { try queue.enqueue(jpeg: image(.blue), place: .init(id: "drawer", name: "抽屉")) }
        await api.configure()
        queue.retry(original.id)
        try await waitUntil { queue.drafts.first(where: { $0.id == original.id })?.error != nil }
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.photoURL(original.id).path))
        XCTAssertEqual(queue.drafts.first(where: { $0.id == original.id })?.state, "expired")
        queue.start()
        try await waitUntil { queue.drafts.filter { $0.id != original.id }.allSatisfy(\.accepted) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: queue.photoURL(original.id).path))
        queue.retry(original.id)
        try await waitUntil { queue.drafts.allSatisfy { $0.accepted || $0.state == "cancelled" } }
        let retainedOrAccepted = FileManager.default.fileExists(atPath: queue.photoURL(original.id).path) || queue.drafts.contains { $0.accepted && $0.photo.sha256 == original.photo.sha256 }
        XCTAssertTrue(retainedOrAccepted, "Retrying after the full-queue replacement failure deleted the only unaccepted original")
    }
    func testRestoredQueueRegistersOlderPhotosBeforeNewerPhotos() async throws {
        let api = RecordingCaptureAPI()
        let queue = CaptureQueue(api: api, folder: folder)
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉"))
        try setCapturedAt(queue.drafts[0], "2026-11-05T10:00:00Z")
        try queue.enqueue(jpeg: image(.blue), place: .init(id: "drawer", name: "抽屉"))
        try setCapturedAt(queue.drafts[0], "2026-11-05T11:00:00Z")
        let restored = CaptureQueue(api: api, folder: folder); defer { restored.stop() }
        restored.start(); try await waitUntil { restored.drafts.allSatisfy(\.accepted) }
        let dates = await api.createdDates
        XCTAssertEqual(dates, dates.sorted(), "Server sequence follows registration order, so replaying newest first makes older photos win reconciliation")
    }
    func testExpiredReplacementPreservesOriginalCaptureTime() async throws {
        let api = FakeCaptureAPI(); await api.configure(expired: true)
        let queue = CaptureQueue(api: api, folder: folder)
        try queue.enqueue(jpeg: image(), place: .init(id: "drawer", name: "抽屉"))
        let oldID = queue.drafts[0].id
        try setCapturedAt(queue.drafts[0], "2026-11-05T10:00:00Z")
        let restored = CaptureQueue(api: api, folder: folder); defer { restored.stop() }
        restored.start(); try await waitUntil { restored.drafts[0].state == "expired" }
        await api.configure(); restored.retry(oldID)
        try await waitUntil { restored.drafts.contains { $0.id != oldID && $0.accepted } }
        XCTAssertEqual(restored.drafts.first(where: { $0.id != oldID })?.capturedAt, "2026-11-05T10:00:00Z")
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
    func testCameraEXIFOrientationIsRenderedIntoPixelsWithoutStretching() throws {
        let original = try XCTUnwrap(UIImage(data: image())?.cgImage)
        for (orientation, size) in [(6, CGSize(width: original.height, height: original.width)), (8, CGSize(width: original.height, height: original.width)), (3, CGSize(width: original.width, height: original.height))] {
            let encoded = NSMutableData()
            let destination = try XCTUnwrap(CGImageDestinationCreateWithData(encoded, UTType.jpeg.identifier as CFString, 1, nil))
            CGImageDestinationAddImage(destination, original, [kCGImagePropertyOrientation: orientation] as CFDictionary)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
            let result = try XCTUnwrap(UIImage(data: PhotoProcessor.jpeg(encoded as Data)))
            XCTAssertEqual(result.size, size)
            XCTAssertEqual(result.imageOrientation, .up)
        }
    }
}

final class ItemOrderTests: XCTestCase {
    private func item(_ id: String, _ name: String) -> InventoryItem {
        InventoryItem(id: id, name: name, description: "", aliases: [], quantity: 1, bin_id: "desk", bin_name: "书桌",
                      last_seen_at: nil, crop_url: nil, photo_preview_url: nil)
    }
    func testRenamedMiddleItemKeepsItsPositionWhenItNoLongerMatchesSearch() {
        let original = [item("a", "camera A"), item("b", "camera B"), item("c", "camera C")]
        let corrected = item("b", "小米室外摄像头")
        let result = StableItemOrder.merge(previous: original, incoming: [original[0], original[2]], edited: ["b": corrected])
        XCTAssertEqual(result.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(result[1].name, corrected.name)
    }
    func testRefreshKeepsRowsInPlaceAndAddsNewItemsAfterExistingRows() {
        let original = [item("a", "Z"), item("b", "B"), item("c", "C")]
        let incoming = [item("b", "A"), item("d", "D"), original[2], original[0]]
        let result = StableItemOrder.merge(previous: original, incoming: incoming, edited: [:])
        XCTAssertEqual(result.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(result[1].name, "A")
        XCTAssertEqual(StableItemOrder.merge(previous: [], incoming: incoming, edited: [:]).map(\.id), incoming.map(\.id))
    }
}


final class PlaceDescriptionTests: XCTestCase {
    func testOldCachedPlacesDecodeWithoutNotes() throws {
        let place = try JSONDecoder().decode(Place.self, from: Data(#"{"id":"desk","name":"书桌"}"#.utf8))
        XCTAssertNil(place.notes)
    }
    func testEditingPlaceDescriptionKeepsItsPositionAndSelectionIdentity() {
        let old = [Place(id: "a", name: "书架"), Place(id: "b", name: "架子"), Place(id: "c", name: "抽屉")]
        let updated = Place(id: "b", name: "车库架子", notes: "右侧第二层，靠门一侧。")
        let result = StablePlaceOrder.merge(previous: old, incoming: [old[2], updated, old[0]])
        XCTAssertEqual(result.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(result[1].name, updated.name)
        XCTAssertEqual(result[1].notes, updated.notes)
    }
}
