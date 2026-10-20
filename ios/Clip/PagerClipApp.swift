import SwiftUI

/// App Clip: invoked from the QR / Safari banner with https://$PAGER_DOMAIN/s/{shop}?n|k|o.
@main
struct PagerClipApp: App {
    @StateObject private var model = OrderModel(appKind: "clip")

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.handle(url: url) }
                }
                .onOpenURL { model.handle(url: $0) }
        }
    }
}
