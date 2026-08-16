# NodeCast TV — Android wrapper

A thin native wrapper: one full-screen WebView pointed at your self-hosted
NodeCast TV server. All UI, navigation and D-pad handling is done by the web
app itself (`public/js/dpad.js`); this app does no key/focus handling of its
own. Installs on both Android TV boxes (shows up on the TV home screen /
Leanback launcher) and regular phones/tablets.

## First launch

On first launch (no server URL saved yet) the app shows a setup screen
asking for your server's address, e.g. `http://192.168.1.10` or
`http://192.168.1.10:80`. Bare hosts/IPs are fine — `http://` is added
automatically if you don't type a scheme. To change the server later,
long-press the **Back** button on the remote (or the error screen shown when
a page fails to load has a "Change Server" button).

## Building

This project has no Gradle wrapper jar checked in
(`android/gradle/wrapper/gradle-wrapper.jar` is a binary file and is
intentionally not committed to the repo), so `./gradlew` will **not** work
until it exists. Get it one of two ways:

**Option A — Android Studio (recommended)**

1. Open the `android/` folder in Android Studio (Giraffe or newer).
2. Let it sync; Android Studio generates the wrapper jar automatically.
3. Build > Build Bundle(s) / APK(s) > Build APK(s), or run the `app`
   configuration on a device/emulator.
4. The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk`.

**Option B — command line, with a system-installed Gradle**

```sh
cd android
gradle wrapper --gradle-version 8.7   # generates gradle/wrapper/gradle-wrapper.jar + gradlew
./gradlew assembleDebug
```

You'll also need the Android SDK (compileSdk 34) available, either via
`ANDROID_HOME`/`local.properties`, or by running the build from inside
Android Studio, which manages the SDK for you.

## Installing on a device

**Sideload with adb** (device must have USB/network debugging enabled and be
reachable):

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Sideload with the Downloader app** (easiest for Android TV boxes/sticks
without adb): host `app-debug.apk` on any HTTP server reachable from the TV,
install "Downloader" from the Play/Amazon store on the TV, and enter the
URL to download and install it directly.

## Debugging

The WebView has `setWebContentsDebuggingEnabled(true)`, so with the device
connected via `adb`, open `chrome://inspect` in desktop Chrome to inspect
the page, console, and network requests exactly as if it were a browser tab.

## Notes

- Cleartext (plain HTTP) traffic is allowed to any host
  (`res/xml/network_security_config.xml`) since the server is normally
  reached over LAN HTTP, not HTTPS.
- `minSdk` is 21 (Android 5.0) to cover essentially any Android TV box in
  use; `targetSdk`/`compileSdk` are 34.

## Reproducible container build

No Android SDK needed on the host — only Docker:

```sh
docker volume create nodecast-android-sdk     # Android SDK
docker volume create nodecast-gradle-cache    # Gradle dependency cache
docker volume create nodecast-android-home    # debug keystore, see below

docker run --rm \
  -v "$PWD":/work \
  -v nodecast-android-sdk:/sdk \
  -v nodecast-gradle-cache:/home/gradle/.gradle \
  -v nodecast-android-home:/root/.android \
  -e ANDROID_HOME=/sdk -e ANDROID_SDK_ROOT=/sdk \
  -w /work gradle:8.7-jdk17 \
  gradle --no-daemon assembleDebug
```

The first run also has to install the SDK into the volume (see the
build script in the project history); later runs take well under a
minute.

**Mount `/root/.android`.** That is where the JVM (`user.home` is
`/root` in this image) keeps the auto-generated `debug.keystore`.
Without a volume there, every container signs with a fresh throwaway
key and the next install fails with:

```
INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match
```

which forces an `adb uninstall tv.nodecast.app` before each install.
