// apple-speech-server: Apple's on-device speech recognition (macOS 26 SpeechAnalyzer) behind a tiny local HTTP
// server, so the Node app can use it like whisper-server or the NeMo server.
//
//   GET  /health     200 once the model for the locale is installed and ready
//   POST /inference  body = float32 PCM, 16 kHz mono  ->  {"text": "..."}
//
//   apple-speech-server --host 127.0.0.1 --port 8090 --locale ro-RO --module dictation|speech [--preset long|short|punct]
//   apple-speech-server --list-locales
//   apple-speech-server --locale ro --file a.wav b.wav [--verbose]     transcribe files and exit (for checks)
//
// Built by `npm run setup -- apple-dictation` (lib/models.js) with swiftc; needs macOS 26 and the Xcode tools.
import AVFoundation
import Foundation
import Network
import Speech

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func argument(_ name: String, _ fallback: String) -> String {
  let a = CommandLine.arguments
  if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
  return fallback
}

@available(macOS 26.0, *)
final class Recognizer: @unchecked Sendable {
  var locale: Locale
  let module: String
  let preset: String
  var format: AVAudioFormat?
  let verbose = CommandLine.arguments.contains("--verbose")

  init(locale: Locale, module: String, preset: String) {
    self.locale = locale
    self.module = module
    self.preset = preset
  }

  static func supportedLocales(_ module: String) async -> [Locale] {
    module == "speech" ? await SpeechTranscriber.supportedLocales : await DictationTranscriber.supportedLocales
  }

  /** --preset: long (DictationTranscriber's long-dictation preset), short, or punct (no preset, punctuation on). */
  func makeModule() -> any SpeechModule {
    if module == "speech" { return SpeechTranscriber(locale: locale, preset: .transcription) }
    switch preset {
    case "short": return DictationTranscriber(locale: locale, preset: .shortDictation)
    case "punct":
      return DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [], attributeOptions: [])
    default: return DictationTranscriber(locale: locale, preset: .longDictation)
    }
  }

  func newAnalyzer(_ m: any SpeechModule) -> SpeechAnalyzer {
    // processLifetime keeps the on-device model loaded between requests instead of reloading it per sentence.
    SpeechAnalyzer(modules: [m], options: SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .processLifetime))
  }

  /** Joins the final results; with --verbose every result (final or not) is logged to stderr. */
  func collect(_ m: any SpeechModule) -> Task<String, Error> {
    let verbose = verbose
    return Task {
      var text = ""
      func take(_ t: AttributedString, _ final: Bool) {
        if verbose { log("  \(final ? "final" : "volatile"): \(String(t.characters))") }
        if final { text += String(t.characters) }
      }
      if let st = m as? SpeechTranscriber {
        for try await r in st.results { take(r.text, r.isFinal) }
      } else if let dt = m as? DictationTranscriber {
        for try await r in dt.results { take(r.text, r.isFinal) }
      }
      return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }

  /** Apple's own file path (AVAudioFile), to check the HTTP/buffer path against. */
  func transcribeFile(_ path: String) async throws -> String {
    let m = makeModule()
    let analyzer = newAnalyzer(m)
    let results = collect(m)
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    return try await results.value
  }

  /** Makes sure the on-device model for the locale is downloaded (Apple manages the files). */
  func prepare() async throws {
    // "ro" -> "ro-RO": an exact match first, else the first locale of the same language.
    let all = await Recognizer.supportedLocales(module)
    let wanted = locale.identifier(.bcp47)
    guard let match = all.first(where: { $0.identifier(.bcp47) == wanted })
      ?? all.first(where: { $0.language.languageCode == locale.language.languageCode }) else {
      throw NSError(domain: "apple-speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Apple's \(module) recognizer does not support \(wanted) on this Mac"])
    }
    locale = match
    let m = makeModule()
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [m]) {
      log("Downloading the on-device model for \(locale.identifier)…")
      try await request.downloadAndInstall()
    }
    format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [m])
  }

  func transcribe(_ samples: [Float]) async throws -> String {
    if samples.isEmpty { return "" }
    let inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(max(samples.count, 1)))!
    inBuf.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { inBuf.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    let buffer = try convert(inBuf, to: format ?? inFormat)

    let m = makeModule()
    let analyzer = newAnalyzer(m)
    let results = collect(m)
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    input.yield(AnalyzerInput(buffer: buffer))
    input.finish()
    try await analyzer.start(inputSequence: stream)
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    return try await results.value
  }

  func convert(_ buf: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    if buf.format == format { return buf }
    guard let converter = AVAudioConverter(from: buf.format, to: format) else { throw NSError(domain: "apple-speech", code: 2) }
    let ratio = format.sampleRate / buf.format.sampleRate
    let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * ratio) + 1024)!
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed { status.pointee = .endOfStream; return nil }
      fed = true
      status.pointee = .haveData
      return buf
    }
    if let error { throw error }
    return out
  }
}

// --- Minimal HTTP/1.1 over Network.framework: one request per connection. ---

final class Server: @unchecked Sendable {
  var ready = false
  var failure: String?
  let handle: @Sendable ([Float]) async throws -> String

  init(handle: @escaping @Sendable ([Float]) async throws -> String) { self.handle = handle }

  func start(host: String, port: UInt16) throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!)
    let listener = try NWListener(using: params)
    listener.newConnectionHandler = { [self] conn in
      conn.start(queue: .global())
      receive(conn, Data())
    }
    listener.start(queue: .global())
    log("listening on http://\(host):\(port)")
  }

  func receive(_ conn: NWConnection, _ data: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [self] chunk, _, done, error in
      var data = data
      if let chunk { data.append(chunk) }
      if let end = data.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: data[..<end.lowerBound], as: UTF8.self)
        let length = head.split(separator: "\r\n").compactMap { line -> Int? in
          let parts = line.split(separator: ":", maxSplits: 1)
          return parts.count == 2 && parts[0].lowercased() == "content-length" ? Int(parts[1].trimmingCharacters(in: .whitespaces)) : nil
        }.first ?? 0
        let body = data[end.upperBound...]
        if body.count >= length {
          respond(conn, head.split(separator: " ").prefix(2).joined(separator: " "), Data(body.prefix(length)))
          return
        }
      }
      if done || error != nil { conn.cancel(); return }
      receive(conn, data)
    }
  }

  func respond(_ conn: NWConnection, _ requestLine: String, _ body: Data) {
    Task {
      var status = 200
      var json: [String: Any]
      switch requestLine {
      case "GET /health":
        if ready { json = ["status": "ok"] } else { status = 503; json = ["error": failure ?? "loading"] }
      case "POST /inference":
        var samples = [Float](repeating: 0, count: body.count / 4)
        _ = samples.withUnsafeMutableBytes { body.copyBytes(to: $0) }
        do { json = ["text": try await handle(samples)] } catch { status = 500; json = ["error": "\(error.localizedDescription)"] }
      default:
        status = 404; json = ["error": "not found"]
      }
      let payload = try! JSONSerialization.data(withJSONObject: json)
      var out = Data("HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n".utf8)
      out.append(payload)
      conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
  }
}

@main
struct Main {
  static func main() async {
    guard #available(macOS 26.0, *) else {
      log("Apple speech recognition needs macOS 26 or newer.")
      exit(2)
    }
    if CommandLine.arguments.contains("--list-locales") {
      let ids = { (ls: [Locale]) in ls.map { $0.identifier(.bcp47) }.sorted().joined(separator: " ") }
      print("speech:", ids(await SpeechTranscriber.supportedLocales))
      print("dictation:", ids(await DictationTranscriber.supportedLocales))
      exit(0)
    }
    let recognizer = Recognizer(locale: Locale(identifier: argument("--locale", "ro-RO")), module: argument("--module", "dictation"),
                                preset: argument("--preset", "long"))
    // --file a.wav b.wav ...: transcribe files with Apple's own file reader, one line per file, then exit.
    if let i = CommandLine.arguments.firstIndex(of: "--file") {
      do {
        try await recognizer.prepare()
        for path in CommandLine.arguments[(i + 1)...] where path.hasSuffix(".wav") {
          let t0 = Date()
          let text = try await recognizer.transcribeFile(path)
          print("\(URL(fileURLWithPath: path).lastPathComponent)\t\(String(format: "%.3f", Date().timeIntervalSince(t0)))s\t\(text)")
        }
        exit(0)
      } catch {
        log("\(error.localizedDescription)")
        exit(1)
      }
    }
    let server = Server { try await recognizer.transcribe($0) }
    do {
      try server.start(host: argument("--host", "127.0.0.1"), port: UInt16(argument("--port", "8090"))!)
      try await recognizer.prepare()
      server.ready = true
      log("ready: \(recognizer.module) \(recognizer.locale.identifier)")
    } catch {
      log("\(error.localizedDescription)")
      exit(1)
    }
    while true { try? await Task.sleep(for: .seconds(3600)) }
  }
}
