// Build a macOS-conventional app icon from a square source image.
//
// A raw 1024×1024 PNG is not a macOS icon. The system draws it exactly as
// given, so a full-bleed square renders with hard corners and no breathing
// room — visibly larger and squarer than every icon beside it in the Dock.
//
// Apple's icon grid (Big Sur and later) puts the artwork inside a rounded
// square that occupies 824 of the 1024 canvas, leaving a 100pt margin on each
// side for the shadow and for optical parity with system icons. The corner
// radius is 185.4pt — a little over 22% of the shape's width.
//
// Usage: make-icns <source.png> <output.iconset-dir>

import AppKit
import CoreGraphics
import Foundation

/// Apple's macOS icon grid, expressed against a 1024pt canvas.
private let canvas: CGFloat = 1024
private let shape: CGFloat = 824
private let cornerRadius: CGFloat = 185.4

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write("make-icns: \(message)\n".data(using: .utf8)!)
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    fail("usage: make-icns <source.png> <output-dir>")
}

let sourcePath = arguments[1]
let outputDir = arguments[2]

guard let source = NSImage(contentsOfFile: sourcePath),
      let sourceRef = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    fail("could not read \(sourcePath)")
}

/// Render the source inside the rounded-square grid, on a transparent canvas.
func renderIcon(size: CGFloat) -> CGImage? {
    let scale = size / canvas
    guard let context = CGContext(
        data: nil,
        width: Int(size),
        height: Int(size),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    context.interpolationQuality = .high

    let inset = (canvas - shape) / 2 * scale
    let side = shape * scale
    let rect = CGRect(x: inset, y: inset, width: side, height: side)

    // Clip to the rounded square, so the artwork's own square edges are
    // replaced by the shape every other macOS icon shares.
    let path = CGPath(
        roundedRect: rect,
        cornerWidth: cornerRadius * scale,
        cornerHeight: cornerRadius * scale,
        transform: nil
    )
    context.addPath(path)
    context.clip()

    // The source is drawn to fill the shape. Its own background becomes the
    // icon's fill, which is why the master is a full-bleed square to begin
    // with — the margin is added here rather than being baked into the art.
    context.draw(sourceRef, in: rect)

    return context.makeImage()
}

func write(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path)
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, "public.png" as CFString, 1, nil
    ) else { fail("could not create \(path)") }
    CGImageDestinationAddImage(destination, image, nil)
    if !CGImageDestinationFinalize(destination) {
        fail("could not write \(path)")
    }
}

try? FileManager.default.createDirectory(
    atPath: outputDir, withIntermediateDirectories: true
)

// The sizes `iconutil` expects, each at 1x and 2x.
let sizes: [(name: String, pixels: CGFloat)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

for (name, pixels) in sizes {
    guard let image = renderIcon(size: pixels) else {
        fail("could not render \(name)")
    }
    write(image, to: "\(outputDir)/\(name).png")
}

print("wrote \(sizes.count) images to \(outputDir)")
