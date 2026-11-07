import SwiftUI

struct FindView: View {
    @EnvironmentObject var store: AppStore
    @State private var query = ""
    @State private var place = ""
    @State private var results: [InventoryItem] = []
    @State private var loading = false
    @State private var error: String?
    @State private var removalTarget: InventoryItem?
    var body: some View {
        List {
            ConnectionNote().listRowSeparator(.hidden)
            Picker("地点", selection: $place) {
                Text("所有地点").tag("")
                ForEach(store.places) { Text($0.name).tag($0.id) }
            }.accessibilityIdentifier("find.place")
            Section {
                if loading && results.isEmpty { ProgressView("正在查找…") }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                if !loading && results.isEmpty && error == nil {
                    ContentUnavailableView(query.isEmpty ? "还没有物品" : "没有找到", systemImage: "magnifyingglass", description: Text(query.isEmpty ? "去扫描页给物品拍张照。" : "试试其他名称，或切换到所有地点。"))
                }
                ForEach(results.filter { !store.deletedItemIDs.contains($0.id) }) { item in
                    NavigationLink(value: item) { ItemRow(item: item) }
                        .swipeActions(allowsFullSwipe: false) { Button { removalTarget = item } label: { Label("删除", systemImage: "trash") }.tint(.red) }
                        .contextMenu { Button("删除物品", systemImage: "trash", role: .destructive) { removalTarget = item } }
                }
            } header: { Text(query.isEmpty && place.isEmpty ? "最近看到的物品" : "找到 \(results.count) 类物品") }
              footer: { Text("点开看照片与地点 · 左滑可删除\(results.count >= 200 ? " · 当前显示最近 200 条，可输入关键词继续查找" : "")") }
        }.listStyle(.plain).navigationTitle("查找")
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "名称、颜色、用途，例如白色充电线")
            .navigationDestination(for: InventoryItem.self) { ItemDetailView(item: $0) }
            .alert("删除物品？", isPresented: Binding(get: { removalTarget != nil }, set: { if !$0 { removalTarget = nil } }), presenting: removalTarget) { item in
                Button("确认删除", role: .destructive) { Task { await store.deleteItem(item) } }
                Button("保留", role: .cancel) { }
            } message: { item in
                Text("将删除“\(item.name)”，删除后可以撤销。")
            }
            .task(id: "\(query)|\(place)|\(store.revision)") {
                loading = true
                do {
                    try await Task.sleep(for: .milliseconds(query.isEmpty ? 0 : 250))
                    let next = try await store.search(query, place: place)
                    try Task.checkCancellation(); results = next; error = nil; loading = false
                } catch is CancellationError { }
                catch { if !Task.isCancelled { self.error = "查找暂时失败，请下拉刷新后重试。"; loading = false } }
            }
            .refreshable { await store.activate() }
    }
}

struct ItemRow: View {
    let item: InventoryItem
    var body: some View {
        HStack(spacing: 14) {
            RemotePhoto(path: item.crop_url ?? item.photo_preview_url, fallback: item.photo_preview_url).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 6) {
                Text(item.name).font(.body.weight(.medium))
                Label(item.bin_name, systemImage: "mappin.and.ellipse").font(.subheadline).foregroundStyle(.secondary)
                Text(photoDate(item.last_seen_at)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if let quantity = item.quantity { Text("×\(quantity)").font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 8)
    }
}

struct ItemDetailView: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let item: InventoryItem
    var canDelete = true
    var observationID: String? = nil
    @State private var deleting = false
    @State private var confirmDeletion = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ConnectionNote()
                RemotePhoto(path: item.crop_url ?? item.photo_preview_url, fallback: item.photo_preview_url, fit: true)
                    .frame(maxWidth: .infinity).frame(height: 290).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20)).clipShape(RoundedRectangle(cornerRadius: 20))
                Text(item.crop_url == nil ? "原照片预览" : "物品裁剪照片").font(.caption).foregroundStyle(.secondary)
                Label(item.bin_name, systemImage: "mappin.and.ellipse").font(.title3.weight(.semibold))
                Text("最后看到：\(photoDate(item.last_seen_at))").font(.subheadline).foregroundStyle(.secondary)
                Text(item.quantity.map { "数量：\($0)" } ?? "数量未知").font(.subheadline)
                if !item.description.isEmpty { Text(item.description).lineSpacing(5) }
                if !item.aliases.isEmpty { Text(item.aliases.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary) }
                Text("后续照片里没出现，也会保留这里的最后记录。").font(.footnote).foregroundStyle(.secondary)
                if canDelete {
                    Button(observationID == nil ? "删除物品" : "删除识别结果", role: .destructive) { confirmDeletion = true }
                        .frame(maxWidth: .infinity).padding(.vertical).disabled(deleting)
                }
            }.padding(20)
        }.navigationTitle(item.name).navigationBarTitleDisplayMode(.inline)
            .alert(observationID == nil ? "删除物品？" : "删除识别结果？", isPresented: $confirmDeletion) {
                Button("确认删除", role: .destructive) {
                    deleting = true
                    Task {
                        defer { deleting = false }
                        if let observationID {
                            do { try await store.deleteObservation(observationID); dismiss() }
                            catch { store.error = "删除失败，识别结果仍保留，请重试。" }
                        } else {
                            await store.deleteItem(item)
                            if store.deletedItemIDs.contains(item.id) { dismiss() }
                        }
                    }
                }
                Button("保留", role: .cancel) { }
            } message: {
                Text(observationID == nil ? "将删除“\(item.name)”，删除后可以撤销。" : "删除这次识别中的“\(item.name)”。照片、其他结果和其他扫描中的记录会保留。")
            }
    }
}
