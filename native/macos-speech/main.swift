// clawbot-speech — turn one audio file into text, on this Mac.
//
// WeChat normally transcribes a voice message itself and sends the text along
// with it. When it sends the audio alone, the plugin hands the audio to this
// helper, which runs the system's on-device speech models (Speech framework,
// macOS 26 and later). The audio stays on the Mac, nothing is downloaded, and
// macOS asks for no permission: the models read a file the plugin wrote.
//
//   clawbot-speech status <language>
//   clawbot-speech transcribe <language> <audio file>
//   clawbot-speech install <language>
//
// <language> is a BCP 47 tag (zh-CN, en-US, …). Prints one JSON object and
// exits 0 either way; the caller reads `ok`.
//
// Two models can do the work. SpeechTranscriber is the newer and better one;
// its language pack is a separate download, so it is used only when that pack
// is already on the Mac. DictationTranscriber is the model behind the
// keyboard's dictation, there for every language dictation has been used in.
// `status` and `transcribe` download nothing. `install` asks macOS to fetch
// the newer model's pack for one language — a download from Apple, run only
// when the owner asks for it.

import AVFoundation
import Foundation
import Speech

// Bump when the JSON printed here changes shape or a command is added
// (src/voice.ts reads it). The plugin rebuilds this helper by itself whenever
// the source changes.
let helperProtocol = 2

func emit(_ object: [String: Any]) -> Never {
    var out = object
    out["protocol"] = helperProtocol
    let data = (try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "error": message])
}

/// "ready": the model's files for this language are on the Mac. "download":
/// macOS could fetch them. "unsupported": not for this language or this Mac.
@available(macOS 26.0, *)
func readiness(_ module: any SpeechModule) async -> String {
    let status = await AssetInventory.status(forModules: [module])
    if status == .unsupported { return "unsupported" }
    if status == .installed { return "ready" }
    // "supported" also covers files that are on disk but not yet tied to this
    // program; then there is nothing left to install. Asking is not downloading.
    do {
        let request = try await AssetInventory.assetInstallationRequest(supporting: [module])
        return request == nil ? "ready" : "download"
    } catch {
        return "download"
    }
}

@available(macOS 26.0, *)
struct Engine {
    let name: String
    let locale: Locale
    let module: any SpeechModule
    /// Reads the module's results to the end and joins the finished pieces.
    let collect: @Sendable () async throws -> String
}

@available(macOS 26.0, *)
func speechEngine(_ want: Locale) async -> (engine: Engine?, state: String) {
    guard SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: want) else {
        return (nil, "unsupported")
    }
    let module = SpeechTranscriber(locale: locale, preset: .transcription)
    let state = await readiness(module)
    let engine = Engine(name: "speech", locale: locale, module: module) {
        var text = ""
        for try await result in module.results where result.isFinal {
            text += String(result.text.characters)
        }
        return text
    }
    return (state == "ready" ? engine : nil, state)
}

@available(macOS 26.0, *)
func dictationEngine(_ want: Locale) async -> (engine: Engine?, state: String) {
    guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: want) else {
        return (nil, "unsupported")
    }
    let module = DictationTranscriber(locale: locale, preset: .longDictation)
    let state = await readiness(module)
    let engine = Engine(name: "dictation", locale: locale, module: module) {
        var text = ""
        for try await result in module.results where result.isFinal {
            text += String(result.text.characters)
        }
        return text
    }
    return (state == "ready" ? engine : nil, state)
}

@available(macOS 26.0, *)
func status(_ language: String) async -> Never {
    let want = Locale(identifier: language)
    let speech = await speechEngine(want)
    let dictation = await dictationEngine(want)
    let chosen = speech.engine ?? dictation.engine
    emit([
        "ok": true,
        "language": language,
        "speech": speech.state,
        "dictation": dictation.state,
        "engine": chosen?.name ?? NSNull(),
    ])
}

/// Ask macOS for the newer model's language pack. Returns once it is installed
/// (at once when it already is), then answers like `status`.
@available(macOS 26.0, *)
func install(_ language: String) async -> Never {
    let want = Locale(identifier: language)
    guard SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: want) else {
        fail("unsupported_language", "the newer speech model has no \(language) on this Mac")
    }
    let module = SpeechTranscriber(locale: locale, preset: .transcription)
    do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await request.downloadAndInstall()
        }
    } catch {
        fail("download_failed", "the language pack could not be installed: \(error.localizedDescription)")
    }
    await status(language)
}

@available(macOS 26.0, *)
func transcribe(_ language: String, _ path: String) async -> Never {
    let file: AVAudioFile
    do {
        file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    } catch {
        fail("audio", "could not open the audio file: \(error.localizedDescription)")
    }
    let want = Locale(identifier: language)
    let speech = await speechEngine(want)
    var engine = speech.engine
    var dictationState = "unasked"
    if engine == nil {
        let dictation = await dictationEngine(want)
        dictationState = dictation.state
        engine = dictation.engine
    }
    guard let engine else {
        if speech.state == "unsupported" && dictationState == "unsupported" {
            fail("unsupported_language", "no on-device speech model for \(language) on this Mac")
        }
        fail("model_missing", "the on-device speech model for \(language) is not on this Mac (speech: \(speech.state), dictation: \(dictationState))")
    }
    let started = Date()
    do {
        let analyzer = SpeechAnalyzer(modules: [engine.module])
        async let collected = engine.collect()
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        let text = try await collected
        emit([
            "ok": true,
            "text": text.trimmingCharacters(in: .whitespacesAndNewlines),
            "engine": engine.name,
            "language": engine.locale.identifier(.bcp47),
            "seconds": (Date().timeIntervalSince(started) * 100).rounded() / 100,
        ])
    } catch {
        fail("failed", "transcription failed: \(error.localizedDescription)")
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard #available(macOS 26.0, *) else {
    fail("unsupported_os", "on-device transcription needs macOS 26 or later")
}
switch arguments.first {
case "status" where arguments.count == 2:
    await status(arguments[1])
case "transcribe" where arguments.count == 3:
    await transcribe(arguments[1], arguments[2])
case "install" where arguments.count == 2:
    await install(arguments[1])
default:
    fail("usage", "usage: clawbot-speech status <language> | transcribe <language> <audio file> | install <language>")
}
