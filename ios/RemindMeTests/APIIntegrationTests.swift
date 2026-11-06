import XCTest
import CryptoKit
import UIKit
@testable import RemindMe

final class APIIntegrationTests: XCTestCase {
    /// Explicitly opt-in and read-only: verify the native HTTP stack against the LAN service.
    func testProductionReadOnlyNativeConnection() async throws {
        guard ProcessInfo.processInfo.environment["REMINDME_VERIFY_PRODUCTION"] == "1" else { throw XCTSkip("Production check is opt-in and read-only") }
        let api = APIClient(baseURL: URL(string: ServerAddress.production)!)
        let profile = try await api.connect()
        XCTAssertEqual(profile.id, "5f46266f-66ea-4a9a-9b8d-d50bb8aa4558")
        let settings: CaptureSettings = try await api.get("/api/captures/config")
        XCTAssertTrue(settings.modelConfigured)
        _ = try await api.places(locationID: profile.activeLocationId)
        _ = try await api.inventory()
        let history = try await api.history()
        if let preview = history.first?.preview_url {
            let (_, response) = try await URLSession.shared.data(from: api.url(preview))
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
    }
    /// Deliberately fixed to Mac localhost. This test must never write to Tomubuntu.
    func testLocalPostgresWithoutLoginPlaceLifecycleAndPhotoCancellation() async throws {
        guard ProcessInfo.processInfo.environment["REMINDME_RUN_API_TESTS"] == "1" else { throw XCTSkip("Set REMINDME_RUN_API_TESTS=1 with the local test server running") }
        let api = APIClient(baseURL: URL(string: "http://127.0.0.1:1453")!)
        let profile = try await api.connect()
        guard profile.id == ProcessInfo.processInfo.environment["REMINDME_EXPECT_TEST_PROFILE"] else { XCTFail("Expected the isolated local test profile"); return }
        let raw = try await api.mutate("/api/bins", body: ["name": "iOS 集成验收", "locationId": profile.activeLocationId, "items": ["原生客户端删除验收"]])
        let place = try JSONDecoder().decode(Place.self, from: raw)
        do {
            try await api.mutate("/api/bins/\(place.id)", method: "PUT", body: ["name": "iOS 测试抽屉"])
            let items = try await api.inventory(placeID: place.id); let item = try XCTUnwrap(items.first)
            try await api.mutate("/api/items/bulk-delete", body: ["ids": [item.id]])
            let deleted = try await api.inventory(placeID: place.id); XCTAssertTrue(deleted.isEmpty)
            try await api.mutate("/api/items/bulk-restore", body: ["ids": [item.id]])
            let restored = try await api.inventory(placeID: place.id); XCTAssertEqual(restored.first?.id, item.id)
            let jpeg = await MainActor.run { UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).jpegData(withCompressionQuality: 0.8) { ctx in UIColor.blue.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 16, height: 16)) } }
            let draft = PhotoDraft(id: UUID().uuidString.lowercased(), photo: .init(id: UUID().uuidString.lowercased(), sha256: SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined(), size: jpeg.count, order: 0), place: place, capturedAt: ISO8601DateFormatter().string(from: Date()))
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(draft.id + ".jpg")
            try jpeg.write(to: file); defer { try? FileManager.default.removeItem(at: file) }
            _ = try await api.create(draft); try await api.upload(draft, file: file)
            let history = try await api.history(); XCTAssertTrue(history.contains { $0.capture_id == draft.id && $0.preview_url != nil })
            let accepted = try await api.complete(draft); XCTAssertTrue(accepted.accepted)
            try await api.cancel(draft.id, placeID: place.id)
            let cancelled = try await api.capture(draft.id); XCTAssertEqual(cancelled.state, "cancelled")
            try await api.mutate("/api/bins/\(place.id)", method: "DELETE")
            try await api.mutate("/api/bins/\(place.id)/restore")
            let places = try await api.places(locationID: profile.activeLocationId); XCTAssertTrue(places.contains { $0.id == place.id })
        } catch {
            _ = try? await api.mutate("/api/bins/\(place.id)", method: "DELETE")
            throw error
        }
        try await api.mutate("/api/bins/\(place.id)", method: "DELETE")
    }
}
