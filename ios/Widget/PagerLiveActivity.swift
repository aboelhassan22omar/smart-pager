import ActivityKit
import SwiftUI
import WidgetKit

@main
struct PagerWidgetBundle: WidgetBundle {
    var body: some Widget {
        PagerLiveActivity()
    }
}

/// Lock screen card (like the web card) + Dynamic Island (compact: cup + number).
struct PagerLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PagerAttributes.self) { context in
            TrackingCardView(shopName: context.state.shopName, number: context.state.number,
                             status: context.state.status, message: context.state.message, compact: true) {
                CupBadge(status: context.state.status)
            }
            .environment(\.layoutDirection, .rightToLeft)
            .activityBackgroundTint(Theme.surface)
            .activitySystemActionForegroundColor(Theme.text)
        } dynamicIsland: { context in
            let state = context.state
            let tint = Theme.tint(for: state.status)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Image(systemName: "cup.and.saucer.fill").foregroundStyle(tint)
                        Text(state.shopName).font(.caption).lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(verbatim: "\(state.number)")
                        .font(.title2.weight(.semibold))
                        .monospacedDigit()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Image(systemName: OrderStatus.symbol(state.status)).foregroundStyle(tint)
                            Text(state.message).font(.subheadline.weight(.medium)).lineLimit(1)
                        }
                        ProgressBar(progress: OrderStatus.progress(state.status))
                    }
                    .environment(\.layoutDirection, .rightToLeft)
                }
            } compactLeading: {
                Image(systemName: "cup.and.saucer.fill").foregroundStyle(tint)
            } compactTrailing: {
                Text(verbatim: "\(state.number)")
                    .monospacedDigit()
                    .fontWeight(.semibold)
                    .foregroundStyle(tint)
            } minimal: {
                Text(verbatim: "\(state.number)")
                    .monospacedDigit()
                    .fontWeight(.semibold)
                    .foregroundStyle(tint)
            }
            .keylineTint(tint)
        }
    }
}
