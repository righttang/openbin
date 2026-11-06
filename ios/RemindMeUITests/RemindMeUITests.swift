import XCTest

final class RemindMeUITests: XCTestCase {
    private var csrf = ""
    private var fixtureID: String?
    private func fixtureAPI(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:1453" + path)!)
        request.httpMethod = method
        request.setValue("openbin-csrf=\(csrf)", forHTTPHeaderField: "Cookie")
        request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        guard (200..<300).contains(http.statusCode) else { throw NSError(domain: "Local fixture API", code: http.statusCode) }
        if let header = http.value(forHTTPHeaderField: "Set-Cookie"), let token = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: request.url!).first(where: { $0.name == "openbin-csrf" })?.value { csrf = token }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
    override func tearDown() async throws {
        if let id = fixtureID { _ = try await fixtureAPI("/api/bins/\(id)", method: "DELETE") }
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
        result.tap()
        XCTAssertTrue(app.buttons["删除物品"].waitForExistence(timeout: 10))
        let detail = XCTAttachment(screenshot: app.screenshot()); detail.name = "物品详情"; detail.lifetime = .keepAlways; add(detail)
        app.buttons["删除物品"].tap()
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
