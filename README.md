# GatewayBlock — Safari Ad Blocker

A Safari Web Extension that does three things:

1. **YouTube video ads** (the original problem) — a content script watches the
   player, clicks Skip the instant it appears, and fast-forwards unskippable
   ads at 16x while muted. Your real volume/speed settings are restored the
   moment the ad ends. It also removes YouTube's "ad blockers violate..."
   enforcement dialog and resumes playback.
2. **Network-level blocking** — 100 declarative rules blocking the major ad
   networks, trackers, and popup/popunder networks before they even load.
3. **Annoyance cleanup** — a global script that neutralizes popunder click
   hijacking, collapses leftover ad shells, and hides known ad containers
   with CSS on every site.

## Install (Mac, ~5 minutes, free)

Safari extensions must be wrapped in a Mac app. Apple ships a converter
that does this automatically.

1. Install Xcode from the App Store (free) if you don't have it.
2. Open Terminal, cd to wherever you unzipped this folder, and run:

   ```
   xcrun safari-web-extension-converter GatewayBlock --macos-only --app-name GatewayBlock
   ```

3. Xcode opens the generated project. Press **Cmd+R** to build and run it
   once. The wrapper app launches — you can quit it immediately.
4. In Safari: **Settings → Advanced → check "Show features for web
   developers"**. Then allow unsigned extensions — on Safari 17+ (including
   Safari 27) this is a checkbox in the new **Settings → Developer tab →
   "Allow unsigned extensions"** (older Safari: Develop menu → Allow
   Unsigned Extensions). It asks for your Mac password, and resets each
   time Safari fully quits, so re-check it after restarts — or sign the
   app with your free Apple ID in Xcode's Signing & Capabilities tab to
   make it stick.
5. **Safari → Settings → Extensions → enable GatewayBlock**, and grant it
   access ("Always Allow on Every Website") when prompted — it needs page
   access to run the YouTube skipper and annoyance cleanup.

Open a YouTube video. Ads should either skip instantly or flash by in a
fraction of a second, muted.

## iPhone/iPad too?

Re-run the converter without `--macos-only` and it generates an iOS target
as well. You'd deploy it to your phone through Xcode with your Apple ID.

## Maintenance (read this — it matters)

YouTube changes its player markup every few weeks specifically to break
tools like this. When ads start slipping through:

- Open `scripts/youtube-adblock.js` and update the selectors at the top
  (`SKIP_BUTTON_SELECTORS`, `AD_STATE_CLASSES`). Right-click an ad in
  Safari → Inspect Element to find the new class names.
- Rebuild in Xcode (Cmd+R).

Also note YouTube is rolling out **server-side ad insertion** (ads stitched
directly into the video stream). When a video gets SSAI, no client-side
blocker can remove the ad — the 16x fast-forward approach in this script
is the standard mitigation and usually still works, but there will be
videos where an ad plays for a second or two.

## Upgrade ideas

- Per-site on/off toggle in the popup (wire it through browser.storage)
- Auto-updating filter lists: fetch EasyList, convert with AdGuard's
  SafariConverterLib, and swap the JSON rule files on a schedule
- Badge counter showing blocked requests per page

## File map

```
manifest.json                  extension config (MV3)
scripts/youtube-adblock.js     YouTube video ad skipper (the core)
scripts/global-annoyances.js   popunder shield + ad shell cleanup
scripts/background.js          minimal background worker
styles/youtube-hide.css        YouTube static ad hiding
styles/global-hide.css         global cosmetic ad hiding
rules/ad-networks.json         50 network blocking rules
rules/trackers.json            30 tracker blocking rules
rules/popups-annoyances.json   20 popup network rules
popup/                         toolbar popup UI
images/                        icons
```
