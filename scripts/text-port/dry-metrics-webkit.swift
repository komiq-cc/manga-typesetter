// System WebKit loads a private local HTML file with COPY font bytes. It
// measures a detached canvas directly and emits the page's raw JSON answer.
// No dev server, collector, user chapter, installed font or app state changes.
import Cocoa
import WebKit

guard CommandLine.arguments.count == 2 else { fputs("usage: dry-metrics-webkit <private-html-file>\n", stderr); exit(64) }
let file = URL(fileURLWithPath: CommandLine.arguments[1])
class Capture: NSObject, WKNavigationDelegate {
  var web: WKWebView!
  func fail(_ message: String) {
    let bytes = try! JSONSerialization.data(withJSONObject: ["complete": false, "errors": [message]])
    print(String(data: bytes, encoding: .utf8)!)
    exit(2)
  }
  func poll() {
    web.evaluateJavaScript("window.__done ? JSON.stringify(window.__out) : null") { value, error in
      if let value = value as? String { print(value); exit(0) }
      if let error = error { self.fail(error.localizedDescription) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.poll() }
    }
  }
  func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) { poll() }
  func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
  func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let rect = NSRect(x: 0, y: 0, width: 400, height: 300)
let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.alphaValue = 0
window.ignoresMouseEvents = true
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let web = WKWebView(frame: rect, configuration: config)
let capture = Capture()
capture.web = web
web.navigationDelegate = capture
window.contentView = web
window.orderFrontRegardless()
web.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { capture.fail("direct metric capture timed out") }
app.run()
