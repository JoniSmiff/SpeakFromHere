# Speak From Here

Read a note aloud with the voice already on your device, starting from wherever the cursor is.

Most text-to-speech plugins read a note from the top. This one starts at the cursor, which turns listening into part of editing: fix a paragraph, put the cursor back at its start, and hear just that paragraph again.

Currently in beta.

## Features

- **Start anywhere.** Read from the cursor, from a selection, or from the top of the note.
- **Sentence-level seeking.** Skip back and forward a sentence at a time rather than scrubbing blindly through audio.
- **Pause, edit, resume.** The cursor follows along as it reads, so pausing to change a line and resuming picks up where you were.
- **No account, no API key, no network.** Uses the speech synthesis built into your operating system. Nothing leaves your device.
- **Markdown-aware.** Skips frontmatter, code blocks, comments, and link targets. Reads the text, not the syntax.
- **Keeps going in the background.** Lock the phone or minimise Obsidian and it keeps reading. Pause, resume, and skip from the lock screen or with media keys.
- **Controls where you need them.** Ribbon icons, a floating control bar on mobile, the note's `...` menu, the long-press menu, the lock screen and media keys, and commands you can bind to hotkeys.

## Usage

Put the cursor where you want to start and run **Read note from cursor** — from the ribbon, the command palette, or a hotkey of your choosing.

While it reads:

| Action | Where |
| --- | --- |
| Pause / resume | Floating bar, ribbon, status bar, lock screen, media keys, or command |
| Back one sentence | Floating bar, lock screen (previous track), media keys, or command |
| Skip ahead one sentence | Floating bar, lock screen (next track), media keys, or command |
| Stop | Floating bar, ribbon, or command |

The lock screen controls are the system's own media controls: the lock screen and Control Center on iOS, the media flyout on Windows, Now Playing on macOS. They and the media keys work while Obsidian is in the background.

Select text before starting and it reads only the selection. Long-press a word on mobile and choose **Read from here** to start there.

No hotkeys are assigned by default. Settings → Hotkeys, search for "Speak From Here", and bind what you use.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Voice | System default | Any voice installed on the device |
| Speed | 1.0 | 0.5× to 2.5× |
| Pitch | 1.0 | |
| On-screen controls | Mobile only | The floating control bar |
| Pause and stop in the ribbon | On | Adds two more ribbon icons beside the read icon |
| Controls in the note's menu | On | Adds read, pause, and stop to the `...` menu |
| Move the cursor as it reads | On | Keeps the cursor on the current sentence |
| Read the selection when there is one | On | |
| Keep reading in the background | On | Keeps reading with the phone locked or another app open, and adds play, pause, and skip to the lock screen and media keys. Off: the phone stops reading when Obsidian leaves the screen and picks back up when you return |
| Sentence length limit | 240 characters | Where long sentences split. Shorter chunks seek more precisely but pause more often |

## Platform support

| Platform | Status |
| --- | --- |
| Windows, macOS, Linux | Works, including while Obsidian is minimised |
| iOS, iPadOS | Works |
| Android | **Not supported** |

Android's system WebView does not implement the Web Speech API — `window.speechSynthesis` simply doesn't exist there, so the plugin shows a notice and does nothing. This is a platform limitation, not something the plugin can work around.

Two things to know on iOS:

- **Background reading depends on "Keep reading in the background".** While a note plays, the plugin runs a silent audio loop. That is what lets iOS keep Obsidian awake with the screen locked and show it on the lock screen. Turn the setting off and iOS freezes reading when Obsidian leaves the screen, then picks back up when you return. Swiping Obsidian away in the app switcher stops it either way.
- **Only the pre-installed system voices are reachable.** Downloaded enhanced and premium Siri voices are not exposed to web speech, so it will sound flatter than Siri does elsewhere.

## Installation

### Community plugins

Settings → Community plugins → Browse, search for **Speak From Here**, install, and enable.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/JoniSmiff/SpeakFromHere/releases/latest).
2. Put all three in `YourVault/.obsidian/plugins/speak-from-here/`.
3. Restart Obsidian and enable the plugin in Settings → Community plugins.

Mobile vaults sync plugin folders, so installing on a desktop and enabling "Installed community plugins" in Sync settings on **both** devices will carry it across. Force-quit the mobile app afterwards — Obsidian only scans the plugins folder at launch.

## How it works

The note is split into sentence-sized chunks, each of which remembers its character offset in the real document. Frontmatter, fenced code, block math, and comments are blanked to whitespace first, so offsets stay aligned with what's actually in the editor. Starting from the cursor is then a matter of finding the first chunk that ends past the cursor's offset.

Chunking at the sentence level also sidesteps two platform quirks: Chromium cuts off utterances longer than about fifteen seconds, and WebKit drops an utterance queued in the same tick as a `cancel()`.

## Known limitations

- Reading view is not supported. The plugin needs an editor to read the cursor position from.
- Rewind moves by sentence, not by seconds.
- Pausing mid-sentence on mobile replays that sentence from its start on resume, because WebKit's `pause()` and `resume()` are unreliable in an app WebView.

## License

MIT
