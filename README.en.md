# dsh-voice-read

A play button for DeepSeek Harness: every finished assistant reply gets a small `▶` in its action strip. Click it to hear that reply read by the official DeepSeek text-to-speech API. Nothing is read automatically, only the reply you click, and code blocks are skipped.

- Host half: one authenticated exact route, `GET|POST /dsh-voice-read/tts`. It reads the API key per request and forwards to `https://api.deepseek.com/v1/tools/tts`, returning the upstream `audio/wav` bytes.
- Browser half: one button registered into `conversation.chat.assistant-actions` (`id: voice-read`, `order: 20`, after the feedback controls).

![Play button next to a reply](docs/preview.svg)

## Install

1. Open DSH and go to **Plugins** in the left sidebar.
2. Click **Add plugin**, then choose the plugin directory (local checkout) or enter the package name / repository URL (once published).
3. Restart DSH. The row **Voice read** appears under Plugins, and every finished reply gains a `▶`.

For a source checkout, link the directory into the profile instead (`"dsh-voice-read": "link:<plugin dir>"` in `dependencies` plus `dsh-voice-read` in `dsh.profile.bundles`), run `pnpm install --dir <profile dir>`, and restart.

## Configuration

Both knobs are declared in the plugin's Cordis `Config` and live under `config` in `cordis.patch.yml`.

| Key | Default | Meaning |
| --- | --- | --- |
| `voiceId` | `tide` | `tide` (male) or `stella` (female); anything else falls back to `tide` |
| `apiKeyPath` | `~/.dsh/voice/api-key.txt` | Single-line plain-text key file; `~`, `$HOME`, `${HOME}` expand to your home directory |
| `DEEPSEEK_API_KEY` | unset | Used only when the key file is unreadable or empty; the file wins when both exist |

### Switching voice

DSH 0.2.2-rc.5 does not render a form for a plugin's `Config` in the Plugins page (the settings layer exposes only volatile fields, and the Web client has no schema-driven form yet), so edit YAML and restart:

1. Open `<profile dir>/node_modules/dsh-voice-read/cordis.patch.yml` — with a `link:` install this is the plugin's own `cordis.patch.yml`.
2. Set `voiceId: stella` (or `tide`) under `config`.
3. Save and restart DSH.

To keep your edit across upgrades, add an override row to the profile's own `cordis.patch.yml`: a patch with the same `id` and **no `insert`** targets the existing row, and its `config` replaces the whole mapping rather than merging, so restate both keys:

```yaml
- id: dsh-voice-read
  name: dsh-voice-read
  config:
    voiceId: stella
    apiKeyPath: '~/.dsh/voice/api-key.txt'
```

### API key

Single line of plain text starting with `sk-`, no quotes. Default `~/.dsh/voice/api-key.txt` (`%USERPROFILE%\.dsh\voice\api-key.txt` on Windows). It is re-read on every request, never cached, never logged, and only sent to `api.deepseek.com` in the `Authorization` header. Replacing the key needs no restart.

## Cost

DeepSeek bills TTS per character (about 1.5 CNY per 10k characters at the time of writing; check the official price list). One click is capped at 2000 characters, so at most roughly 0.3 CNY per click. Audio stays in a 20-entry in-memory cache, so replaying the same reply costs nothing, and the plugin never sends a TTS request on its own.

## Known limitations

- Only finished replies have the button; streaming replies do not.
- Only visible text is read: collapsed reasoning and `<details>` content are skipped, code blocks are dropped.
- Text is extracted from Chat's DOM (`[data-slot="conversation.chat.node"]`). A future DSH change to that marker turns the button into `⚠` and the selector needs updating.
- Audio for a whole reply is buffered before it reaches the page; there is no streaming playback.
- The audio cache is keyed by text, not by voice: after switching voice, replies already played keep the old voice until the page is refreshed.
- No graphical settings form in this DSH version; configuration is YAML.
- The route requires a logged-in browser session (401 otherwise).

## License

[MIT](LICENSE) © Xia Chanjun
