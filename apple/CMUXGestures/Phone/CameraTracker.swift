@preconcurrency import AVFoundation
import ImageIO
import SwiftUI
import Vision

final class CameraTracker: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    var onFrame: ((HandFrame) -> Void)?
    var onStatus: ((String) -> Void)?

    private let queue = DispatchQueue(label: "cmux.gestures.camera")
    private let request: VNDetectHumanHandPoseRequest = {
        let request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = 1
        return request
    }()
    private var configured = false

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            queue.async { self.configureAndStart() }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted { self.queue.async { self.configureAndStart() } }
                else { self.onStatus?("Camera permission denied") }
            }
        default:
            onStatus?("Enable camera access in Settings")
        }
    }

    func stop() {
        queue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func configureAndStart() {
        if !configured {
            guard let camera = AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front)
                    ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                  let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else {
                onStatus?("Front camera unavailable")
                return
            }

            let output = AVCaptureVideoDataOutput()
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: queue)
            guard session.canAddOutput(output) else {
                onStatus?("Camera output unavailable")
                return
            }

            session.beginConfiguration()
            session.sessionPreset = .high
            session.addInput(input)
            session.addOutput(output)
            session.commitConfiguration()
            configured = true
        }

        if !session.isRunning { session.startRunning() }
        onStatus?("Show one hand")
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        let handler = VNImageRequestHandler(cmSampleBuffer: sampleBuffer, orientation: .leftMirrored)
        guard (try? handler.perform([request])) != nil,
              let hand = request.results?.first,
              let points = try? hand.recognizedPoints(.all),
              let wrist = valid(points[.wrist]),
              let thumb = valid(points[.thumbTip]),
              let index = valid(points[.indexTip]),
              let middle = valid(points[.middleMCP]) else {
            onStatus?("Show one hand")
            return
        }

        onFrame?(HandFrame(
            time: ProcessInfo.processInfo.systemUptime,
            wrist: wrist.location,
            thumbTip: thumb.location,
            indexTip: index.location,
            middleMCP: middle.location
        ))
    }

    private func valid(_ point: VNRecognizedPoint?) -> VNRecognizedPoint? {
        guard let point, point.confidence >= 0.3 else { return nil }
        return point
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}
}

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

    override init(frame: CGRect) {
        super.init(frame: frame)
        previewLayer.videoGravity = .resizeAspectFill
    }

    required init?(coder: NSCoder) { nil }
}
