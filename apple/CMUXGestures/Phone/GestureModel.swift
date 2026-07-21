import Foundation
import WatchConnectivity

@MainActor
final class GestureModel: ObservableObject {
    @Published var status = "Starting camera…"
    @Published var watchStatus = "Watch disconnected"
    @Published var latestGesture = "None yet"
    @Published var pinchRatio: Double = 0
    @Published var watchMotion: Double = 0
    @Published var pinchThreshold: Double = 0.34
    @Published var swipeDistance: Double = 0.18
    @Published var events: [String] = []

    let camera = CameraTracker()
    private let watch = PhoneWatchBridge()
    private var engine = GestureEngine()
    private var latestWatchMotionTime: TimeInterval = 0

    init() {
        camera.onStatus = { [weak self] status in
            DispatchQueue.main.async { self?.status = status }
        }
        camera.onFrame = { [weak self] frame in
            DispatchQueue.main.async { self?.consume(frame) }
        }
        watch.onReachability = { [weak self] reachable in
            self?.watchStatus = reachable ? "Watch connected" : "Open the Watch app"
        }
        watch.onMotion = { [weak self] motion in
            guard let self else { return }
            watchMotion = motion
            latestWatchMotionTime = ProcessInfo.processInfo.systemUptime
        }
        watch.onConfirm = { [weak self] in self?.record("Watch confirm") }
    }

    func start() {
        camera.start()
        watch.start()
    }

    func stop() {
        camera.stop()
    }

    private func consume(_ frame: HandFrame) {
        status = "Tracking"
        pinchRatio = frame.pinchRatio
        let motion = frame.time - latestWatchMotionTime <= 0.3 ? watchMotion : 0
        for gesture in engine.update(
            frame,
            watchMotion: motion,
            pinchThreshold: pinchThreshold,
            swipeDistance: swipeDistance
        ) {
            record(gesture.label)
        }
    }

    private func record(_ label: String) {
        latestGesture = label
        events.insert(label, at: 0)
        events = Array(events.prefix(5))
    }
}

@MainActor
private final class PhoneWatchBridge: NSObject, @preconcurrency WCSessionDelegate {
    var onMotion: ((Double) -> Void)?
    var onConfirm: (() -> Void)?
    var onReachability: ((Bool) -> Void)?

    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    func start() {
        session?.delegate = self
        session?.activate()
        onReachability?(session?.isReachable == true)
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor in self.onReachability?(session.isReachable) }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in self.onReachability?(session.isReachable) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in
            if let motion = message["motion"] as? Double { self.onMotion?(motion) }
            if message["gesture"] as? String == "confirm" { self.onConfirm?() }
        }
    }
}
