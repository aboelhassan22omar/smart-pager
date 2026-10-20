import Foundation
import SwiftUI

struct Shop: Codable, Equatable {
    /// Shop color picked from its logo, already adjusted for contrast by the server.
    struct Accent: Codable, Equatable {
        let color: String
        let ink: String
    }

    let id: String
    let name: String
    let logoUrl: String?
    let preparingMessage: String
    let readyMessage: String
    let accent: Accent?
    let googleReviewUrl: String?

    var accentColor: Color { accent.flatMap { Color(hexString: $0.color) } ?? Theme.accent }
    var accentInk: Color { accent.flatMap { Color(hexString: $0.ink) } ?? Theme.background }
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
