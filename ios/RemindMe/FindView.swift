import SwiftUI

struct FindView: View {
    @EnvironmentObject var store: AppStore
    @State private var query = ""
    @State private var place = ""
    @State private var results: [InventoryItem] = []
    @State private var loading = false
    @State private var error: String?
    @State private var removalTarget: InventoryItem?
    @State private var voiceSearch = false
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
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { voiceSearch = true } label: { Label("语音搜索", systemImage: "mic.fill") }
                        .accessibilityIdentifier("find.voice")
                }
            }
            .sheet(isPresented: $voiceSearch) {
                VoiceInputSheet(title: "语音搜索", hint: "说出要找的物品，例如“小米摄像头”。", actionTitle: "搜索") { query = $0.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters)) }
            }
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
    @State private var voiceEdit = false
    @State private var refining = false
    @State private var refinementError: String?
    @State private var correctedItem: InventoryItem?
    @State private var didRefine = false
    private var current: InventoryItem {
        if let correctedItem { return correctedItem }
        if let observationID, let record = store.history.flatMap(\.items).first(where: { $0.id == observationID }) {
            return item.corrected(name: record.name, description: record.description, aliases: record.aliases)
        }
        return observationID == nil ? store.items.first(where: { $0.id == item.id }) ?? item : item
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ConnectionNote()
                RemotePhoto(path: current.crop_url ?? current.photo_preview_url, fallback: current.photo_preview_url, fit: true)
                    .frame(maxWidth: .infinity).frame(height: 290).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20)).clipShape(RoundedRectangle(cornerRadius: 20))
                Button { voiceEdit = true } label: {
                    Label(refining ? "正在更新说明…" : "语音补充", systemImage: refining ? "sparkles" : "mic.fill")
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                }.buttonStyle(.borderedProminent).disabled(refining || deleting).accessibilityIdentifier("item.voice")
                if refining { ProgressView("结合照片更新名称和说明…") }
                if let refinementError { Text(refinementError).font(.footnote).foregroundStyle(.red) }
                if didRefine && !refining { Label("名称和说明已更新", systemImage: "checkmark.circle").font(.footnote).foregroundStyle(.green) }
                Text(current.crop_url == nil ? "原照片预览" : "物品裁剪照片").font(.caption).foregroundStyle(.secondary)
                Label(current.bin_name, systemImage: "mappin.and.ellipse").font(.title3.weight(.semibold))
                Text("最后看到：\(photoDate(current.last_seen_at))").font(.subheadline).foregroundStyle(.secondary)
                Text(current.quantity.map { "数量：\($0)" } ?? "数量未知").font(.subheadline)
                if !current.description.isEmpty { Text(current.description).lineSpacing(5) }
                if !current.aliases.isEmpty { Text(current.aliases.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary) }
                Text("后续照片里没出现，也会保留这里的最后记录。").font(.footnote).foregroundStyle(.secondary)
                if canDelete {
                    Button(observationID == nil ? "删除物品" : "删除识别结果", role: .destructive) { confirmDeletion = true }
                        .frame(maxWidth: .infinity).padding(.vertical).disabled(deleting || refining)
                }
            }.padding(20)
        }.navigationTitle(current.name).navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $voiceEdit) {
                VoiceInputSheet(title: "语音补充", hint: "说出这件物品是什么，或哪里需要改。例如“这是小米室外的摄像头”。", actionTitle: "更新说明") { text in
                    refining = true; refinementError = nil; didRefine = false
                    Task {
                        defer { refining = false }
                        do { correctedItem = try await store.refine(current, observationID: observationID, instruction: text); didRefine = true }
                        catch { refinementError = error.localizedDescription }
                    }
                }
            }
            .alert(observationID == nil ? "删除物品？" : "删除识别结果？", isPresented: $confirmDeletion) {
                Button("确认删除", role: .destructive) {
                    deleting = true
                    Task {
                        defer { deleting = false }
                        if let observationID {
                            do { try await store.deleteObservation(observationID); dismiss() }
                            catch { store.error = "删除失败，识别结果仍保留，请重试。" }
                        } else {
                            await store.deleteItem(current)
                            if store.deletedItemIDs.contains(current.id) { dismiss() }
                        }
                    }
                }
                Button("保留", role: .cancel) { }
            } message: {
                Text(observationID == nil ? "将删除“\(current.name)”，删除后可以撤销。" : "删除这次识别中的“\(current.name)”。照片、其他结果和其他扫描中的记录会保留。")
            }
    }
}
