// sherlock-ql — show the standard macOS Quick Look panel (the same one
// Finder's spacebar opens) for the files given as arguments.
//
// Why this exists: the only stock CLI route into Quick Look is
// `qlmanage -p`, whose panel carries a "[DEBUG]" title because qlmanage
// is Quick Look's debugging tool. This helper hosts the real shared
// QLPreviewPanel from QuickLookUI instead — no debug chrome, native Esc
// to close, arrow keys between files. It runs as an accessory app (no
// Dock icon, no menu bar takeover) and exits when the panel closes, so
// the TUI's detached spawn-and-forget contract holds unchanged.
//
// Build: `npm run build:quicklook`. swiftc from the Xcode Command Line
// Tools suffices (no Xcode.app); the linker's ad-hoc signature
// satisfies Apple Silicon, and a locally built binary carries no
// quarantine attribute, so Gatekeeper never prompts.

import AppKit
import QuickLookUI

final class PreviewItem: NSObject, QLPreviewItem {
    let previewItemURL: URL!

    init(path: String) {
        self.previewItemURL = URL(fileURLWithPath: path)
    }
}

final class Delegate: NSObject, NSApplicationDelegate, QLPreviewPanelDataSource {
    private let items: [PreviewItem]

    init(paths: [String]) {
        self.items = paths.map { PreviewItem(path: $0) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let panel = QLPreviewPanel.shared() else {
            FileHandle.standardError.write(Data("sherlock-ql: Quick Look panel unavailable\n".utf8))
            NSApp.terminate(nil)
            return
        }
        panel.dataSource = self
        panel.makeKeyAndOrderFront(nil)
    }

    // Esc (or closing the panel any other way) leaves no windows, which
    // ends the process — nothing lingers after the preview is dismissed.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        items.count
    }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        items[index]
    }
}

let paths = Array(CommandLine.arguments.dropFirst())
if paths.isEmpty {
    FileHandle.standardError.write(Data("usage: sherlock-ql <path> [<path> ...]\n".utf8))
    exit(64)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate(paths: paths)
app.delegate = delegate
// Deprecated since macOS 14, but still the working way to make the
// panel key from a background-spawned process; without it, Esc lands in
// the previously focused app instead of closing the panel.
app.activate(ignoringOtherApps: true)
app.run()
