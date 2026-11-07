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
    private let engine = AVAudioEngine()
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
        if engine.isRunning { engine.stop() }
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
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
        if engine.isRunning { engine.stop() }
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        request?.endAudio(); request = nil
        recognition?.cancel(); recognition = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func cancel() {
        token = UUID(); completion = nil
        releaseAudio(); listening = false; preparing = false; finishing = false
    }
}

struct VoiceInputSheet: View {
    let title: String
    let hint: String
    let actionTitle: String
    let onSubmit: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var speech = SpeechInput()
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text(hint).font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                TextEditor(text: $speech.text).font(.title3).frame(minHeight: 120, maxHeight: 220)
                    .padding(10).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                    .accessibilityIdentifier("voice.transcript")
                if speech.preparing { ProgressView("正在准备麦克风…") }
                else {
                    Button {
                        if speech.listening { speech.stopListening() }
                        else { Task { await speech.start() } }
                    } label: {
                        Label(speech.listening ? "正在听，点此暂停" : "重新说一遍", systemImage: speech.listening ? "waveform" : "mic.fill")
                            .font(.headline).padding().frame(maxWidth: .infinity)
                    }.buttonStyle(.bordered).tint(speech.listening ? .red : .accentColor).disabled(speech.finishing)
                        .accessibilityIdentifier("voice.microphone")
                }
                if let error = speech.error { Text(error).font(.footnote).foregroundStyle(.red) }
                if speech.needsSettings {
                    Link("打开系统设置", destination: URL(string: UIApplication.openSettingsURLString)!).font(.subheadline)
                }
                Spacer(minLength: 0)
                Button {
                    speech.finish { text in onSubmit(text); dismiss() }
                } label: {
                    HStack { if speech.finishing { ProgressView().tint(.white) }; Text(speech.finishing ? "正在确认语音…" : actionTitle) }
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                }.buttonStyle(.borderedProminent)
                    .disabled(speech.preparing || speech.finishing || speech.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("voice.submit")
            }.padding(20).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { speech.cancel(); dismiss() } } }
        }.task { await speech.start() }
            .onDisappear { speech.cancel() }
            .onChange(of: scenePhase) { _, phase in if phase == .background { speech.cancel() } }
    }
}
