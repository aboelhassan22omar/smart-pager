import ActivityKit
import Foundation
import SwiftUI

/// Parses the invocation URL (/s/{shop}?n|k|o), claims or resumes the order,
/// starts the Live Activity with a push token and polls while in the foreground.
@MainActor
final class OrderModel: ObservableObject {
    /// Same minimum as the web splash (SPLASH_MIN_MS = 1100).
    static let splashMinimum: TimeInterval = 1.1
    private static let pollInterval: UInt64 = 4_000_000_000

    enum Phase: Equatable {
        case splash
        case idle
        case tracking
        case failed(String)
    }

    @Published private(set) var phase: Phase = .splash
    @Published private(set) var shop: Shop?
    @Published private(set) var order: Order?

    /// "app" or "clip": tells the server which APNs topic to use.
    let appKind: String
    private let api = PagerAPI()
    private var activity: Activity<PagerAttributes>?
    private var pollTask: Task<Void, Never>?
    private var tokenTask: Task<Void, Never>?
    private var isForeground = true
    private var isLoading = false
    private var lastURL: URL?

    init(appKind: String) {
        self.appKind = appKind
    }

    // MARK: - Entry points

    /// Called once on launch. Without an invocation URL, resumes the last order.
    func boot() {
        Task {
            try? await Task.sleep(nanoseconds: UInt64(Self.splashMinimum * 1_000_000_000))
            guard !isLoading, phase == .splash else { return }
            let defaults = UserDefaults.standard
            if let shopId = defaults.string(forKey: "lastShop"),
               let orderId = defaults.string(forKey: savedKey(shopId)),
               let url = URL(string: "\(PagerAPI.baseURL.absoluteString)/s/\(shopId)?o=\(orderId)") {
                handle(url: url)
            } else {
                phase = .idle
            }
        }
    }

    func handle(url: URL) {
        guard url != lastURL else { return }
        lastURL = url
        Task { await load(url) }
    }

    /// Counts the "rate us on Google" tap (once per order, server side).
    func recordReviewClick() {
        guard let id = order?.id else { return }
        let api = self.api
        Task { try? await api.reviewClick(orderId: id) }
    }

    func setForeground(_ active: Bool) {
        isForeground = active
        if active {
            Task { await refresh() }
            startPolling()
        } else {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    // MARK: - Loading

    private func load(_ url: URL) async {
        isLoading = true
        defer { isLoading = false }
        let started = Date()
        phase = .splash

        let result = await resolve(url)

        let elapsed = Date().timeIntervalSince(started)
        if elapsed < Self.splashMinimum {
            try? await Task.sleep(nanoseconds: UInt64((Self.splashMinimum - elapsed) * 1_000_000_000))
        }

        switch result {
        case .failure(let error):
            phase = .failed(error.message)
        case .success(let resolved):
            order = resolved
            let defaults = UserDefaults.standard
            defaults.set(resolved.id, forKey: savedKey(resolved.shopId))
            defaults.set(resolved.shopId, forKey: "lastShop")
            phase = .tracking
            await startActivity(for: resolved)
            startPolling()
        }
    }

    private func resolve(_ url: URL) async -> Result<Order, PagerError> {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return .failure(PagerError(message: "الرابط ده مش مظبوط"))
        }
        let parts = components.path.split(separator: "/").map(String.init)
        guard parts.count >= 2, parts[0] == "s" else {
            return .failure(PagerError(message: "امسح الكود اللي عند الكاشير عشان تاخد رقم طلبك"))
        }
        let shopId = parts[1]
        var query: [String: String] = [:]
        for item in components.queryItems ?? [] {
            if let value = item.value, query[item.name] == nil { query[item.name] = value }
        }

        do {
            shop = try await api.shop(shopId)
            var current: Order?
            if let savedId = query["o"] ?? UserDefaults.standard.string(forKey: savedKey(shopId)) {
                current = try? await api.order(savedId)
            }
            if let found = current, found.shopId != shopId { current = nil }
            let canClaim = query["n"] != nil || query["k"] != nil
            if canClaim, current?.isClosed ?? true {
                current = try await api.claim(shopId: shopId, n: query["n"], k: query["k"])
            }
            guard let resolved = current else {
                return .failure(PagerError(message: "امسح الكود اللي عند الكاشير عشان تاخد رقم طلبك"))
            }
            return .success(resolved)
        } catch let error as PagerError {
            return .failure(error)
        } catch {
            return .failure(PagerError(message: "حصلت مشكلة. جرّب تاني"))
        }
    }

    private func savedKey(_ shopId: String) -> String { "order.\(shopId)" }

    // MARK: - Polling (foreground only)

    private func startPolling() {
        pollTask?.cancel()
        guard isForeground, let order, !order.isClosed else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: OrderModel.pollInterval)
                guard let self, !Task.isCancelled else { return }
                await self.refresh()
            }
        }
    }

    func refresh() async {
        guard let current = order, !current.isClosed,
              let fresh = try? await api.order(current.id) else { return }
        guard fresh != current else { return }
        order = fresh
        await updateActivity(fresh)
        if fresh.isClosed {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    // MARK: - Live Activity

    private func state(for order: Order) -> PagerAttributes.ContentState {
        PagerAttributes.ContentState(status: order.status, number: order.number,
                                     message: order.message, shopName: order.shopName)
    }

    private func startActivity(for order: Order) async {
        for other in Activity<PagerAttributes>.activities where other.attributes.orderId != order.id {
            await other.end(nil, dismissalPolicy: .immediate)
        }
        guard !order.isClosed, ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        if let existing = Activity<PagerAttributes>.activities.first(where: { $0.attributes.orderId == order.id }) {
            activity = existing
            observePushToken(existing)
            await updateActivity(order)
            return
        }

        do {
            let created = try Activity<PagerAttributes>.request(
                attributes: PagerAttributes(shopId: order.shopId, orderId: order.id),
                content: ActivityContent(state: state(for: order), staleDate: nil),
                pushType: .token
            )
            activity = created
            observePushToken(created)
        } catch {
            print("Live Activity request failed: \(error)")
        }
    }

    /// Every new push token goes to /api/subscribe so the server can update the activity.
    private func observePushToken(_ activity: Activity<PagerAttributes>) {
        tokenTask?.cancel()
        let orderId = activity.attributes.orderId
        let kind = appKind
        let api = self.api
        tokenTask = Task {
            for await data in activity.pushTokenUpdates {
                let token = data.map { String(format: "%02x", $0) }.joined()
                try? await api.subscribeLiveActivity(orderId: orderId, token: token, app: kind)
            }
        }
    }

    private func updateActivity(_ order: Order) async {
        guard let activity else { return }
        let content = ActivityContent(state: state(for: order), staleDate: nil)
        if order.isClosed {
            await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(15 * 60)))
            self.activity = nil
            tokenTask?.cancel()
        } else {
            await activity.update(content)
        }
    }
}
