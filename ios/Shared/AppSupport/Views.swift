import AudioToolbox
import SwiftUI
import UIKit

/// Root of both the full app and the App Clip.
struct RootView: View {
    @ObservedObject var model: OrderModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack(alignment: .bottom) {
            Theme.background.ignoresSafeArea()

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.bottom, 44)
                .animation(.easeOut(duration: 0.4), value: model.phase)

            PoweredByView()
        }
        .environment(\.layoutDirection, .rightToLeft)
        .preferredColorScheme(.dark)
        .onAppear { model.boot() }
        .onChange(of: scenePhase) { _, phase in
            model.setForeground(phase == .active)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .splash:
            SplashView(shop: model.shop)
                .transition(.opacity)
        case .idle:
            MessageView(symbol: "qrcode.viewfinder", text: "امسح الكود اللي عند الكاشير عشان تاخد رقم طلبك")
        case .failed(let message):
            MessageView(symbol: "exclamationmark.circle", text: message)
        case .tracking:
            if let order = model.order {
                if order.isReady {
                    ReadyView(order: order)
                        .transition(.opacity)
                } else {
                    TrackingCardView(shopName: order.shopName, number: order.number,
                                     status: order.status, message: order.message) {
                        ShopLogo(path: model.shop?.logoUrl, name: order.shopName, size: 26)
                    }
                    .padding(.horizontal, 16)
                    .frame(maxWidth: 420)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
    }
}

struct SplashView: View {
    let shop: Shop?

    var body: some View {
        VStack(spacing: 18) {
            ShopLogo(path: shop?.logoUrl, name: shop?.name ?? "", size: 112)
            Text(shop?.name ?? " ")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
        }
        .padding(24)
    }
}

struct ShopLogo: View {
    let path: String?
    let name: String
    var size: CGFloat = 56

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
        ZStack {
            shape.fill(Theme.surface)
            if let url = resolvedURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initial
                    }
                }
            } else {
                initial
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
    }

    private var initial: some View {
        Text(String(name.prefix(1)))
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(Theme.accent)
    }

    private var resolvedURL: URL? {
        guard let path else { return nil }
        return URL(string: path, relativeTo: PagerAPI.baseURL)?.absoluteURL
    }
}

/// Full green screen with a repeating alert until the user touches it.
struct ReadyView: View {
    let order: Order
    @State private var ringing = true

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 72, weight: .light))
            Text("طلبك جاهز")
                .font(.largeTitle.weight(.semibold))
                .padding(.top, 8)
            Text(verbatim: "\(order.number)")
                .font(.system(size: 150, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(order.message)
                .font(.title3)
                .multilineTextAlignment(.center)
            if ringing {
                Text("المس الشاشة عشان توقّف التنبيه")
                    .font(.footnote)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .overlay(Capsule().stroke(.white.opacity(0.35)))
                    .padding(.top, 24)
            }
        }
        .foregroundStyle(.white)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.readyDeep.ignoresSafeArea())
        .contentShape(Rectangle())
        .onTapGesture { ringing = false }
        .task(id: "\(order.id)-\(order.notifyCount)") {
            ringing = true
            let haptics = UINotificationFeedbackGenerator()
            while ringing && !Task.isCancelled {
                AudioServicesPlayAlertSound(SystemSoundID(1005))
                haptics.notificationOccurred(.success)
                try? await Task.sleep(nanoseconds: 2_600_000_000)
            }
        }
    }
}

struct MessageView: View {
    let symbol: String
    let text: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Theme.accent)
            Text(text)
                .font(.title3)
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: 420)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Theme.surface))
        .padding(.horizontal, 16)
    }
}

struct PoweredByView: View {
    var body: some View {
        Link(destination: URL(string: "https://aurexis.cc/")!) {
            HStack(spacing: 7) {
                Text(verbatim: "Powered by").foregroundStyle(Theme.muted)
                AurexisMark().frame(width: 17, height: 16)
                Text(verbatim: "AUREXIS").fontWeight(.bold).tracking(2.8).foregroundStyle(Theme.text)
            }
            .font(.caption)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(Theme.background)
        }
        .environment(\.layoutDirection, .leftToRight)
    }
}
