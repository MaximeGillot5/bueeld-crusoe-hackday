# BUEELD Capture for iPhone

The main BUEELD product is the website. This directory contains a reproducible patch for Plaud's official iOS starter, used only to connect the loaned NotePin S, upload its recording with a paired user token, and send the temporary Plaud audio URL to the BUEELD server. The server creates and tracks the transcription task.

The patch targets the public [Plaud SDK repository](https://github.com/Plaud-AI/plaud-sdk-public) at commit `8d7541e503cb96043e8629624aa6cee0241daa03`. Its source is licensed under Apache 2.0 by Plaud; see the upstream `LICENSE` when building the companion.

```sh
git clone https://github.com/Plaud-AI/plaud-sdk-public.git
cd plaud-sdk-public
git checkout 8d7541e503cb96043e8629624aa6cee0241daa03
git apply /absolute/path/to/bueeld-plaud.patch
cd ios
xcodegen generate
open PlaudTemplateApp.xcodeproj
```

For a BLE-only demo build that avoids Apple Hotspot Configuration and Wi-Fi Info entitlements, replace `xcodegen generate` above with `python3 generate-ble-only.py`. The patch adds this generator; the default build retains Plaud fast Wi-Fi transfer.

See [BUEELD-INTEGRATION.md](BUEELD-INTEGRATION.md) for the portal, pairing, and device steps. Keep the Plaud Client Secret and API key on the BUEELD server. The iPhone app obtains its Plaud user token through pairing and contains no static Plaud credentials.
