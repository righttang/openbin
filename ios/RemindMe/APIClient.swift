import Foundation

enum APIError: LocalizedError {
    case response(Int, String)
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .response(let code, let text):
            if code == 401 { return "这个服务器未开启内网免登录模式。" }
            if code == 410 { return "这次拍摄已取消或过期。" }
            return text.isEmpty ? "服务器暂时无法处理，请重试（\(code)）。" : text
        }
    }
    var status: Int? { if case .response(let code, _) = self { return code }; return nil }
}

protocol CaptureTransport: Sendable {
    func create(_ draft: PhotoDraft) async throws -> Capture
    func upload(_ draft: PhotoDraft, file: URL) async throws
    func complete(_ draft: PhotoDraft) async throws -> Capture
    func capture(_ id: String) async throws -> Capture
    func cancel(_ id: String, placeID: String) async throws
}

/// No account, bearer token or model key. The ordinary LAN session supplies CSRF protection.
actor APIClient: CaptureTransport {
    let baseURL: URL
    private let session: URLSession
    private var csrf: String?

    init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        self.session = session ?? URLSession(configuration: config)
    }

    func url(_ path: String) -> URL { URL(string: path, relativeTo: baseURL)!.absoluteURL }

    private func raw(_ path: String, method: String = "GET", body: Data? = nil,
                     headers: [String: String] = [:], protected: Bool = true) async throws -> Data {
        if method != "GET", csrf == nil, protected { let _: LocalProfile = try await profile() }
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        request.httpBody = body
        if let csrf {
            request.setValue("openbin-csrf=\(csrf)", forHTTPHeaderField: "Cookie")
            request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
        }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError.message("服务器响应无效。") }
        if let cookieHeader = response.value(forHTTPHeaderField: "Set-Cookie"),
           let token = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": cookieHeader], for: baseURL).first(where: { $0.name == "openbin-csrf" })?.value { csrf = token }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String ?? ""
            throw APIError.response(response.statusCode, message)
        }
        return data
    }
    func get<T: Decodable>(_ path: String) async throws -> T { try JSONDecoder().decode(T.self, from: await raw(path)) }
    @discardableResult
    func mutate(_ path: String, method: String = "POST", body: [String: Any] = [:]) async throws -> Data {
        try await raw(path, method: method, body: JSONSerialization.data(withJSONObject: body), headers: ["Content-Type": "application/json"])
    }
    func profile() async throws -> LocalProfile { try await get("/api/auth/me") }
    func connect() async throws -> LocalProfile {
        let status: ServerStatus = try await get("/api/auth/status")
        guard status.localMode else { throw APIError.message("请连接开启内网免登录模式的 RemindMe 服务器。") }
        return try await profile()
    }
    func places(locationID: String) async throws -> [Place] {
        var result: [Place] = []
        while true {
            let page: PlaceList = try await get("/api/bins?location_id=\(locationID)&limit=100&offset=\(result.count)")
            result += page.results
            if result.count >= page.count || page.results.isEmpty { break }
        }
        return result
    }
    func inventory(query: String = "", placeID: String = "") async throws -> [InventoryItem] {
        var parts = URLComponents()
        parts.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "bin_id", value: placeID.isEmpty ? nil : placeID)].filter { $0.value != nil }
        let result: Inventory = try await get("/api/captures/inventory?\(parts.percentEncodedQuery ?? "")")
        return result.items
    }
    func history() async throws -> [HistoryPhoto] { let value: HistoryList = try await get("/api/captures/history"); return value.photos }
    func create(_ draft: PhotoDraft) async throws -> Capture {
        // web-instant names the existing independent-photo protocol, shared with the web client.
        let data = try await mutate("/api/captures", body: ["id": draft.id, "bin_id": draft.place.id, "source": "web-instant", "device_id": "ios", "captured_at": draft.capturedAt])
        return try JSONDecoder().decode(Capture.self, from: data)
    }
    func upload(_ draft: PhotoDraft, file: URL) async throws {
        _ = try await raw("/api/captures/\(draft.id)/photos/\(draft.photo.id)", method: "PUT", body: Data(contentsOf: file), headers: ["Content-Type": "image/jpeg", "X-Photo-SHA256": draft.photo.sha256, "X-Photo-Size": String(draft.photo.size)])
    }
    func complete(_ draft: PhotoDraft) async throws -> Capture {
        let manifest = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.photo))
        return try JSONDecoder().decode(Capture.self, from: await mutate("/api/captures/\(draft.id)/complete", body: ["photos": [manifest]]))
    }
    func capture(_ id: String) async throws -> Capture { try await get("/api/captures/\(id)") }
    func cancel(_ id: String, placeID: String) async throws { try await mutate("/api/captures/\(id)/cancel", body: ["bin_id": placeID]) }
}
