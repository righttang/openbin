import AVFoundation
import Speech
import SwiftUI

@MainActor final class SpeechInput: ObservableObject {
    @Published var text = ""
    @Published private(set) var listening = false
    @Published private(set) var preparing = false
    @Published private(set) var finishing = false
    @Published private(set) var error: String?
    @Published private(set) var needsSettings = false
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var hasTap = false
    private var token = UUID()
    private var deadline: Task<Void, Never>?
    private var completion: ((String) -> Void)?

    func start() async {
        cancel()
        let sessionID = token
        text = ""; error = nil; needsSettings = false; preparing = true
        let authorization = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard token == sessionID else { return }
        guard authorization == .authorized else {
            preparing = false; needsSettings = authorization == .denied
            error = "请在系统设置中允许语音识别，也可以直接输入文字。"; return
        }
        let microphone = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard token == sessionID else { return }
        guard microphone else {
            preparing = false; needsSettings = true; error = "请在系统设置中允许麦克风，也可以直接输入文字。"; return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")), recognizer.isAvailable else {
            preparing = false; error = "语音识别暂不可用，请检查网络，或直接输入文字。"; return
        }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement)
            try audio.setActive(true)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.taskHint = .dictation
            // Prefer local recognition where this language is available on the phone.
            request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
            self.request = request
            let engine = AVAudioEngine()
            self.engine = engine
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw APIError.message("麦克风暂不可用。") }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            hasTap = true
            recognition = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                let transcript = result?.bestTranscription.formattedString
                let final = result?.isFinal == true
                let failed = failure != nil
                Task { @MainActor [weak self] in
                    guard let self, self.token == sessionID else { return }
                    if let transcript { self.text = transcript }
                    if final || failed {
                        let submitting = self.finishing
                        self.releaseAudio()
                        self.listening = false; self.preparing = false
                        if submitting { self.submit() }
                        else if failed && self.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            self.error = "没听清，请再说一次，或直接输入文字。"
                        }
                    }
                }
            }
            engine.prepare(); try engine.start()
            preparing = false; listening = true
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(55))
                guard !Task.isCancelled, let self, self.token == sessionID else { return }
                self.stopListening()
            }
        } catch {
            releaseAudio(); preparing = false; listening = false
            self.error = "麦克风暂不可用，请重试，或直接输入文字。"
        }
    }

    func stopListening() {
        deadline?.cancel(); deadline = nil
        if let engine, engine.isRunning { engine.stop() }
        if hasTap { engine?.inputNode.removeTap(onBus: 0); hasTap = false }
        request?.endAudio()
        listening = false
    }
    func finish(_ completion: @escaping (String) -> Void) {
        guard !finishing else { return }
        self.completion = completion
        if request == nil { submit(); return }
        finishing = true
        stopListening()
        let sessionID = token
        // Deliver the final words, with a short fallback if the recognizer never closes.
        deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self, self.token == sessionID else { return }
            self.submit()
        }
    }
    private func submit() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let action = completion
        completion = nil; finishing = false
        releaseAudio()
        token = UUID()
        if value.isEmpty { error = "还没有听到内容，请再说一次。" }
        else { action?(value) }
    }
    private func releaseAudio() {
        deadline?.cancel(); deadline = nil
        if let engine, engine.isRunning { engine.stop() }
        if hasTap { engine?.inputNode.removeTap(onBus: 0); hasTap = false }
        request?.endAudio(); request = nil
        recognition?.cancel(); recognition = nil
        engine?.reset(); engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func cancel() {
        token = UUID(); completion = nil
        releaseAudio(); listening = false; preparing = false; finishing = false
    }
}

struct InlineVoiceInput: View {
    let hint: String
    let actionTitle: String
    var title = "补充说明"
    let onCancel: () -> Void
    let onSubmit: (String) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var speech = SpeechInput()
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if speech.preparing { ProgressView().controlSize(.small) }
                Image(systemName: speech.listening ? "waveform" : "mic")
                    .foregroundStyle(speech.listening ? .red : .secondary)
                Text(speech.preparing ? "正在准备…" : speech.listening ? "正在听…" : title)
                    .font(.subheadline.weight(.medium))
                Spacer()
                Button { speech.cancel(); onCancel() } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 36)
                }.buttonStyle(.borderless).accessibilityLabel("取消语音").accessibilityIdentifier("voice.cancel")
            }
            TextField(hint, text: $speech.text, axis: .vertical)
                .lineLimit(2...5).padding(12).background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityIdentifier("voice.transcript")
            if let error = speech.error {
                HStack(alignment: .top) {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                    if speech.needsSettings { Link("设置", destination: URL(string: UIApplication.openSettingsURLString)!).font(.caption) }
                }
            }
            HStack {
                Button {
                    if speech.listening { speech.stopListening() }
                    else { Task { await speech.start() } }
                } label: {
                    Label(speech.listening ? "暂停" : "重说", systemImage: speech.listening ? "stop.fill" : "mic.fill")
                }.buttonStyle(.borderless).disabled(speech.preparing || speech.finishing).accessibilityIdentifier("voice.microphone")
                Spacer()
                Button {
                    speech.finish { text in onSubmit(text) }
                } label: {
                    HStack(spacing: 6) {
                        if speech.finishing { ProgressView().controlSize(.small) }
                        Text(speech.finishing ? "确认中…" : actionTitle)
                    }
                }.buttonStyle(.borderedProminent)
                    .disabled(speech.preparing || speech.finishing || speech.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("voice.submit")
            }
        }.padding(12).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
            .task { await speech.start() }
            .onDisappear { speech.cancel() }
            .onChange(of: scenePhase) { _, phase in if phase == .background { speech.cancel() } }
    }
}
