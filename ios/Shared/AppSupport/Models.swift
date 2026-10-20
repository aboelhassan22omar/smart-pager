import Foundation

struct Shop: Codable, Equatable {
    let id: String
    let name: String
    let logoUrl: String?
    let preparingMessage: String
    let readyMessage: String
}

struct Order: Codable, Equatable {
    let id: String
    let shopId: String
    let shopName: String
    let number: Int
    let status: String
    let message: String
    let notifyCount: Int

    var isClosed: Bool { OrderStatus.isClosed(status) }
    var isReady: Bool { status == "ready" }
}

struct APIErrorBody: Decodable {
    let error: String
}

struct PagerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
