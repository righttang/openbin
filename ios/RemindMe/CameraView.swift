import AVFoundation
import SwiftUI
import UIKit

/// Capture configuration and start/stop never block the main thread.
final class CameraController: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate {
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let sessionQueue = DispatchQueue(label: "remindme.camera")
    private var configured = false
    private var wantsRunning = false
    @Published var ready = false
    @Published var error: String?
    @Published var capturing = false
    var onPhoto: ((Data) -> Void)?

    func start() {
        sessionQueue.async { self.wantsRunning = true }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { allowed in
                if allowed { self.configure() } else { self.fail("请在设置中允许相机访问，或返回选择已有照片。") }
            }
        default: fail("请在设置中允许相机访问，或返回选择已有照片。")
        }
    }
    private func configure() {
        sessionQueue.async {
            guard self.wantsRunning else { return }
            do {
                if !self.configured {
                    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { self.fail("此设备没有可用相机，请返回从相册选择照片。"); return }
                    let input = try AVCaptureDeviceInput(device: camera)
                    self.session.beginConfiguration(); self.session.sessionPreset = .photo
                    guard self.session.canAddInput(input), self.session.canAddOutput(self.output) else { self.session.commitConfiguration(); self.fail("相机暂时不可用，请稍后重试。"); return }
                    self.session.addInput(input); self.session.addOutput(self.output)
                    self.output.maxPhotoQualityPrioritization = .balanced
                    self.session.commitConfiguration(); self.configured = true
                }
                self.session.startRunning()
                DispatchQueue.main.async { self.ready = self.session.isRunning; self.error = nil }
            } catch { self.fail("无法启动相机：\(error.localizedDescription)") }
        }
    }
    func stop() {
        sessionQueue.async { self.wantsRunning = false; if self.session.isRunning { self.session.stopRunning() } }
        DispatchQueue.main.async { self.ready = false }
    }
    func shoot() {
        guard ready, !capturing else { return }
        capturing = true
        sessionQueue.async {
            let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            settings.photoQualityPrioritization = .balanced
            if let connection = self.output.connection(with: .video), connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
            self.output.capturePhoto(with: settings, delegate: self)
        }
    }
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let data = photo.fileDataRepresentation()
        DispatchQueue.main.async {
            self.capturing = false
            if let data, error == nil { self.onPhoto?(data) }
            else { self.error = "没有拍到照片，请再试一次。" }
        }
    }
    private func fail(_ message: String) { DispatchQueue.main.async { self.error = message; self.ready = false } }
}

final class PreviewSurface: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    override func layoutSubviews() {
        super.layoutSubviews()
        if let connection = preview.connection, connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
    }
}
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> PreviewSurface { let view = PreviewSurface(); view.preview.session = session; view.preview.videoGravity = .resizeAspectFill; return view }
    func updateUIView(_ view: PreviewSurface, context: Context) {}
}

struct CameraScreen: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var queue: CaptureQueue
    @StateObject private var camera = CameraController()
    let place: Place
    @State private var saving = 0
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraPreview(session: camera.session).ignoresSafeArea()
            VStack(spacing: 16) {
                HStack {
                    Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44).background(.black.opacity(0.55), in: Circle()) }.accessibilityLabel("关闭相机")
                    Spacer()
                    Label(place.name, systemImage: "mappin.and.ellipse").font(.subheadline.weight(.semibold)).padding(.horizontal, 16).padding(.vertical, 12).background(.black.opacity(0.55), in: Capsule())
                }.padding(.horizontal)
                if let error = camera.error { Text(error).padding().background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 16)) }
                if let error = store.error { Text(error).font(.footnote).padding().background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 12)) }
                Spacer()
                CameraStrip(queue: queue, place: place)
                Text(saving > 0 ? "正在保存照片…" : "按快门自动识别，继续拍下一张").font(.footnote).padding(8).background(.black.opacity(0.6), in: Capsule())
                Button { camera.shoot() } label: {
                    ZStack { Circle().stroke(.white, lineWidth: 4).frame(width: 82, height: 82); Circle().fill(.white.opacity(camera.ready ? 1 : 0.3)).frame(width: 68, height: 68); if camera.capturing { ProgressView().tint(.black) } }
                }.disabled(!camera.ready || camera.capturing || saving >= 3).accessibilityLabel("拍摄照片").padding(.bottom, 16)
            }.foregroundStyle(.white)
        }
        .onAppear {
            camera.onPhoto = { data in
                saving += 1
                Task { await store.receive(data, at: place); saving -= 1 }
            }
            camera.start()
        }
        .onDisappear { camera.stop() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { camera.start() } else { camera.stop() } }
    }
}

struct CameraStrip: View {
    @ObservedObject var queue: CaptureQueue
    let place: Place
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(queue.drafts.filter { $0.place.id == place.id && $0.state != "cancelled" }.prefix(8)) { draft in
                    VStack(spacing: 5) {
                        ZStack(alignment: .topTrailing) {
                            LocalThumbnail(url: queue.thumbnailURL(draft.id)).frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 12))
                            Button { queue.cancel(draft.id) } label: { Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.7)).frame(width: 44, height: 44) }.accessibilityLabel("取消照片\(draft.id)").disabled(draft.cancelRequested)
                        }
                        Text(draft.label).font(.caption2)
                    }
                }
            }.padding(.horizontal)
        }.frame(height: 102)
    }
}
