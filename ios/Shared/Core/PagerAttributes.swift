import ActivityKit
import Foundation

/// Shared between the apps and the widget extensions. Field names must match the
/// server's APNs `content-state`: {status, number, message, shopName}.
struct PagerAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String
        var number: Int
        var message: String
        var shopName: String
    }

    var shopId: String
    var orderId: String
}

enum OrderStatus {
    static let closed: Set<String> = ["picked", "expired", "cancelled"]

    static func isClosed(_ status: String) -> Bool { closed.contains(status) }

    static func progress(_ status: String) -> Double {
        switch status {
        case "preparing": return 0.48
        case "ready", "picked": return 1
        default: return 0
        }
    }

    static func symbol(_ status: String) -> String {
        switch status {
        case "preparing": return "clock"
        case "ready", "picked": return "checkmark.circle"
        default: return "xmark.circle"
        }
    }
}
