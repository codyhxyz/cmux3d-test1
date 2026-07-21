import CoreGraphics
import Foundation

struct HandFrame {
    let time: TimeInterval
    let wrist: CGPoint
    let thumbTip: CGPoint
    let indexTip: CGPoint
    let middleMCP: CGPoint

    var pinchRatio: CGFloat {
        distance(thumbTip, indexTip) / max(distance(wrist, middleMCP), 0.001)
    }
}

enum SwipeDirection: String, Equatable {
    case left, right, up, down
}

enum TrackedGesture: Equatable {
    case pinchBegan
    case pinchEnded
    case swipe(SwipeDirection, watchAssisted: Bool)

    var label: String {
        switch self {
        case .pinchBegan: "Pinch"
        case .pinchEnded: "Release"
        case let .swipe(direction, assisted): "Swipe \(direction.rawValue)\(assisted ? " + Watch" : "")"
        }
    }
}

struct GestureEngine {
    private(set) var pinching = false
    private var pinchCandidateSince: TimeInterval?
    private var releaseCandidateSince: TimeInterval?
    private var wristHistory: [HandFrame] = []
    private var swipeCooldownUntil: TimeInterval = 0

    mutating func update(
        _ frame: HandFrame,
        watchMotion: Double,
        pinchThreshold: CGFloat,
        swipeDistance: CGFloat
    ) -> [TrackedGesture] {
        var events: [TrackedGesture] = []
        let ratio = frame.pinchRatio

        if pinching {
            if ratio >= pinchThreshold + 0.14 {
                releaseCandidateSince = releaseCandidateSince ?? frame.time
                if frame.time - releaseCandidateSince! >= 0.05 {
                    pinching = false
                    releaseCandidateSince = nil
                    events.append(.pinchEnded)
                }
            } else {
                releaseCandidateSince = nil
            }
        } else if ratio <= pinchThreshold {
            pinchCandidateSince = pinchCandidateSince ?? frame.time
            if frame.time - pinchCandidateSince! >= 0.07 {
                pinching = true
                pinchCandidateSince = nil
                wristHistory.removeAll()
                events.append(.pinchBegan)
            }
        } else {
            pinchCandidateSince = nil
        }

        guard !pinching else {
            wristHistory.removeAll()
            return events
        }
        wristHistory.append(frame)
        wristHistory.removeAll { frame.time - $0.time > 0.35 }
        guard frame.time >= swipeCooldownUntil, let first = wristHistory.first,
              frame.time - first.time >= 0.08 else { return events }

        let watchAssisted = watchMotion >= 0.12
        let threshold = swipeDistance * (watchAssisted ? 0.65 : 1)
        let dx = frame.wrist.x - first.wrist.x
        let dy = frame.wrist.y - first.wrist.y
        guard hypot(dx, dy) >= threshold else { return events }

        let direction: SwipeDirection = abs(dx) > abs(dy)
            ? (dx > 0 ? .right : .left)
            : (dy > 0 ? .up : .down)
        events.append(.swipe(direction, watchAssisted: watchAssisted))
        wristHistory.removeAll()
        swipeCooldownUntil = frame.time + 0.3
        return events
    }
}

private func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
    hypot(a.x - b.x, a.y - b.y)
}
