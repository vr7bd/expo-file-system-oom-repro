# expo-file-system: `File.md5` causes OOM & `fetch + writableStream` blocks JS thread

## Summary

Two issues with the modern `expo-file-system` next API:

1. **`File.md5` causes OOM on large files** — The Android native implementation reads the entire file into memory to compute the hash, instead of streaming it in chunks.
2. **`fetch` + `file.writableStream()` blocks the JS thread** — The chunk-by-chunk download loop runs on the JS thread, starving React rendering and causing visible UI jank (e.g. animations freeze).

## Minimal Reproducible Example

This repo was scaffolded with `npx create-expo-app@latest`. The only changes are:

1. `npx expo install expo-file-system`
2. Updated `App.tsx` with 4 download test cases

## Steps to Reproduce

1. Clone this repo
2. `npm install`
3. `npx expo run:android`
4. Test each of the 4 buttons:

| # | Method | MD5 | Expected result |
|---|--------|-----|-----------------|
| 1 | Legacy (`createDownloadResumable`) | No | ✅ Works fine |
| 2 | Legacy (`createDownloadResumable`) | Yes | ❌ OOM crash after download completes, when `file.md5` is accessed |
| 3 | Modern (`fetch` + `writableStream`) | No | ⚠️ Download works but JS thread is blocked — animations freeze |
| 4 | Modern (`fetch` + `writableStream`) | Yes | ❌ JS thread blocked during download, then OOM crash on `file.md5` |

**Platform:** Android (development build)
**Package manager:** npm

## Issue 1: `File.md5` reads entire file into memory

### Expected behavior

`file.md5` should compute the hash by streaming the file in chunks. Memory usage should remain constant regardless of file size.

### Actual behavior

The Android native implementation loads the entire file into a single memory buffer before hashing:

**Android** (`FileSystemFile.kt`):
```kotlin
val md5: String get() {
  val md = MessageDigest.getInstance("MD5")
  file.inputStream().use {
    val digest = md.digest(it.readBytes())  // ← reads entire file into ByteArray
    return digest.toHexString()
  }
}
```

### Suggested fix

Use `MessageDigest.update()` in a loop to stream the hash:

```kotlin
val md5: String get() {
  val md = MessageDigest.getInstance("MD5")
  val buffer = ByteArray(8192)
  file.inputStream().use { stream ->
    var bytesRead: Int
    while (stream.read(buffer).also { bytesRead = it } != -1) {
      md.update(buffer, 0, bytesRead)
    }
  }
  return md.digest().toHexString()
}
```

This keeps peak memory at the buffer size (8 KB) instead of the file size.

## Issue 2: `fetch` + `writableStream()` blocks the JS thread

### Expected behavior

Downloading a large file should not block the JS thread or freeze UI animations.

### Actual behavior

The modern download pattern runs a `while` loop on the JS thread, where each chunk crosses the JS↔native bridge:

```tsx
const writer = file.writableStream().getWriter();
const reader = response.body?.getReader();

while (true) {
  const { done, value } = await reader.read();   // JS thread
  if (done) break;
  await writer.write(value);                      // JS → native bridge
}
```

This keeps the JS thread busy for the entire duration of the download. Any JS-driven animations (e.g. `setInterval`-based text animations, `Animated` API without `useNativeDriver`) will freeze or stutter. This is especially noticeable in dev mode where Hermes runs without optimizations and bridge overhead is amplified.

By contrast, the legacy `createDownloadResumable` runs the entire download natively (OkHttp on Android), leaving the JS thread completely free.

### Impact

There is currently **no modern (non-legacy) API** that can download a large file without either:
- Blocking the JS thread (`fetch` + `writableStream`)
- Lacking abort/cancel support (`File.downloadFileAsync`)

The legacy `createDownloadResumable` remains the only option that is native-streamed, cancellable, and JS-thread-free — but it lives under the `/legacy` import path and will eventually be deprecated. Once it is removed, there will be **no way** to download a large file in `expo-file-system` that:

1. Doesn't block the JS thread
2. Supports aborting/cancellation
3. Doesn't cause OOM

The modern API needs a native-streamed download method with abort support (e.g. an `AbortSignal` option on `File.downloadFileAsync`, or a returned handle with a `.cancel()` method) to replace the legacy `createDownloadResumable` before it can be fully retired.

## Workaround

Use the legacy API:

```tsx
import { createDownloadResumable, cacheDirectory } from 'expo-file-system/legacy';

const downloadResumable = createDownloadResumable(url, cacheDirectory + 'file.apk');
await downloadResumable.downloadAsync();
// Do NOT access file.md5 on large files — it will OOM
```

## Environment

```
expo-env-info 2.0.11 environment info:
  System:
    OS: macOS 15.7.3
    Shell: 5.9 - /bin/zsh
  Binaries:
    Node: 22.15.0 - ~/Library/pnpm/node
    npm: 10.9.2 - ~/Library/pnpm/npm
  Managers:
    CocoaPods: 1.16.2 - /opt/homebrew/bin/pod
  SDKs:
    Android SDK:
      Android NDK: 22.1.7171670
  IDEs:
    Android Studio: 2025.3 AI-253.30387.90.2532.14935130
  npmPackages:
    expo: ~55.0.6 => 55.0.6
    react: 19.2.0 => 19.2.0
    react-native: 0.83.2 => 0.83.2
  Expo Workflow: bare
```

## Expo Doctor Diagnostics

```
npx expo-doctor@latest
Running 17 checks on your project...
16/17 checks passed. 1 checks failed. Possible issues detected:

✖ Check native tooling versions
Your Expo SDK version 55 is not compatible with Xcode 16.4.0. Required Xcode version: >=26.0.0.

1 check failed, indicating possible issues with the project.
```

> Note: The Xcode warning is unrelated — this issue is Android-only and does not require Xcode.
