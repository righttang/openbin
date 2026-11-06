import SwiftUI
import PhotosUI

struct ScanView: View {
    @EnvironmentObject var store: AppStore
    @ObservedObject var queue: CaptureQueue
    let managePlaces: () -> Void
    @State private var cameraPlace: Place?
    @State private var selectedPhoto: HistoryPhoto?
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var pickerPlace: Place?
    @State private var galleryPresented = false
    @State private var importing = false
    var visibleDrafts: [PhotoDraft] { queue.drafts.filter { $0.state != "cancelled" }.prefix(12).map { $0 } }
    var otherHistory: [HistoryPhoto] { store.history.filter { photo in !queue.drafts.contains(where: { $0.id == photo.capture_id }) }.prefix(12).map { $0 } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ConnectionNote()
                VStack(alignment: .leading, spacing: 12) {
                    Text("物品放在哪？").font(.subheadline).foregroundStyle(.secondary)
                    Menu {
                        ForEach(store.places) { place in Button { store.selectedPlaceID = place.id } label: { if store.selectedPlaceID == place.id { Label(place.name, systemImage: "checkmark") } else { Text(place.name) } } }
                        Divider()
                        Button("添加或管理地点", systemImage: "plus") { managePlaces() }
                    } label: {
                        HStack { Image(systemName: "mappin.and.ellipse"); Text(store.selectedPlace?.name ?? "添加第一个地点").fontWeight(.semibold); Spacer(); Image(systemName: "chevron.down").font(.caption) }
                            .padding().background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                    }.accessibilityIdentifier("scan.place")
                    Button {
                        if let place = store.selectedPlace { cameraPlace = place } else { managePlaces() }
                    } label: { Label(store.places.isEmpty ? "添加地点，开始拍照" : "拍照", systemImage: "camera.fill").font(.title3.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 16) }
                        .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("scan.camera")
                    Button {
                        pickerPlace = store.selectedPlace; galleryPresented = true
                    } label: { Label(importing ? "正在保存照片…" : "从相册选择", systemImage: "photo.on.rectangle").frame(maxWidth: .infinity).padding(.vertical, 8) }
                        .disabled(store.selectedPlace == nil || importing).accessibilityIdentifier("scan.gallery")
                    Text("拍完自动识别，继续拍下一张。没拍到的物品仍会保留。").font(.footnote).foregroundStyle(.secondary)
                }
                if let error = queue.storageError { Text(error).font(.footnote).foregroundStyle(.red) }
                if queue.unsubmittedCount > 0 { Label("\(queue.unsubmittedCount) 张保存在手机，等待上传", systemImage: "iphone").font(.footnote).foregroundStyle(.secondary) }
                VStack(alignment: .leading, spacing: 12) {
                    HStack { Text("最近拍摄").font(.headline); Spacer(); if store.loading { ProgressView() } }
                    if visibleDrafts.isEmpty && otherHistory.isEmpty {
                        ContentUnavailableView("给物品拍张照", systemImage: "camera.viewfinder", description: Text("以后想找时，输入名称就能知道放在哪。"))
                    }
                    ForEach(visibleDrafts) { draft in
                        HStack(spacing: 12) {
                            Button {
                                selectedPhoto = store.history.first { $0.capture_id == draft.id }
                            } label: {
                                HStack(spacing: 12) {
                                    LocalThumbnail(url: queue.thumbnailURL(draft.id)).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12))
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(draft.place.name).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                                        Text(draft.label).font(.caption).foregroundStyle(draft.state == "applied" ? .green : .secondary)
                                        if let photo = store.history.first(where: { $0.capture_id == draft.id }), photo.state == "applied" { Text("\(photo.items.count) 类物品 · 点开查看").font(.caption).foregroundStyle(.secondary) }
                                    }
                                    Spacer(minLength: 0)
                                }
                            }.buttonStyle(.plain).disabled(!store.history.contains(where: { $0.capture_id == draft.id }))
                            if draft.error != nil || draft.state == "expired" { Button { queue.retry(draft.id) } label: { Image(systemName: "arrow.clockwise").frame(width: 44, height: 44) }.accessibilityLabel("重试照片") }
                            Button { queue.cancel(draft.id) } label: { Image(systemName: "xmark").foregroundStyle(.secondary).frame(width: 44, height: 44) }.disabled(draft.cancelRequested).accessibilityLabel("取消\(draft.place.name)的照片")
                        }
                    }
                    ForEach(otherHistory) { photo in
                        Button { selectedPhoto = photo } label: {
                            HStack(spacing: 12) {
                                RemotePhoto(path: photo.preview_url).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12))
                                VStack(alignment: .leading, spacing: 5) { Text(photo.bin_name).font(.subheadline.weight(.medium)); Text(photo.state == "applied" ? "\(photo.items.count) 类物品 · 点开查看" : "\(stateLabel(photo.state)) · \(photoDate(photo.captured_at))").font(.caption).foregroundStyle(.secondary) }
                                Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            }.foregroundStyle(.primary)
                        }.buttonStyle(.plain)
                    }
                }
            }.padding(20)
        }.navigationTitle("扫描").refreshable { await store.activate() }
            .fullScreenCover(item: $cameraPlace) { place in CameraScreen(queue: queue, place: place) }
            .sheet(item: $selectedPhoto) { photo in NavigationStack { PhotoDetailView(photo: photo).toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { selectedPhoto = nil } } } } }
            .photosPicker(isPresented: $galleryPresented, selection: $pickerItems, maxSelectionCount: 10, matching: .images)
            .onChange(of: pickerItems) { _, selected in
                guard !selected.isEmpty, let place = pickerPlace else { return }
                importing = true
                Task {
                    for item in selected {
                        do { if let data = try await item.loadTransferable(type: Data.self) { await store.receive(data, at: place) } }
                        catch { store.error = "相册照片无法读取，请重试。" }
                    }
                    pickerItems = []; importing = false
                }
            }
    }
}
