import Foundation

/// Talks to the same API as the web customer page.
struct PagerAPI {
    /// From Info.plist `PagerBaseURL` (https://$PAGER_DOMAIN at generate time).
    static var baseURL: URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "PagerBaseURL") as? String,
           let url = URL(string: raw), url.host != nil {
            return url
        }
        return URL(string: "https://example.com")!
    }

    var base: URL = PagerAPI.baseURL

    func shop(_ id: String) async throws -> Shop {
        try await send("api/shops/\(id)", method: "GET", body: nil)
    }

    func order(_ id: String) async throws -> Order {
        try await send("api/orders/\(id)", method: "GET", body: nil)
    }

    func claim(shopId: String, n: String?, k: String?) async throws -> Order {
        var body: [String: String] = ["shopId": shopId]
        if let n { body["n"] = n }
        if let k { body["k"] = k }
        return try await send("api/claim", method: "POST", body: try JSONEncoder().encode(body))
    }

    func subscribeLiveActivity(orderId: String, token: String, app: String) async throws {
        let body = SubscribeBody(orderId: orderId, payload: .init(token: token, app: app))
        let _: OK = try await send("api/subscribe", method: "POST", body: try JSONEncoder().encode(body))
    }

    private struct OK: Decodable {
        let ok: Bool
    }

    private struct SubscribeBody: Encodable {
        struct Payload: Encodable {
            let token: String
            let app: String
        }

        let orderId: String
        var kind: String = "live_activity"
        let payload: Payload
    }

    private func send<T: Decodable>(_ path: String, method: String, body: Data?) async throws -> T {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw PagerError(message: "مفيش اتصال بالإنترنت. جرّب تاني")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode(APIErrorBody.self, from: data))?.error
            throw PagerError(message: message ?? "حصلت مشكلة. جرّب تاني")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
