import Foundation
import ImageIO
import UIKit

/// Decode only the pixels the UI needs, including EXIF orientation, never a full source raster.
enum PhotoImages {
    static func decode(_ data: Data, maxPixels: Int) throws -> CGImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixels)
              ] as CFDictionary) else { throw APIError.message("这张照片无法读取。") }
        return image
    }
}

actor PhotoImageLoader {
    static let shared = PhotoImageLoader()
    private let cache = NSCache<NSString, UIImage>()
    private let session: URLSession
    private var memoryObserver: NSObjectProtocol?
    init() {
        cache.totalCostLimit = 24 * 1024 * 1024; cache.countLimit = 80
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpMaximumConnectionsPerHost = 4
        session = URLSession(configuration: config)
        memoryObserver = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil) { _ in
            Task { await PhotoImageLoader.shared.clear() }
        }
    }
    func clear() { cache.removeAllObjects() }
    func image(_ url: URL, maxPixels: Int) async throws -> UIImage {
        let key = "\(url.absoluteString)|\(maxPixels)" as NSString
        if let image = cache.object(forKey: key) { return image }
        let bytes: Data
        if url.isFileURL { bytes = try Data(contentsOf: url, options: .mappedIfSafe) }
        else {
            let (data, response) = try await session.data(from: url)
            guard (200..<300).contains((response as? HTTPURLResponse)?.statusCode ?? 0) else { throw APIError.message("照片暂不可用。") }
            bytes = data
        }
        try Task.checkCancellation()
        if let image = cache.object(forKey: key) { return image }
        let image = try autoreleasepool { UIImage(cgImage: try PhotoImages.decode(bytes, maxPixels: maxPixels)) }
        try Task.checkCancellation()
        if let cg = image.cgImage { cache.setObject(image, forKey: key, cost: cg.bytesPerRow * cg.height) }
        return image
    }
}
