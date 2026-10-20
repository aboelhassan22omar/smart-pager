import SwiftUI

/// The notification-style order card, used by the app, the App Clip and the lock screen.
/// `badge` is the shop logo in the app (shown large beside the name) and the cup icon
/// on the lock screen (shown small in the header).
struct TrackingCardView<Badge: View>: View {
    let shopName: String
    let number: Int
    let status: String
    let message: String
    var compact = false
    var accent: Color = Theme.accent
    let badge: Badge

    init(shopName: String, number: Int, status: String, message: String, compact: Bool = false,
         accent: Color = Theme.accent, @ViewBuilder badge: () -> Badge) {
        self.shopName = shopName
        self.number = number
        self.status = status
        self.message = message
        self.compact = compact
        self.accent = accent
        self.badge = badge()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 12) {
            HStack(spacing: 10) {
                if compact { badge }
                Text(verbatim: "ORDER TRACKER")
                    .font(.caption2.weight(.medium))
                    .tracking(1.2)
                    .foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
                if compact {
                    Text(shopName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                }
            }

            if !compact {
                HStack(spacing: 14) {
                    badge
                    Text(shopName)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(2)
                }
            }

            HStack(alignment: .lastTextBaseline) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("رقم الطلب")
                        .font(compact ? .caption : .subheadline)
                        .foregroundStyle(Theme.muted)
                    Text(verbatim: "\(number)")
                        .font(.system(size: compact ? 44 : 104, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.text)
                        .opacity(OrderStatus.isClosed(status) ? 0.4 : 1)
                        .contentTransition(.numericText())
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 8) {
                Image(systemName: OrderStatus.symbol(status))
                    .foregroundStyle(status == "preparing" ? Theme.muted : Theme.tint(for: status))
                Text(message)
                    .font((compact ? Font.subheadline : Font.body).weight(.medium))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
            }

            ProgressBar(progress: OrderStatus.progress(status), tint: accent)
        }
        .padding(compact ? 16 : 20)
        .background {
            if !compact {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Theme.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(Theme.text.opacity(0.08), lineWidth: 1)
                    )
            }
        }
    }
}

struct ProgressBar: View {
    let progress: Double
    var tint: Color = Theme.accent

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.surface2)
                Capsule()
                    .fill(tint)
                    .frame(width: max(6, geo.size.width * progress))
            }
        }
        .frame(height: 6)
        .animation(.easeOut(duration: 0.5), value: progress)
    }
}

/// Small square badge with the cup icon (lock screen / Dynamic Island).
struct CupBadge: View {
    let status: String

    var body: some View {
        Image(systemName: "cup.and.saucer.fill")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Theme.background)
            .frame(width: 24, height: 24)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Theme.tint(for: status)))
    }
}
