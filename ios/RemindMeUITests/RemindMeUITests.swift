import XCTest
import CryptoKit
import UIKit

final class RemindMeUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    private var csrf = ""
    private var fixtureID: String?
    private var captureIDs: [String] = []
    private func fixtureAPI(_ path: String, method: String = "GET", body: [String: Any]? = nil, rawBody: Data? = nil, headers: [String: String] = [:]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:1453" + path)!)
        request.httpMethod = method
        request.setValue("openbin-csrf=\(csrf)", forHTTPHeaderField: "Cookie")
        request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let rawBody { request.httpBody = rawBody }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        guard (200..<300).contains(http.statusCode) else { throw NSError(domain: "Local fixture API", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "\(method) \(path): \(String(data: data, encoding: .utf8) ?? "Invalid response")"]) }
        if let header = http.value(forHTTPHeaderField: "Set-Cookie"), let token = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: request.url!).first(where: { $0.name == "openbin-csrf" })?.value { csrf = token }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
    override func tearDown() async throws {
        if let id = fixtureID {
            for captureID in captureIDs { _ = try await fixtureAPI("/api/captures/\(captureID)/cancel", method: "POST", body: ["bin_id": id]) }
        }
        if let id = fixtureID { _ = try await fixtureAPI("/api/bins/\(id)", method: "DELETE") }
    }
    @MainActor func testPlaceDeduplicationRequiresConfirmationAndCanCancel() async throws {
        guard ProcessInfo.processInfo.environment["REMINDME_RUN_UI_TESTS"] == "1" else { throw XCTSkip("Use the local test server") }
        let profile = try await fixtureAPI("/api/auth/me")
        guard profile["id"] as? String == ProcessInfo.processInfo.environment["REMINDME_EXPECT_TEST_PROFILE"] else { XCTFail("Wrong test profile"); return }
        let fixture = try await fixtureAPI("/api/bins", method: "POST", body: ["name": "去重按钮验收", "locationId": profile["activeLocationId"]!, "items": ["保留的物品"]])
        fixtureID = try XCTUnwrap(fixture["id"] as? String)
        let app = XCUIApplication()
        app.launchEnvironment["REMINDME_TEST_URL"] = "http://127.0.0.1:1453"
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let place = app.buttons["scan.place"]
        XCTAssertTrue(place.waitForExistence(timeout: 20)); place.tap()
        app.buttons["去重按钮验收"].tap()
        let button = app.buttons["scan.place.deduplicate.\(fixtureID!)"]
        XCTAssertTrue(button.waitForExistence(timeout: 5)); XCTAssertGreaterThanOrEqual(button.frame.width, 56)
        button.tap()
        XCTAssertTrue(app.buttons["识别并合并"].waitForExistence(timeout: 5))
        let proof = XCTAttachment(screenshot: app.screenshot()); proof.name = "地点去重确认弹窗"; proof.lifetime = .keepAlways; add(proof)
        app.buttons["取消"].tap()
        XCTAssertTrue(button.exists)
        let remaining = try await fixtureAPI("/api/captures/inventory?bin_id=\(fixtureID!)")
        XCTAssertEqual((remaining["items"] as? [[String: Any]])?.count, 1)
        button.tap(); app.buttons["识别并合并"].tap()
        XCTAssertTrue(app.staticTexts["去重完成 · 没有发现可确认的重复物品"].waitForExistence(timeout: 15))
    }
    @MainActor func testManyResultsAndRepeatedVoiceEditsStayResponsive() async throws {
        guard let raw = ProcessInfo.processInfo.environment["REMINDME_MEMORY_FIXTURE"], let data = raw.data(using: .utf8) else { throw XCTSkip("Use the isolated memory stress runner") }
        let fixture = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let capture = try XCTUnwrap(fixture["newestCaptureID"] as? String)
        let observation = try XCTUnwrap(fixture["targetObservationID"] as? String)
        let app = XCUIApplication()
        app.launchEnvironment["REMINDME_TEST_URL"] = "http://127.0.0.1:1456"
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let scan = app.buttons["scan.open.\(capture)"]
        XCTAssertTrue(scan.waitForExistence(timeout: 20)); scan.tap()
        let row = app.buttons["result.open.\(observation)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        for index in 0..<8 {
            app.buttons["result.voice.\(observation)"].tap()
            let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            if index == 0 && system.alerts.firstMatch.waitForExistence(timeout: 2) {
                let deny = system.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["不允许", "Don't Allow", "Don’t Allow"])).firstMatch
                if deny.exists { deny.tap() }
            }
            let input = app.descendants(matching: .any).matching(identifier: "voice.transcript").firstMatch
            XCTAssertTrue(input.waitForExistence(timeout: 10))
            if input.frame.minY > app.frame.height * 0.6 { app.swipeUp() }
            input.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            input.typeText("连续改名\(index)")
            app.buttons["voice.submit"].tap()
            XCTAssertTrue(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "连续改名\(index)"), object: row)], timeout: 15) == .completed)
            XCTAssertTrue(app.navigationBars["识别结果"].exists)
            app.swipeDown()
        }
        app.buttons["完成"].tap()
        app.buttons["照片历史"].tap()
        XCTAssertTrue(app.navigationBars["照片历史"].waitForExistence(timeout: 10))
        let options = XCTMeasureOptions(); options.iterationCount = 1
        measure(metrics: [XCTMemoryMetric(application: app)], options: options) {
            for _ in 0..<14 { app.swipeUp(); XCTAssertTrue(app.navigationBars["照片历史"].exists) }
            for _ in 0..<14 { app.swipeDown(); XCTAssertTrue(app.navigationBars["照片历史"].exists) }
        }
        XCTAssertEqual(app.state, .runningForeground)
        let proof = XCTAttachment(screenshot: app.screenshot()); proof.name = "80张照片160件物品连续改名与滚动压力验证"; proof.lifetime = .keepAlways; add(proof)
    }

    @MainActor func testVoiceSearchAndItemSupplement() async throws {
        guard ProcessInfo.processInfo.environment["REMINDME_RUN_UI_TESTS"] == "1" else { throw XCTSkip("Use ios/scripts/test-local.py with the local test server") }
        let profile = try await fixtureAPI("/api/auth/me")
        guard profile["id"] as? String == ProcessInfo.processInfo.environment["REMINDME_EXPECT_TEST_PROFILE"] else { XCTFail("Wrong test profile"); return }
        let originalName = "语音验收摄像头" + UUID().uuidString.prefix(6)
        let fixture = try await fixtureAPI("/api/bins", method: "POST", body: ["name": "语音功能验收", "locationId": profile["activeLocationId"]!, "items": [originalName + "前", originalName, originalName + "后"]])
        fixtureID = try XCTUnwrap(fixture["id"] as? String)
        let app = XCUIApplication()
        app.launchEnvironment["REMINDME_TEST_URL"] = "http://127.0.0.1:1453"
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["查找"].waitForExistence(timeout: 20)); app.tabBars.buttons["查找"].tap()
        XCTAssertTrue(app.buttons["find.voice"].waitForExistence(timeout: 10)); app.buttons["find.voice"].tap()
        // Simulator microphones cannot reproduce speech reliably. Exercise the same
        // transcript field, including the permission-denied fallback, with real APIs.
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if system.alerts.firstMatch.waitForExistence(timeout: 4) {
            let deny = system.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["不允许", "Don't Allow", "Don’t Allow"])).firstMatch
            if deny.exists { deny.tap() }
        }
        let transcript = app.descendants(matching: .any).matching(identifier: "voice.transcript").firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 10)); transcript.tap(); transcript.typeText(originalName + "。")
        XCTAssertTrue(app.navigationBars["查找"].exists)
        let search = XCTAttachment(screenshot: app.screenshot()); search.name = "查找页原地语音搜索"; search.lifetime = .keepAlways; add(search)
        app.buttons["voice.submit"].tap()
        let existing = try await fixtureAPI("/api/captures/inventory?bin_id=\(fixtureID!)")
        let id = try XCTUnwrap((existing["items"] as? [[String: Any]])?.first(where: { $0["name"] as? String == originalName })?["id"] as? String)
        let result = app.buttons["find.open.\(id)"]
        XCTAssertTrue(result.waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["×1"].exists)
        XCTAssertTrue(app.buttons["find.delete.\(id)"].exists)
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "find.open."))
        let originalOrder = rows.allElementsBoundByIndex.map(\.identifier)
        XCTAssertEqual(originalOrder.count, 3)
        XCTAssertGreaterThanOrEqual(app.buttons["find.voice.\(id)"].frame.width, 56)
        XCTAssertGreaterThanOrEqual(app.buttons["find.delete.\(id)"].frame.height, 56)
        app.buttons["find.voice.\(id)"].tap()
        XCTAssertTrue(app.navigationBars["查找"].exists)
        XCTAssertTrue(transcript.waitForExistence(timeout: 10)); transcript.tap()
        transcript.typeText("这是小米室外的摄像头，请把名称改为小米室外摄像头。")
        let inline = XCTAttachment(screenshot: app.screenshot()); inline.name = "物品行语音与删除并排"; inline.lifetime = .keepAlways; add(inline)
        app.buttons["voice.submit"].tap()
        XCTAssertTrue(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "小米室外摄像头"), object: result)], timeout: 90) == .completed)
        XCTAssertTrue(app.navigationBars["查找"].exists)
        XCTAssertFalse(transcript.exists)
        XCTAssertEqual(rows.allElementsBoundByIndex.map(\.identifier), originalOrder)
        let updated = try await fixtureAPI("/api/captures/inventory?bin_id=\(fixtureID!)")
        let items = try XCTUnwrap(updated["items"] as? [[String: Any]])
        XCTAssertEqual(items.count, 3)
        let corrected = try XCTUnwrap(items.first { $0["id"] as? String == id })
        XCTAssertEqual(corrected["name"] as? String, "小米室外摄像头")
        XCTAssertEqual(corrected["bin_id"] as? String, fixtureID)
        let after = XCTAttachment(screenshot: app.screenshot()); after.name = "语音更新后留在查找页"; after.lifetime = .keepAlways; add(after)
        result.tap()
        XCTAssertTrue(app.navigationBars["小米室外摄像头"].waitForExistence(timeout: 10))
    }

    @MainActor func testSwitchBetweenItemAndPlaceVoiceInputs() async throws {
        guard ProcessInfo.processInfo.environment["REMINDME_RUN_UI_TESTS"] == "1" else { throw XCTSkip("Use the local test server") }
        let profile = try await fixtureAPI("/api/auth/me")
        guard profile["id"] as? String == ProcessInfo.processInfo.environment["REMINDME_EXPECT_TEST_PROFILE"] else { XCTFail("Wrong test profile"); return }
        let name = "语音切换验收" + UUID().uuidString.prefix(6)
        let fixture = try await fixtureAPI("/api/bins", method: "POST", body: ["name": "位置说明验收", "locationId": profile["activeLocationId"]!, "items": [name]])
        fixtureID = try XCTUnwrap(fixture["id"] as? String)
        let app = XCUIApplication()
        app.launchEnvironment["REMINDME_TEST_URL"] = "http://127.0.0.1:1453"
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["查找"].waitForExistence(timeout: 20)); app.tabBars.buttons["查找"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10))
        app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText(name)
        let result = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 15)); result.tap()
        XCTAssertTrue(app.buttons["item.voice"].waitForExistence(timeout: 10)); app.buttons["item.voice"].tap()
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if system.alerts.firstMatch.waitForExistence(timeout: 3) {
            let deny = system.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["不允许", "Don't Allow", "Don’t Allow"])).firstMatch
            if deny.exists { deny.tap() }
        }
        let transcript = app.descendants(matching: .any).matching(identifier: "voice.transcript").firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        app.buttons["item.place.voice.\(fixtureID!)"].tap()
        XCTAssertTrue(app.staticTexts["位置说明"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "voice.cancel").count, 1)
        app.buttons["voice.cancel"].tap(); XCTAssertFalse(transcript.exists)
        XCTAssertTrue(app.navigationBars[name].exists)
    }

    @MainActor func testDeleteWholeScanDirectlyFromScanPage() async throws {
        guard ProcessInfo.processInfo.environment["REMINDME_RUN_UI_TESTS"] == "1" else { throw XCTSkip("Use ios/scripts/test-local.py with the local test server") }
        let profile = try await fixtureAPI("/api/auth/me")
        guard profile["id"] as? String == ProcessInfo.processInfo.environment["REMINDME_EXPECT_TEST_PROFILE"] else { XCTFail("Wrong test profile"); return }
        let fixture = try await fixtureAPI("/api/bins", method: "POST", body: ["name": "扫描删除验收", "locationId": profile["activeLocationId"]!])
        let placeID = try XCTUnwrap(fixture["id"] as? String); fixtureID = placeID
        for photoCount in [2, 1] {
            let captureID = UUID().uuidString.lowercased(); captureIDs.append(captureID)
            _ = try await fixtureAPI("/api/captures", method: "POST", body: ["id": captureID, "bin_id": placeID, "source": "web-instant"])
            for index in 0..<photoCount {
                let png = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).pngData { context in
                    (index == 0 ? UIColor.blue : UIColor.red).setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
                }
                let hash = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
                let photoID = UUID().uuidString.lowercased()
                _ = try await fixtureAPI("/api/captures/\(captureID)/photos/\(photoID)", method: "PUT", rawBody: png, headers: ["Content-Type": "image/png", "X-Photo-SHA256": hash, "X-Photo-Size": String(png.count)])
            }
        }
        let app = XCUIApplication()
        app.launchEnvironment["REMINDME_TEST_URL"] = "http://127.0.0.1:1453"
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let target = app.buttons["scan.delete.\(captureIDs[0])"]
        let other = app.buttons["scan.delete.\(captureIDs[1])"]
        XCTAssertTrue(target.waitForExistence(timeout: 20)); XCTAssertTrue(other.exists)
        let before = XCTAttachment(screenshot: app.screenshot()); before.name = "扫描页直接删除整次扫描"; before.lifetime = .keepAlways; add(before)
        target.tap()
        XCTAssertTrue(app.buttons["确认删除"].waitForExistence(timeout: 5))
        let confirmation = XCTAttachment(screenshot: app.screenshot()); confirmation.name = "删除前确认"; confirmation.lifetime = .keepAlways; add(confirmation)
        app.buttons["保留"].tap()
        XCTAssertTrue(target.exists)
        let retained = try await fixtureAPI("/api/captures/history?bin_id=\(placeID)")
        XCTAssertEqual((retained["photos"] as? [[String: Any]])?.filter { $0["capture_id"] as? String == captureIDs[0] }.count, 2)
        target.tap()
        app.buttons["确认删除"].tap()
        XCTAssertTrue(expectationForDisappearance(target))
        XCTAssertTrue(other.exists)
        let history = try await fixtureAPI("/api/captures/history?bin_id=\(placeID)")
        let entries = try XCTUnwrap(history["photos"] as? [[String: Any]])
        XCTAssertFalse(entries.contains { $0["capture_id"] as? String == captureIDs[0] })
        XCTAssertEqual(entries.filter { $0["capture_id"] as? String == captureIDs[1] }.count, 1)
        let deleted = try await fixtureAPI("/api/captures/\(captureIDs[0])")
        XCTAssertEqual(deleted["state"] as? String, "cancelled")
        let after = XCTAttachment(screenshot: app.screenshot()); after.name = "删除整组后保留其他扫描"; after.lifetime = .keepAlways; add(after)
        app.terminate(); app.launch()
        XCTAssertTrue(other.waitForExistence(timeout: 20)); XCTAssertFalse(target.exists)
    }
    @MainActor private func expectationForDisappearance(_ element: XCUIElement) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)], timeout: 10) == .completed
    }
    @MainActor func testDeleteWrongRecognitionFromResultList() async throws {
        guard let raw = ProcessInfo.processInfo.environment["REMINDME_RESULT_FIXTURE"], let data = raw.data(using: .utf8) else { throw XCTSkip("Use ios/scripts/test-local.py for isolated result fixtures") }
        let fixture = try JSONDecoder().decode([String: String].self, from: data)
        let captureID = try XCTUnwrap(fixture["captureID"])
        let wrongID = try XCTUnwrap(fixture["wrongObservationID"])
        let correctID = try XCTUnwrap(fixture["correctObservationID"])
        let profile = try await fixtureAPI("/api/auth/me")
        guard profile["id"] as? String == ProcessInfo.processInfo.environment["REMINDME_EXPECT_TEST_PROFILE"] else { XCTFail("Wrong test profile"); return }
        let app = XCUIApplication()
        app.launchEnvironment["REMINDME_TEST_URL"] = "http://127.0.0.1:1453"
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let scan = app.buttons["scan.open.\(captureID)"]
        XCTAssertTrue(scan.waitForExistence(timeout: 20)); scan.tap()
        let wrong = app.buttons["result.delete.\(wrongID)"]
        XCTAssertTrue(wrong.waitForExistence(timeout: 10))
        let placeID = try XCTUnwrap(fixture["placeID"])
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "result.open."))
        let beforeOrder = rows.allElementsBoundByIndex.map(\.identifier)
        app.buttons["result.place.voice.\(placeID)"].tap()
        let speechSystem = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if speechSystem.alerts.firstMatch.waitForExistence(timeout: 4) {
            let deny = speechSystem.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["不允许", "Don't Allow", "Don’t Allow"])).firstMatch
            if deny.exists { deny.tap() }
        }
        let placeTranscript = app.descendants(matching: .any).matching(identifier: "voice.transcript").firstMatch
        XCTAssertTrue(placeTranscript.waitForExistence(timeout: 10)); placeTranscript.tap()
        placeTranscript.typeText("位置名称保持不变，说明改成车库右侧架子第二层，靠门一侧。")
        app.buttons["voice.submit"].tap()
        let notes = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "第二层")).firstMatch
        XCTAssertTrue(notes.waitForExistence(timeout: 90))
        XCTAssertTrue(app.navigationBars["识别结果"].exists)
        XCTAssertEqual(rows.allElementsBoundByIndex.map(\.identifier), beforeOrder)
        let updatedPlace = try await fixtureAPI("/api/bins/\(placeID)")
        XCTAssertEqual(updatedPlace["name"] as? String, "识别结果删除验收")
        XCTAssertTrue((updatedPlace["notes"] as? String ?? "").contains("靠门"))
        let location = XCTAttachment(screenshot: app.screenshot()); location.name = "照片地点原地语音更新位置说明"; location.lifetime = .keepAlways; add(location)
        XCTAssertFalse(app.buttons["result.open.\(wrongID)"].label.contains("识别结果删除验收"))
        XCTAssertFalse(app.buttons["result.open.\(wrongID)"].label.contains("月"))
        XCTAssertGreaterThanOrEqual(app.buttons["result.voice.\(wrongID)"].frame.width, 56)
        XCTAssertGreaterThanOrEqual(wrong.frame.height, 56)
        XCTAssertFalse(app.staticTexts["×1"].exists)
        app.buttons["result.voice.\(wrongID)"].tap()
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if system.alerts.firstMatch.waitForExistence(timeout: 4) {
            let deny = system.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["不允许", "Don't Allow", "Don’t Allow"])).firstMatch
            if deny.exists { deny.tap() }
        }
        XCTAssertTrue(app.navigationBars["识别结果"].exists)
        let transcript = app.descendants(matching: .any).matching(identifier: "voice.transcript").firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        let voice = XCTAttachment(screenshot: app.screenshot()); voice.name = "识别结果原地语音补充"; voice.lifetime = .keepAlways; add(voice)
        app.buttons["voice.cancel"].tap()
        XCTAssertFalse(transcript.exists)
        XCTAssertTrue(app.buttons["result.open.\(wrongID)"].exists)
        wrong.tap(); XCTAssertTrue(app.alerts.buttons["确认删除"].waitForExistence(timeout: 5))
        app.alerts.buttons["保留"].tap(); XCTAssertTrue(wrong.exists)
        let before = XCTAttachment(screenshot: app.screenshot()); before.name = "识别结果单项删除"; before.lifetime = .keepAlways; add(before)
        wrong.tap(); app.alerts.buttons["确认删除"].tap()
        XCTAssertTrue(expectationForDisappearance(wrong))
        XCTAssertTrue(app.buttons["result.open.\(correctID)"].exists)
        let history = try await fixtureAPI("/api/captures/history?bin_id=\(fixture["placeID"]!)")
        let photo = try XCTUnwrap((history["photos"] as? [[String: Any]])?.first)
        XCTAssertEqual(photo["capture_id"] as? String, captureID)
        XCTAssertEqual((photo["items"] as? [[String: Any]])?.map { $0["observation_id"] as? String }, [correctID])
        let inventory = try await fixtureAPI("/api/captures/inventory?bin_id=\(fixture["placeID"]!)")
        XCTAssertFalse((inventory["items"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == fixture["wrongItemID"] })
        app.terminate(); app.launch()
        XCTAssertTrue(scan.waitForExistence(timeout: 20)); scan.tap()
        XCTAssertTrue(app.buttons["result.open.\(correctID)"].waitForExistence(timeout: 10)); XCTAssertFalse(wrong.exists)
        let after = XCTAttachment(screenshot: app.screenshot()); after.name = "错误结果删除后保留正确结果"; after.lifetime = .keepAlways; add(after)
        app.buttons["result.open.\(correctID)"].tap()
        let detailDelete = app.buttons["删除识别结果"]
        XCTAssertTrue(detailDelete.waitForExistence(timeout: 5)); detailDelete.tap()
        app.alerts.buttons["保留"].tap(); XCTAssertTrue(detailDelete.exists)
        detailDelete.tap(); app.alerts.buttons["确认删除"].tap()
        XCTAssertTrue(expectationForDisappearance(detailDelete))
        XCTAssertTrue(app.navigationBars["识别结果"].exists)
        XCTAssertFalse(app.buttons["result.open.\(correctID)"].exists)
        let empty = try await fixtureAPI("/api/captures/history?bin_id=\(fixture["placeID"]!)")
        XCTAssertEqual(((empty["photos"] as? [[String: Any]])?.first?["items"] as? [[String: Any]])?.count, 0)
    }
    @MainActor func testScanFindHistoryAndNoLogin() async throws {
        guard ProcessInfo.processInfo.environment["REMINDME_RUN_UI_TESTS"] == "1" else { throw XCTSkip("Use ios/scripts/test-local.py with the local test server") }
        let profile = try await fixtureAPI("/api/auth/me")
        guard profile["id"] as? String == ProcessInfo.processInfo.environment["REMINDME_EXPECT_TEST_PROFILE"] else { XCTFail("Wrong test profile; refusing fixture writes"); return }
        let itemName = "iOS验收物品-" + UUID().uuidString.prefix(6)
        let fixture = try await fixtureAPI("/api/bins", method: "POST", body: ["name": "iOS 界面验收", "locationId": profile["activeLocationId"]!, "items": [itemName]])
        fixtureID = try XCTUnwrap(fixture["id"] as? String)
        let app = XCUIApplication()
        app.launchEnvironment["REMINDME_TEST_URL"] = "http://127.0.0.1:1453"
        app.launchArguments += ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["scan.camera"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.textFields["邮箱"].exists)
        XCTAssertFalse(app.buttons["登录"].exists)
        XCTAssertTrue(app.tabBars.buttons["扫描"].exists)
        XCTAssertTrue(app.tabBars.buttons["查找"].exists)
        let scan = XCTAttachment(screenshot: app.screenshot()); scan.name = "扫描"; scan.lifetime = .keepAlways; add(scan)
        app.tabBars.buttons["查找"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10))
        app.searchFields.firstMatch.tap(); app.searchFields.firstMatch.typeText(itemName)
        let result = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", itemName)).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 15))
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "find.delete.")).firstMatch.tap()
        XCTAssertTrue(app.buttons["确认删除"].waitForExistence(timeout: 5))
        app.buttons["保留"].tap()
        XCTAssertTrue(result.exists)
        result.tap()
        XCTAssertTrue(app.buttons["删除物品"].waitForExistence(timeout: 10))
        let detail = XCTAttachment(screenshot: app.screenshot()); detail.name = "物品详情"; detail.lifetime = .keepAlways; add(detail)
        app.buttons["删除物品"].tap()
        XCTAssertTrue(app.buttons["确认删除"].waitForExistence(timeout: 5))
        app.buttons["保留"].tap()
        XCTAssertFalse(app.buttons["撤销"].exists)
        app.buttons["删除物品"].tap()
        app.buttons["确认删除"].tap()
        XCTAssertTrue(app.buttons["撤销"].waitForExistence(timeout: 10))
        app.buttons["撤销"].tap()
        XCTAssertTrue(result.waitForExistence(timeout: 15))
        let find = XCTAttachment(screenshot: app.screenshot()); find.name = "查找与撤销"; find.lifetime = .keepAlways; add(find)
        app.tabBars.buttons["扫描"].tap()
        app.buttons["照片历史"].tap()
        XCTAssertTrue(app.navigationBars["照片历史"].waitForExistence(timeout: 10))
        let history = XCTAttachment(screenshot: app.screenshot()); history.name = "照片历史"; history.lifetime = .keepAlways; add(history)
    }
}
