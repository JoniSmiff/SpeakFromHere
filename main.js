'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownView,
  Platform,
  setIcon,
} = require('obsidian');

const DEFAULT_SETTINGS = {
  voiceURI: '',
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  maxChunkLength: 240,
  moveCursorWhileReading: true,
  readSelectionIfAny: true,
  showControls: 'mobile', // mobile | always | never
  mediaControls: true,
  ribbonControls: true,
  noteMenuControls: true,
};

/* ------------------------------------------------------------------ */
/* Text preparation                                                    */
/* ------------------------------------------------------------------ */

// Blank out regions we should never speak, replacing them with spaces so that
// every character offset still lines up with the real editor document.
function blankRegion(match) {
  return match.replace(/[^\n]/g, ' ');
}

function maskUnspeakable(text) {
  let out = text;
  const fm = /^---\n[\s\S]*?\n---(\n|$)/.exec(out);
  if (fm && fm.index === 0) {
    out = blankRegion(fm[0]) + out.slice(fm[0].length);
  }
  out = out.replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1.*$/gm, blankRegion); // fenced code
  out = out.replace(/^ {0,3}\$\$[\s\S]*?\$\$/gm, blankRegion);              // block math
  out = out.replace(/%%[\s\S]*?%%/g, blankRegion);                          // obsidian comments
  out = out.replace(/<!--[\s\S]*?-->/g, blankRegion);                       // html comments
  return out;
}

// Turn one raw markdown chunk into something worth hearing.
function toSpeakable(raw) {
  return raw
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^ {0,3}>\s?\[!\w+\][+-]?\s*/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, ' '))
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/==(.*?)==/g, '$1')
    .replace(/\^[a-zA-Z0-9-]+$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split into sentence-sized chunks that remember where they came from.
function segmentText(fullText, from, to, maxLen) {
  const masked = maskUnspeakable(fullText);
  const slice = masked.slice(from, to);
  const segments = [];
  const boundary = /[.!?…:;]["'’”)\]]*\s+|\n+/g;
  let cursor = 0;
  let match;

  const add = (relStart, relEnd) => {
    const spoken = toSpeakable(slice.slice(relStart, relEnd));
    if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) return;
    segments.push({ start: from + relStart, end: from + relEnd, spoken });
  };

  const push = (relStart, relEnd) => {
    let s = relStart;
    while (relEnd - s > maxLen) {
      let cut = slice.lastIndexOf(' ', s + maxLen);
      cut = cut <= s ? s + maxLen : cut + 1;
      add(s, cut);
      s = cut;
    }
    if (relEnd > s) add(s, relEnd);
  };

  while ((match = boundary.exec(slice)) !== null) {
    push(cursor, match.index + match[0].length);
    cursor = match.index + match[0].length;
  }
  push(cursor, slice.length);

  return segments;
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

class Reader {
  constructor(plugin) {
    this.plugin = plugin;
    this.segments = [];
    this.index = 0;
    this.state = 'idle'; // idle | speaking | paused
    this.generation = 0;
    this.keepAlive = null;
    this.editor = null;
  }

  get synth() {
    return window.speechSynthesis;
  }

  start(editor, segments, index) {
    this.stop();
    this.editor = editor;
    this.segments = segments;
    this.index = Math.max(0, Math.min(index, segments.length - 1));
    if (!this.segments.length) {
      new Notice('Nothing to read from here.');
      return;
    }
    this.state = 'speaking';
    this.startKeepAlive();
    this.speakCurrent();
  }

  speakCurrent() {
    const segment = this.segments[this.index];
    if (!segment) return this.stop();

    const utterance = new SpeechSynthesisUtterance(segment.spoken);
    const generation = ++this.generation;
    const settings = this.plugin.settings;

    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;
    const voice = this.plugin.currentVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }

    utterance.onend = () => {
      if (generation !== this.generation || this.state !== 'speaking') return;
      if (this.index + 1 < this.segments.length) {
        this.index += 1;
        this.speakCurrent();
      } else {
        this.stop();
        new Notice('Finished reading.');
      }
    };

    utterance.onerror = (event) => {
      if (generation !== this.generation) return;
      if (event.error === 'interrupted' || event.error === 'canceled') return;
      new Notice(`Speech stopped: ${event.error}`);
      this.stop();
    };

    // iOS drops an utterance that is queued in the same tick as a cancel(),
    // so give WebKit a moment to clear. When nothing is queued we speak
    // immediately, which keeps the first utterance inside the tap handler
    // that iOS requires to unlock speech at all.
    const busy = this.synth.speaking || this.synth.pending;
    if (busy) this.synth.cancel();

    const speakNow = () => {
      if (generation !== this.generation) return;
      this.synth.speak(utterance);
    };
    if (busy && Platform.isIosApp) window.setTimeout(speakNow, 120);
    else speakNow();

    this.markPosition(segment);
    this.plugin.updateStatus();
  }

  toggle() {
    if (this.state === 'speaking') this.pause();
    else if (this.state === 'paused') this.resume();
    else this.plugin.readFromCursor();
  }

  pause() {
    if (this.state !== 'speaking') return;
    this.state = 'paused';
    if (Platform.isDesktopApp) {
      this.synth.pause();
    } else {
      // WebKit's pause()/resume() pair is unreliable in an app webview, so
      // drop the utterance and replay this sentence from the top on resume.
      this.generation += 1;
      this.synth.cancel();
    }
    this.stopKeepAlive();
    this.plugin.updateStatus();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'speaking';
    this.startKeepAlive();
    if (Platform.isDesktopApp && this.synth.paused) {
      this.synth.resume();
      this.plugin.updateStatus();
    } else {
      this.speakCurrent();
    }
  }

  jump(delta) {
    if (this.state === 'idle') return;
    const next = this.index + delta;
    if (next < 0 || next >= this.segments.length) return;
    this.index = next;
    this.state = 'speaking';
    this.startKeepAlive();
    this.speakCurrent();
  }

  stop() {
    this.generation += 1;
    this.state = 'idle';
    this.stopKeepAlive();
    this.synth.cancel();
    this.plugin.updateStatus();
  }

  markPosition(segment) {
    if (!this.plugin.settings.moveCursorWhileReading || !this.editor) return;
    try {
      const pos = this.editor.offsetToPos(segment.start);
      this.editor.setCursor(pos);
      this.editor.scrollIntoView({ from: pos, to: pos }, true);
    } catch (e) {
      // The note may have been closed or edited out from under us.
    }
  }

  // Chromium silently cuts off speech after ~15 seconds unless nudged. The
  // same nudge breaks playback in WebKit, so desktop only.
  startKeepAlive() {
    if (!Platform.isDesktopApp || this.keepAlive) return;
    this.keepAlive = window.setInterval(() => {
      if (this.state === 'speaking' && this.synth.speaking && !this.synth.paused) {
        this.synth.pause();
        this.synth.resume();
      }
    }, 9000);
  }

  stopKeepAlive() {
    if (this.keepAlive) {
      window.clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* On-screen controls                                                  */
/* ------------------------------------------------------------------ */

class Controls {
  constructor(plugin) {
    this.plugin = plugin;
    this.el = null;
  }

  wanted() {
    const mode = this.plugin.settings.showControls;
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return Platform.isMobile;
  }

  build() {
    // activeDocument keeps the bar in the right window when a note is
    // popped out into its own window on desktop.
    const doc = window.activeDocument || document;
    const el = doc.body.createDiv({ cls: 'sfh-controls' });

    const button = (icon, label, action) => {
      const btn = el.createEl('button', { attr: { 'aria-label': label } });
      setIcon(btn, icon);
      // Keep the tap from stealing focus out of the editor.
      btn.addEventListener('pointerdown', (evt) => evt.preventDefault());
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        action();
      });
      return btn;
    };

    button('skip-back', 'Go back one sentence', () => this.plugin.reader.jump(-1));
    this.playBtn = button('pause', 'Pause or resume reading', () => this.plugin.reader.toggle());
    button('skip-forward', 'Skip ahead one sentence', () => this.plugin.reader.jump(1));
    button('square', 'Stop reading', () => this.plugin.reader.stop());
    this.positionEl = el.createSpan({ cls: 'sfh-position' });

    this.el = el;
  }

  update() {
    const reader = this.plugin.reader;
    const active = reader.state !== 'idle' && reader.segments.length > 0;

    if (!active || !this.wanted()) return this.destroy();
    if (!this.el) this.build();

    setIcon(this.playBtn, reader.state === 'paused' ? 'play' : 'pause');
    this.positionEl.setText(`${reader.index + 1}/${reader.segments.length}`);
  }

  destroy() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Media session                                                       */
/* ------------------------------------------------------------------ */

// Thirty seconds of 8 kHz, 8-bit mono silence as a WAV. Chromium treats clips
// of five seconds or less as transient sound effects and won't route media
// keys to them, so this has to be longer than that.
function silentWav(seconds) {
  const rate = 8000;
  const samples = rate * seconds;
  const view = new DataView(new ArrayBuffer(44 + samples));
  const ascii = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);   // fmt chunk size
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, rate, true); // sample rate
  view.setUint32(28, rate, true); // bytes per second
  view.setUint16(32, 1, true);    // block align
  view.setUint16(34, 8, true);    // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  new Uint8Array(view.buffer, 44).fill(128); // 8-bit PCM is unsigned; 128 is zero
  return new Blob([view.buffer], { type: 'audio/wav' });
}

// Speech synthesis alone doesn't count as "playing audio" to the OS, so a
// silent loop plays alongside it. That is what puts the note on the lock
// screen and in the system media controls, routes media keys here while
// Obsidian is unfocused, and on iOS keeps the app awake in the background
// so the next sentence can still be queued.
class MediaSessionBridge {
  constructor(plugin) {
    this.plugin = plugin;
    this.audio = null;
    this.url = null;
    this.title = '';
  }

  get session() {
    return 'mediaSession' in navigator ? navigator.mediaSession : null;
  }

  update() {
    const { reader, settings } = this.plugin;
    if (reader.state === 'idle' || !settings.mediaControls) return this.release();
    if (!this.audio) this.create();

    // The first play() happens inside the tap that started reading, which
    // is the only place iOS lets a media element start.
    const speaking = reader.state === 'speaking';
    if (speaking && this.audio.paused) this.audio.play().catch(() => {});
    if (!speaking && !this.audio.paused) this.audio.pause();

    const session = this.session;
    if (!session) return;
    session.playbackState = speaking ? 'playing' : 'paused';
    if (typeof MediaMetadata !== 'undefined') {
      session.metadata = new MediaMetadata({
        title: this.title,
        artist: `Sentence ${reader.index + 1} of ${reader.segments.length}`,
        album: this.plugin.manifest.name,
      });
    }
  }

  create() {
    if (!this.url) this.url = URL.createObjectURL(silentWav(30));
    const audio = new Audio(this.url);
    audio.loop = true;

    // Something outside the plugin pausing the loop (a phone call, pulled
    // headphones, another app taking over the audio) should pause the
    // reading with it.
    audio.addEventListener('pause', () => {
      if (audio === this.audio && this.plugin.reader.state === 'speaking') {
        this.plugin.reader.pause();
      }
    });

    this.audio = audio;
    const file = this.plugin.app.workspace.getActiveFile();
    this.title = file ? file.basename : 'Note';
    this.setHandlers(true);
  }

  // Let go entirely when reading stops, so media keys go back to whatever
  // was playing before.
  release() {
    if (!this.audio) return;
    const audio = this.audio;
    this.audio = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.setHandlers(false);
    const session = this.session;
    if (session) {
      session.metadata = null;
      session.playbackState = 'none';
    }
  }

  setHandlers(on) {
    const session = this.session;
    if (!session) return;
    const reader = this.plugin.reader;
    const actions = {
      play: () => reader.resume(),
      pause: () => reader.pause(),
      stop: () => reader.stop(),
      previoustrack: () => reader.jump(-1),
      nexttrack: () => reader.jump(1),
    };
    for (const [action, handler] of Object.entries(actions)) {
      try {
        session.setActionHandler(action, on ? handler : null);
      } catch (e) {
        // Not every platform knows every action.
      }
    }
  }

  destroy() {
    this.release();
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

module.exports = class SpeakFromHerePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.reader = new Reader(this);
    this.controls = new Controls(this);
    this.media = new MediaSessionBridge(this);
    this.voices = [];
    this.unloaded = false;

    if (!('speechSynthesis' in window)) {
      new Notice(
        'Speak From Here: this device has no built-in speech synthesis. Android webviews do not provide one.'
      );
      return;
    }

    this.loadVoices();
    this.registerDomEvent(window.speechSynthesis, 'voiceschanged', () => this.loadVoices(0));

    // Custom status bar items do not render on mobile, so the floating
    // controls carry the position readout there instead.
    if (!Platform.isMobile) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass('mod-clickable');
      this.statusEl.onclick = () => this.reader.toggle();
    }

    this.ribbonEls = [];
    this.buildRibbon();

    this.addCommand({
      id: 'read-from-cursor',
      name: 'Read note from cursor',
      editorCallback: () => this.readFromCursor(),
    });
    this.addCommand({
      id: 'read-whole-note',
      name: 'Read whole note',
      editorCallback: () => this.readWholeNote(),
    });
    this.addCommand({
      id: 'toggle-pause',
      name: 'Pause or resume reading',
      callback: () => this.reader.toggle(),
    });
    this.addCommand({
      id: 'stop-reading',
      name: 'Stop reading',
      callback: () => this.reader.stop(),
    });
    this.addCommand({
      id: 'previous-sentence',
      name: 'Go back one sentence',
      callback: () => this.reader.jump(-1),
    });
    this.addCommand({
      id: 'next-sentence',
      name: 'Skip ahead one sentence',
      callback: () => this.reader.jump(1),
    });

    // The note's own menu: the "..." on a tab header, and the same menu
    // reached from the note on mobile.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source) => {
        if (!this.settings.noteMenuControls) return;
        if (source !== 'more-options' && source !== 'tab-header') return;
        if (!file || file.extension !== 'md') return;
        this.addControlItems(menu);
      })
    );

    // Long-pressing a word is the natural way to pick a starting point on a
    // phone, so offer it there too.
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu) => {
        menu.addItem((item) =>
          item
            .setTitle('Read from here')
            .setIcon('audio-lines')
            .onClick(() => this.readFromCursor())
        );
      })
    );

    // Without the media session holding it awake, iOS silences a backgrounded
    // webview. Pausing keeps the position so coming back resumes cleanly
    // instead of stalling mid-note. Desktop keeps speaking when minimised.
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.hidden && Platform.isMobile && !this.settings.mediaControls) {
        this.reader.pause();
      }
    });

    this.addSettingTab(new SpeakFromHereSettingTab(this.app, this));
    this.updateStatus();
  }

  onunload() {
    this.unloaded = true;
    if (this.reader) this.reader.stop();
    if (this.controls) this.controls.destroy();
    if (this.media) this.media.destroy();
  }

  // Ribbon icons are how these reach the menu behind the burger button at the
  // bottom right of Obsidian mobile.
  buildRibbon() {
    this.ribbonEls.forEach((el) => el.remove());
    this.ribbonEls = [];
    this.ribbonPause = null;

    const add = (icon, label, action) => {
      const el = this.addRibbonIcon(icon, label, action);
      this.ribbonEls.push(el);
      return el;
    };

    add('audio-lines', 'Read note from cursor', () => this.readFromCursor());
    if (this.settings.ribbonControls) {
      this.ribbonPause = add('pause', 'Pause or resume reading', () => this.reader.toggle());
      add('square', 'Stop reading', () => this.reader.stop());
    }
  }

  addControlItems(menu) {
    const reading = this.reader.state !== 'idle';
    const paused = this.reader.state === 'paused';

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(reading ? 'Read again from cursor' : 'Read from cursor')
        .setIcon('audio-lines')
        .onClick(() => this.readFromCursor())
    );
    menu.addItem((item) =>
      item
        .setTitle(paused ? 'Resume reading' : 'Pause reading')
        .setIcon(paused ? 'play' : 'pause')
        .setDisabled(!reading)
        .onClick(() => this.reader.toggle())
    );
    menu.addItem((item) =>
      item
        .setTitle('Stop reading')
        .setIcon('square')
        .setDisabled(!reading)
        .onClick(() => this.reader.stop())
    );
  }

  // iOS populates the voice list asynchronously and does not always fire
  // voiceschanged, so poll briefly instead of trusting the first read.
  loadVoices(retries = 8) {
    if (this.unloaded) return;
    this.voices = window.speechSynthesis.getVoices() || [];
    if (!this.voices.length && retries > 0) {
      window.setTimeout(() => this.loadVoices(retries - 1), 300);
    }
  }

  currentVoice() {
    if (!this.settings.voiceURI) return null;
    return this.voices.find((v) => v.voiceURI === this.settings.voiceURI) || null;
  }

  activeEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? view.editor : null;
  }

  readFromCursor() {
    const editor = this.activeEditor();
    if (!editor) return new Notice('Open a note in edit mode first.');

    const text = editor.getValue();
    const max = this.settings.maxChunkLength;

    // A selection is an explicit request: read exactly that, nothing more.
    if (this.settings.readSelectionIfAny && editor.somethingSelected()) {
      const from = editor.posToOffset(editor.getCursor('from'));
      const to = editor.posToOffset(editor.getCursor('to'));
      return this.reader.start(editor, segmentText(text, from, to, max), 0);
    }

    const offset = editor.posToOffset(editor.getCursor());
    const segments = segmentText(text, 0, text.length, max);
    let index = segments.findIndex((s) => s.end > offset);
    if (index === -1) index = segments.length - 1;
    this.reader.start(editor, segments, index);
  }

  readWholeNote() {
    const editor = this.activeEditor();
    if (!editor) return new Notice('Open a note in edit mode first.');
    const text = editor.getValue();
    this.reader.start(editor, segmentText(text, 0, text.length, this.settings.maxChunkLength), 0);
  }

  updateStatus() {
    this.controls.update();
    this.media.update();
    if (this.ribbonPause) {
      const paused = this.reader.state === 'paused';
      setIcon(this.ribbonPause, paused ? 'play' : 'pause');
      this.ribbonPause.setAttr('aria-label', paused ? 'Resume reading' : 'Pause reading');
    }
    if (!this.statusEl) return;
    const { state, index, segments } = this.reader;
    if (state === 'idle' || !segments.length) {
      this.statusEl.setText('');
      return;
    }
    this.statusEl.setText(`${state === 'paused' ? '❙❙' : '▶'} ${index + 1}/${segments.length}`);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class SpeakFromHereSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    this.plugin.loadVoices(0);
    const voices = this.plugin.voices;

    new Setting(containerEl)
      .setName('Voice')
      .setDesc(
        voices.length
          ? 'Voices installed on this device. On iOS, only the pre-installed system voices appear here — downloaded Siri voices are not reachable from a plugin.'
          : 'No voices found yet. Close and reopen settings to check again.'
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'System default');
        voices.forEach((v) => dropdown.addOption(v.voiceURI, `${v.name} (${v.lang})`));
        dropdown.setValue(this.plugin.settings.voiceURI);
        dropdown.onChange(async (value) => {
          this.plugin.settings.voiceURI = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName('Speed').addSlider((slider) =>
      slider
        .setLimits(0.5, 2.5, 0.1)
        .setValue(this.plugin.settings.rate)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.rate = value;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName('Pitch').addSlider((slider) =>
      slider
        .setLimits(0.5, 1.5, 0.1)
        .setValue(this.plugin.settings.pitch)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.pitch = value;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl)
      .setName('On-screen controls')
      .setDesc('A floating bar with back, pause, skip, and stop while a note is playing.')
      .addDropdown((dropdown) => {
        dropdown.addOption('mobile', 'On mobile only');
        dropdown.addOption('always', 'Always');
        dropdown.addOption('never', 'Never');
        dropdown.setValue(this.plugin.settings.showControls);
        dropdown.onChange(async (value) => {
          this.plugin.settings.showControls = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatus();
        });
      });

    new Setting(containerEl)
      .setName('Pause and stop in the ribbon')
      .setDesc(
        'Adds pause and stop next to the read icon. On mobile the ribbon is the menu behind the burger button at the bottom right.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ribbonControls).onChange(async (value) => {
          this.plugin.settings.ribbonControls = value;
          await this.plugin.saveSettings();
          this.plugin.buildRibbon();
          this.plugin.updateStatus();
        })
      );

    new Setting(containerEl)
      .setName("Controls in the note's menu")
      .setDesc('Adds read, pause, and stop to the "..." menu for the current note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.noteMenuControls).onChange(async (value) => {
          this.plugin.settings.noteMenuControls = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Move the cursor as it reads')
      .setDesc('Keeps the cursor on the current sentence, so pausing and resuming picks up where you stopped.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.moveCursorWhileReading).onChange(async (value) => {
          this.plugin.settings.moveCursorWhileReading = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Read the selection when there is one')
      .setDesc('With text selected, read only that text instead of continuing to the end of the note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.readSelectionIfAny).onChange(async (value) => {
          this.plugin.settings.readSelectionIfAny = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Keep reading in the background')
      .setDesc(
        'Keeps reading with the phone locked or another app open, and adds play, pause, and skip to the lock screen and media keys. Turned off, the phone stops reading when Obsidian leaves the screen and picks back up when you return.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.mediaControls).onChange(async (value) => {
          this.plugin.settings.mediaControls = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatus();
        })
      );

    new Setting(containerEl)
      .setName('Sentence length limit')
      .setDesc('Longer sentences split at this many characters. Shorter chunks skip more precisely but pause more often.')
      .addSlider((slider) =>
        slider
          .setLimits(80, 500, 20)
          .setValue(this.plugin.settings.maxChunkLength)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxChunkLength = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
