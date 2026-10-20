import SwiftUI

/// Same tokens as the web (server/public/css/base.css), 60 / 30 / 10.
enum Theme {
    static let background = Color(hex: 0x1E1F21)
    static let surface = Color(hex: 0x2A2B2E)
    static let surface2 = Color(hex: 0x34353A)
    static let text = Color(hex: 0xECEAE6)
    static let muted = Color(hex: 0xA09D97)
    static let accent = Color(hex: 0xCDBB97)
    static let ready = Color(hex: 0x3F8F60)
    static let readyDeep = Color(hex: 0x2F7A4F)

    static func tint(for status: String) -> Color {
        switch status {
        case "ready", "picked": return ready
        case "preparing": return accent
        default: return muted
        }
    }
}

extension Color {
    /// "#rrggbb" → Color; nil for anything else.
    init?(hexString: String) {
        let digits = hexString.hasPrefix("#") ? String(hexString.dropFirst()) : hexString
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(hex: value)
    }

    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
