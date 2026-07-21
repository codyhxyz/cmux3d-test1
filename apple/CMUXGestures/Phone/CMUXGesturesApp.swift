import SwiftUI

@main
struct CMUXGesturesApp: App {
    @StateObject private var model = GestureModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
        }
    }
}

struct ContentView: View {
    @ObservedObject var model: GestureModel

    var body: some View {
        ZStack {
            CameraPreview(session: model.camera.session)
                .ignoresSafeArea()
            LinearGradient(colors: [.black.opacity(0.65), .clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            VStack(spacing: 12) {
                HStack {
                    status(model.status, color: model.status == "Tracking" ? .green : .orange)
                    Spacer()
                    status(model.watchStatus, color: model.watchStatus == "Watch connected" ? .green : .orange)
                }

                Spacer()

                Text(model.latestGesture)
                    .font(.system(size: 36, weight: .bold, design: .rounded))

                VStack(spacing: 8) {
                    metric("Pinch ratio", model.pinchRatio)
                    metric("Watch motion", model.watchMotion)
                    slider("Pinch threshold", value: $model.pinchThreshold, range: 0.18...0.55)
                    slider("Swipe distance", value: $model.swipeDistance, range: 0.08...0.32)

                    if !model.events.isEmpty {
                        Text(model.events.joined(separator: "  ·  "))
                            .font(.caption)
                            .lineLimit(2)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding()
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
            .padding()
            .foregroundStyle(.white)
        }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private func status(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.22), in: Capsule())
    }

    private func metric(_ name: String, _ value: Double) -> some View {
        HStack {
            Text(name)
            Spacer()
            Text(value.formatted(.number.precision(.fractionLength(2))))
                .monospacedDigit()
        }
        .font(.subheadline)
    }

    private func slider(_ name: String, value: Binding<Double>, range: ClosedRange<Double>) -> some View {
        VStack(spacing: 2) {
            metric(name, value.wrappedValue)
            Slider(value: value, in: range)
                .accessibilityLabel(name)
        }
    }
}
