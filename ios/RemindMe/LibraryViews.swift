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
                        Button { store.selectedPlaceID = place.id; scan() } label: {
                            HStack { Label(place.name, systemImage: "mappin.and.ellipse"); Spacer(); Image(systemName: "camera").foregroundStyle(.secondary) }
                        }.buttonStyle(.plain)
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
            .confirmationDialog("删除这个地点及其中的物品记录？删除后可撤销。", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                Button("删除地点", role: .destructive) { if let place = deleting { Task { await store.deletePlace(place) } }; deleting = nil }
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
    private var photos: [HistoryPhoto] {
        let entries = wholeScan ? store.history.filter { $0.capture_id == photo.capture_id } : [current]
        return entries.isEmpty ? [photo] : entries
    }
    var body: some View {
        List {
            ForEach(photos) { entry in
                RemotePhoto(path: entry.preview_url, fit: true).frame(maxWidth: .infinity).frame(height: 230).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
                Section {
                    Label(entry.bin_name, systemImage: "mappin.and.ellipse")
                    Text("\(photoDate(entry.captured_at)) · \(stateLabel(entry.state))").font(.footnote).foregroundStyle(.secondary)
                }
                Section("识别出 \(entry.items.count) 类物品") {
                    ForEach(entry.items) { item in
                        let inventory = InventoryItem(id: item.item_id ?? item.id, name: item.name, description: item.description, aliases: item.aliases, quantity: item.quantity, bin_id: entry.bin_id, bin_name: entry.bin_name, last_seen_at: entry.captured_at, crop_url: item.crop_url, photo_preview_url: entry.preview_url)
                        NavigationLink { ItemDetailView(item: inventory, canDelete: false) } label: { ItemRow(item: inventory) }
                    }
                    if entry.items.isEmpty { Text(["queued", "processing", "uploading"].contains(entry.state) ? "处理完成后会自动显示结果。" : "这张照片没有识别结果，可以重新拍摄。").font(.subheadline).foregroundStyle(.secondary) }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            Button(wholeScan ? "删除整次扫描" : "删除这张照片记录", role: .destructive) { confirm = true }.disabled(deleting)
        }.listStyle(.plain).navigationTitle("识别结果").navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(wholeScan ? "删除整次扫描的照片及其独有识别结果？其他扫描中的物品会保留，此操作不能撤销。" : "删除照片及其独有识别结果？其他照片中的物品会保留，此操作不能撤销。", isPresented: $confirm, titleVisibility: .visible) {
                Button(wholeScan ? "删除整次扫描" : "删除照片记录", role: .destructive) {
                    deleting = true
                    Task {
                        do {
                            if wholeScan { try await store.deleteScan(current) } else { try await store.deletePhoto(current) }
                            dismiss()
                        }
                        catch { self.error = "删除失败，请重试。" }
                        deleting = false
                    }
                }
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
