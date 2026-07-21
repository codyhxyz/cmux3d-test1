# CMUX Gestures MVP

A disposable native prototype for answering one question: does an iPhone camera plus Apple Watch motion make our core gestures reliable enough to integrate into CMUX3D?

It tracks:

- Pinch and release from the iPhone front-camera hand skeleton
- Four-direction swipes from wrist movement
- Watch-assisted swipes, using recent Watch IMU motion to accept a shorter visual stroke
- Apple Watch Double Tap as a high-confidence confirm action

## Run

```bash
cd apple/CMUXGestures
xcodegen generate
open CMUXGestures.xcodeproj
```

Select your Apple development team, run the `CMUXGestures` scheme on the iPhone, then run `CMUXGesturesWatch` on its paired Watch. Keep both apps visible during this MVP test. Adjust the two on-screen thresholds against real failure cases.

Run the detector check without signing:

```bash
xcodebuild test \
  -project CMUXGestures.xcodeproj \
  -scheme CMUXGestures \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

## Deliberately skipped

No LiDAR/TrueDepth depth samples, UWB, networking to CMUX3D, background Watch workout session, two-hand identity, or webcam fusion. The prototype uses the TrueDepth camera's color stream and native Vision/Core Motion/WatchConnectivity only. Add each skipped sensor only after recordings show which failure it fixes.
