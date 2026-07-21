import CoreMotion
import SwiftUI
import WatchConnectivity

@main
struct CMUXGesturesWatchApp: App {
    @StateObject private var bridge = WatchMotionBridge()

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 10) {
                Image(systemName: bridge.reachable ? "iphone.radiowaves.left.and.right" : "iphone.slash")
                    .font(.title)
                    .foregroundStyle(bridge.reachable ? .green : .orange)
                Text(bridge.reachable ? "Tracking motion" : "Open iPhone app")
                    .font(.caption)
                Text(bridge.motion.formatted(.number.precision(.fractionLength(2))))
                    .font(.title2.monospacedDigit())
                Button("Confirm") { bridge.confirm() }
                    .buttonStyle(.borderedProminent)
                    .handGestureShortcut(.primaryAction)
            }
            .onAppear { bridge.start() }
            .onDisappear { bridge.stop() }
        }
    }
}

@MainActor
final class WatchMotionBridge: NSObject, ObservableObject, @preconcurrency WCSessionDelegate {
    @Published var reachable = false
    @Published var motion = 0.0

    private let manager = CMMotionManager()
    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    func start() {
        session?.delegate = self
        session?.activate()
        reachable = session?.isReachable == true
        guard manager.isDeviceMotionAvailable else { return }

        manager.deviceMotionUpdateInterval = 1 / 20
        manager.startDeviceMotionUpdates(to: .main) { [weak self] sample, _ in
            guard let self, let sample else { return }
            let acceleration = sample.userAcceleration
            let rotation = sample.rotationRate
            let score = sqrt(
                acceleration.x * acceleration.x
                    + acceleration.y * acceleration.y
                    + acceleration.z * acceleration.z
            ) + 0.05 * sqrt(
                rotation.x * rotation.x
                    + rotation.y * rotation.y
                    + rotation.z * rotation.z
            )
            motion = score
            if session?.isReachable == true {
                session?.sendMessage(["motion": score], replyHandler: nil)
            }
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
    }

    func confirm() {
        guard session?.isReachable == true else { return }
        session?.sendMessage(["gesture": "confirm"], replyHandler: nil)
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor in self.reachable = session.isReachable }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in self.reachable = session.isReachable }
    }
}
