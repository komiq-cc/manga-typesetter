// The editor check's own questions (src/test/editor-check/host.js, `selfCheck`)
// asked of this Mac's system WebKit: a real WKWebView, the engine the Tauri
// app's window is on macOS. scripts/editor-check.mjs drives Chromium, which is
// not what the app runs in; this is the part of it that needs no screenshot
// and no outside pointer - what is near, what takes the pointer, the longest
// side, the mask's hand-over - in the other engine.
//
//   npm run dev -- --port 5201 --strictPort              (in another shell)
//   swiftc scripts/editor-check-webkit.swift -o /tmp/editor-check-webkit
//   /tmp/editor-check-webkit http://127.0.0.1:5201 [width height] > webkit.json
//
// It loads <url>/editor-check.html#self, waits for the page to say it is
// done, and prints what the page found as JSON. Nothing is installed and
// nothing is written; the web view keeps no data (a non-persistent store).
// The window is off every screen and nothing is shown, but the display has to
// be awake and unlocked: otherwise the page is hidden and the run says so.
import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count > 1, let base = URL(string: args[1]) else {
  print("usage: editor-check-webkit <dev server url> [width height]")
  exit(64)
}
let width = args.count > 2 ? Double(args[2])! : 1600
let height = args.count > 3 ? Double(args[3])! : 1000

class Nav: NSObject, WKNavigationDelegate {
  var web: WKWebView!
  var tries = 0
  func poll() {
    tries += 1
    web.evaluateJavaScript("window.__done ? JSON.stringify(window.__out, null, 1) : null") { value, error in
      if let s = value as? String {
        print(s)
        exit(0)
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.poll() }
    }
  }
  // Four minutes for the whole of it: the check opens five chapters and waits
  // on frames. Past that, say how far the page got.
  func giveUp() {
    web.evaluateJavaScript("document.title + ' | ' + location.href + ' | ' + (window.__ec ? 'check loaded' : 'check not loaded')") { value, error in
      let state = (value as? String) ?? error?.localizedDescription ?? "no answer from the page"
      print("{\"error\": \"the page did not finish\", \"state\": \"\(state)\"}")
      exit(2)
    }
  }
  // With the display asleep or the screen locked WebKit calls the page hidden
  // and gives it no animation frames, and the check waits on frames: said at
  // once, not after four minutes.
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    web.evaluateJavaScript("document.hidden") { value, _ in
      if (value as? Bool) == true {
        print("{\"error\": \"the page is hidden (is the display asleep, or the screen locked?): WebKit gives a hidden page no frames\"}")
        exit(4)
      }
      self.poll()
    }
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { print("{\"error\": \"\(error.localizedDescription)\"}"); exit(3) }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { print("{\"error\": \"\(error.localizedDescription)\"}"); exit(3) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let rect = NSRect(x: 0, y: 0, width: width, height: height)
// A real window, placed off every screen: WebKit lays out and runs rendering
// updates (which is when an observer answers) only for a view in a window.
let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let web = WKWebView(frame: rect, configuration: config)
let nav = Nav()
nav.web = web
web.navigationDelegate = nav
window.contentView = web
window.orderFrontRegardless()
var page = URLComponents(url: base.appendingPathComponent("editor-check.html"), resolvingAgainstBaseURL: false)!
page.fragment = "self"
web.load(URLRequest(url: page.url!))
DispatchQueue.main.asyncAfter(deadline: .now() + 240) { nav.giveUp() }
app.run()
