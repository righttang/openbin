import SwiftUI

struct PlacesView: View {
    @EnvironmentObject var store: AppStore
    let scan: () -> Void
    @State private var name = ""
    @State private var editing: Place?
    @State private var editName = ""
    @State private var deleting: Place?
    @State private var busy = false
    @State private var error: String?
    @State private var activeVoiceID: String?
    var body: some View {
        List {
            Section {
                HStack {
                    TextField("例如：书桌抽屉", text: $name).accessibilityIdentifier("places.name")
                    Button("添加") {
                        busy = true
                        Task {
                            do { try await store.addPlace(name); name = ""; error = nil }
                            catch { self.error = error.localizedDescription }
                            busy = false
                        }
                    }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy).accessibilityIdentifier("places.add")
                }
            } header: { Text("新地点") } footer: { Text("直接给抽屉、盒子或架子命名，不需要创建多层分类。") }
            if let error = error ?? store.error { Text(error).foregroundStyle(.red).font(.footnote) }
            Section("已有地点") {
                ForEach(store.places) { place in
                    HStack {
                        PlaceDescriptionView(place: place, activeVoiceID: $activeVoiceID, prefix: "places", onSelect: { store.selectedPlaceID = place.id; scan() })
                        Menu {
                            Button("改名", systemImage: "pencil") { editing = place; editName = place.name }
                            Button("删除地点", systemImage: "trash", role: .destructive) { deleting = place }
                        } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }.accessibilityLabel("管理\(place.name)")
                    }
                }
            }
        }.navigationTitle("地点管理").safeAreaInset(edge: .bottom) { UndoBanner() }
            .alert("地点改名", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
                TextField("地点名称", text: $editName)
                Button("取消", role: .cancel) { editing = nil }
                Button("保存") {
                    guard let place = editing, !editName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    Task { do { try await store.rename(place, to: editName); editing = nil } catch { self.error = error.localizedDescription } }
                }
            }
            .alert("删除地点？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { place in
                Button("确认删除", role: .destructive) { Task { await store.deletePlace(place) }; deleting = nil }
                Button("保留", role: .cancel) { deleting = nil }
            } message: { place in
                Text("将删除“\(place.name)”及其中的物品记录，删除后可以撤销。")
            }
    }
}

struct HistoryView: View {
    @EnvironmentObject var store: AppStore
    @State private var place = ""
    var filtered: [HistoryPhoto] { store.history.filter { place.isEmpty || $0.bin_id == place } }
    var body: some View {
        List {
            Picker("地点", selection: $place) { Text("所有地点").tag(""); ForEach(store.places) { Text($0.name).tag($0.id) } }
            if filtered.isEmpty { ContentUnavailableView("还没有拍摄记录", systemImage: "photo.stack", description: Text("扫描后，这里会按照片保存识别结果。")) }
            ForEach(filtered) { photo in
                NavigationLink {
                    PhotoDetailView(photo: photo)
                } label: {
                    HStack(spacing: 14) {
                        RemotePhoto(path: photo.preview_url).frame(width: 88, height: 76).clipShape(RoundedRectangle(cornerRadius: 12))
                        VStack(alignment: .leading, spacing: 6) {
                            Text(photo.bin_name).font(.headline)
                            Text(photo.state == "applied" ? "\(photo.items.count) 类物品" : stateLabel(photo.state)).font(.subheadline).foregroundStyle(.secondary)
                            Text(photoDate(photo.captured_at)).font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 5)
                }
            }
        }.listStyle(.plain).navigationTitle("照片历史").refreshable { await store.refresh() }
            .task {
                while !Task.isCancelled {
                    await store.refresh()
                    try? await Task.sleep(for: .seconds(5))
                }
            }
    }
}
func stateLabel(_ state: String) -> String {
    ["uploading": "等待上传", "queued": "等待识别", "processing": "识别中", "applied": "识别完成", "failed": "识别失败", "expired": "上传已过期", "superseded": "历史结果", "cancelled": "已取消"][state] ?? state
}

struct PhotoDetailView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let photo: HistoryPhoto
    var wholeScan = false
    @State private var confirm = false
    @State private var deleting = false
    @State private var error: String?
    private var current: HistoryPhoto { store.history.first { $0.id == photo.id } ?? photo }
    @State private var removalTarget: Observation?
    @State private var activeVoiceID: String?
    @State private var selectedResult: ItemDetailTarget?
    private var photos: [HistoryPhoto] {
        let entries = wholeScan ? store.history.filter { $0.capture_id == photo.capture_id } : [current]
        return entries.isEmpty ? [photo] : entries
    }
    var body: some View {
        List {
            ForEach(photos) { entry in
                RemotePhoto(path: entry.preview_url, fit: true).frame(maxWidth: .infinity).frame(height: 230).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
                Section {
                    PlaceDescriptionView(place: Place(id: entry.bin_id, name: entry.bin_name), activeVoiceID: $activeVoiceID, prefix: "result.place")
                    Text("\(photoDate(entry.captured_at)) · \(stateLabel(entry.state))").font(.footnote).foregroundStyle(.secondary)
                }
                Section("识别出 \(entry.items.count) 类物品") {
                    ForEach(entry.items) { item in
                        let inventory = InventoryItem(id: item.item_id ?? item.id, name: item.name, description: item.description, aliases: item.aliases, quantity: item.quantity, bin_id: entry.bin_id, bin_name: entry.bin_name, last_seen_at: entry.captured_at, crop_url: item.crop_url, photo_preview_url: entry.preview_url)
                        ItemActionsRow(item: inventory, observationID: item.id, prefix: "result", activeVoiceID: $activeVoiceID, deleting: deleting, onOpen: { selectedResult = ItemDetailTarget(item: $0, observationID: item.id) }) {
                            removalTarget = item; confirm = true
                        }
                    }
                    if entry.items.isEmpty { Text(["queued", "processing", "uploading"].contains(entry.state) ? "处理完成后会自动显示结果。" : "这张照片没有识别结果，可以重新拍摄。").font(.subheadline).foregroundStyle(.secondary) }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            Button(wholeScan ? "删除整次扫描" : "删除这张照片记录", role: .destructive) { removalTarget = nil; confirm = true }.disabled(deleting)
        }.listStyle(.plain).navigationTitle("识别结果").navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $selectedResult) { ItemDetailView(item: $0.item, observationID: $0.observationID) }
            .alert(removalTarget != nil ? "删除识别结果？" : wholeScan ? "删除整次扫描？" : "删除照片记录？", isPresented: $confirm) {
                Button("确认删除", role: .destructive) {
                    deleting = true
                    Task {
                        do {
                            if let result = removalTarget { try await store.deleteObservation(result.id) }
                            else {
                                if wholeScan { try await store.deleteScan(current) } else { try await store.deletePhoto(current) }
                                dismiss()
                            }
                        }
                        catch { self.error = "删除失败，请重试。" }
                        deleting = false
                    }
                }
                Button("保留", role: .cancel) { }
            } message: {
                if let result = removalTarget { Text("删除这次识别中的“\(result.name)”。照片、其他结果和其他扫描中的记录会保留。") }
                else { Text(wholeScan ? "本次扫描的所有照片及其独有识别结果都会删除，其他扫描中的物品会保留。此操作不能撤销。" : "这张照片及其独有识别结果会删除，其他照片中的物品会保留。此操作不能撤销。") }
            }
            .task {
                while !Task.isCancelled && ["uploading", "queued", "processing"].contains(current.state) {
                    await store.refresh(); try? await Task.sleep(for: .seconds(3))
                }
            }
    }
}

struct ConnectionView: View {
    @EnvironmentObject var store: AppStore
    @State private var address = ""
    @State private var busy = false
    @State private var result: String?
    var body: some View {
        Form {
            Section {
                Label(store.connected ? "已连接家庭服务器" : "暂未连接", systemImage: store.connected ? "checkmark.circle.fill" : "wifi.slash").foregroundStyle(store.connected ? .green : .secondary)
                Text("内网共享使用，无需账号和登录。").font(.subheadline).foregroundStyle(.secondary)
            }
            Section {
                TextField("http://192.168.50.84:1453", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(busy ? "正在连接…" : "保存并连接") {
                    busy = true; result = nil
                    Task {
                        do { try await store.connect(to: address); result = "连接成功" }
                        catch { result = error.localizedDescription }
                        busy = false
                    }
                }.disabled(busy || address.isEmpty)
            } header: { Text("服务器地址") } footer: { Text("手机需连接家庭 Wi-Fi。首次使用时，请允许系统的“本地网络”和“相机”权限。离线照片会留在手机，重新打开应用后继续上传。") }
            if let result { Section { Text(result).font(.subheadline) } }
        }.navigationTitle("服务器连接").onAppear { address = store.server }
    }
}

struct PlaceDescriptionView: View {
    @EnvironmentObject var store: AppStore
    let place: Place
    @Binding var activeVoiceID: String?
    var prefix = "place"
    var onSelect: (() -> Void)? = nil
    var managePlaces: (() -> Void)? = nil
    @State private var saving = false
    @State private var error: String?
    private var current: Place { store.places.first { $0.id == place.id } ?? place }
    private var voiceID: String { "place-\(place.id)" }
    private var label: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(current.name, systemImage: "mappin.and.ellipse").font(.body.weight(.medium)).foregroundStyle(.primary)
            if let notes = current.notes, !notes.isEmpty { Text(notes).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if let managePlaces {
                    Menu {
                        ForEach(store.places) { place in
                            Button { store.selectedPlaceID = place.id } label: {
                                if store.selectedPlaceID == place.id { Label(place.name, systemImage: "checkmark") } else { Text(place.name) }
                            }
                        }
                        Divider()
                        Button("添加或管理地点", systemImage: "plus", action: managePlaces)
                    } label: {
                        HStack { label; Image(systemName: "chevron.down").font(.caption) }.padding(12)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    }.accessibilityIdentifier("scan.place")
                } else if let onSelect {
                    Button(action: onSelect) { label }.buttonStyle(.plain).accessibilityIdentifier("\(prefix).select.\(place.id)")
                } else { label }
                Button { error = nil; activeVoiceID = activeVoiceID == voiceID ? nil : voiceID } label: {
                    Group {
                        if saving { ProgressView() }
                        else { Image(systemName: activeVoiceID == voiceID ? "waveform" : "mic.fill").font(.system(size: 23, weight: .semibold)) }
                    }.frame(width: 56, height: 56).background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
                }.buttonStyle(.borderless).disabled(saving)
                    .accessibilityLabel("语音修改位置说明").accessibilityIdentifier("\(prefix).voice.\(place.id)")
            }
            if activeVoiceID == voiceID {
                InlineVoiceInput(hint: "例如：在车库右侧架子的第二层", actionTitle: "更新位置", title: "位置说明", onCancel: { activeVoiceID = nil }) { text in
                    activeVoiceID = nil; saving = true; error = nil
                    Task {
                        defer { saving = false }
                        do { try await store.refinePlace(current, instruction: text) }
                        catch { self.error = error.localizedDescription }
                    }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
}
