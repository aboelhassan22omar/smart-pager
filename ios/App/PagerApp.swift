import SwiftUI

@main
struct PagerApp: App {
    @StateObject private var model = OrderModel(appKind: "app")

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onOpenURL { model.handle(url: $0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.handle(url: url) }
                }
        }
    }
}
