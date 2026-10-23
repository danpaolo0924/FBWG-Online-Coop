# Fireboy & Watergirl: The Forest Temple – Online Co-op (source)

Source code for the **FBWG Online Co-op** mod by Prompt|, which lets two players play
*Fireboy & Watergirl in The Forest Temple* (Steam) online: one as Fireboy, one as Watergirl.

This repository contains no game files. The mod changes your own copy of the game.

## What's here

| Path | What it is |
|---|---|
| `src/net.js` | The mod itself (plain JavaScript, loaded by the game). Networking, sync, online menu, co-op saves. |
| `installer/Installer.cs` | The installer/uninstaller (C#, .NET Framework 4, WinForms). |
| `installer/app.manifest`, `installer/icon.ico` | Installer manifest (runs without admin rights) and icon. |
| `installer/README.txt`, `CHANGELOG.txt`, `CREDITS.txt` | Player documentation shipped with the release. |
| `tools/build_installer.ps1` | Compiles the installer. |
| `tools/package.ps1` | Builds the release exe and zips into `dist/`. |
| `tools/make_icon.ps1` | Draws `installer/icon.ico` (only needed if it's missing). |

## What the installer does

1. Finds the game folder through Steam (or the folder you pick).
2. Backs up `resources\app\www\index.html` and `resources\app\main.js` as `*.original`.
3. Adds one `<script src="js/online/net.js">` line to `index.html`, and two small options to `main.js`
   (`backgroundThrottling: false`, plus an optional `--fbwg-profile` test switch).
4. Copies `net.js` to `resources\app\www\js\online\`.

**Uninstall** restores the two original files and removes the mod folder. The installer doesn't
download anything or change anything outside the game folder.

## Building

Needs only Windows (the C# compiler ships with the .NET Framework 4 that comes with Windows 10/11).
No Visual Studio needed.

Build the installer directly:

```
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /win32manifest:installer\app.manifest /win32icon:installer\icon.ico /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:"FBWG Online Co-op Installer.exe" installer\Installer.cs
```

That exe reads the mod from `installer\mod\net.js` next to it, which is how the "folder" release is laid out.

Or build the full release with PowerShell:

```
powershell -ExecutionPolicy Bypass -File tools\package.ps1
```

This creates `dist\FBWG Online Co-op Installer v1.1.exe` (with `net.js` embedded) and both release zips.

## How the mod works (short version)

Both PCs run the full game. Inside a level, the two games exchange only key presses every frame
(lockstep), and the game is made deterministic (virtual clock, seeded random numbers, frame-based
timers). Join codes use WebRTC, introduced through the public PeerJS signalling server. Direct IP
uses TCP. The host picks levels; the joiner sees a read-only copy of the host's map. Co-op progress is
saved as the same file on both PCs in `%LOCALAPPDATA%\FbwgForest\coop_saves`.

## Credits

Fireboy & Watergirl is made by Oslo Albet. This is an unofficial fan mod, not affiliated with or
endorsed by the game's developers.
