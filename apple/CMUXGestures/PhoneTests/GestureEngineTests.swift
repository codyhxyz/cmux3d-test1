import CoreGraphics
import XCTest
@testable import CMUXGestures

final class GestureEngineTests: XCTestCase {
    func testPinchRequiresHoldAndReleaseHysteresis() {
        var engine = GestureEngine()

        XCTAssertEqual(engine.update(frame(time: 0), watchMotion: 0, pinchThreshold: 0.34, swipeDistance: 0.18), [])
        XCTAssertEqual(engine.update(frame(time: 0.01, thumbX: 0.51), watchMotion: 0, pinchThreshold: 0.34, swipeDistance: 0.18), [])
        XCTAssertEqual(engine.update(frame(time: 0.09, thumbX: 0.51), watchMotion: 0, pinchThreshold: 0.34, swipeDistance: 0.18), [.pinchBegan])
        XCTAssertEqual(engine.update(frame(time: 0.1, wristX: 0.6), watchMotion: 0.2, pinchThreshold: 0.34, swipeDistance: 0.18), [])
        XCTAssertEqual(engine.update(frame(time: 0.16, wristX: 0.6), watchMotion: 0.2, pinchThreshold: 0.34, swipeDistance: 0.18), [.pinchEnded])
    }

    func testWatchMotionAllowsAShorterVisualSwipe() {
        var engine = GestureEngine()

        XCTAssertEqual(engine.update(frame(time: 0.5, wristX: 0.3), watchMotion: 0.2, pinchThreshold: 0.34, swipeDistance: 0.18), [])
        XCTAssertEqual(
            engine.update(frame(time: 0.6, wristX: 0.43), watchMotion: 0.2, pinchThreshold: 0.34, swipeDistance: 0.18),
            [.swipe(.right, watchAssisted: true)]
        )
    }

    private func frame(time: TimeInterval, wristX: CGFloat = 0.3, thumbX: CGFloat = 0.8) -> HandFrame {
        HandFrame(
            time: time,
            wrist: CGPoint(x: wristX, y: 0.2),
            thumbTip: CGPoint(x: thumbX, y: 0.6),
            indexTip: CGPoint(x: 0.5, y: 0.6),
            middleMCP: CGPoint(x: 0.3, y: 0.7)
        )
    }
}
