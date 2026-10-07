# Packaging StratForge as a Windows installer (.exe)

The desktop app is built with **Tauri 2**, which produces a small, native Windows installer (NSIS `.exe`) wrapping the web UI in a WebView2 window. The icon set and installer metadata are already configured — you just run two commands on a Windows machine.

> **Why on your machine?** Tauri compiles native Rust against the Windows toolchain (MSVC + WebView2). It can't be cross-built from a Linux/cloud sandbox, so the final `.exe` is produced locally. Everything is set up so this is two commands, not a project.

## One-time prerequisites (Windows)

1. **Node 18+** and **pnpm** — `corepack enable` (the repo pins `pnpm@11.5.3`).
2. **Rust** — install from https://rustup.rs (gives you `cargo`; use the default `stable-msvc` toolchain).
3. **Microsoft C++ Build Tools** — the "Desktop development with C++" workload (provides the MSVC linker). https://visualstudio.microsoft.com/visual-cpp-build-tools/
4. **WebView2 runtime** — already present on Windows 10/11. (Otherwise: https://developer.microsoft.com/microsoft-edge/webview2/)

## Build the installer

From the repo root (`D:\Projects\IAQ`):

```bash
pnpm install          # first time only — links the workspace packages
pnpm desktop:build    # builds the web app, compiles Rust, bundles the NSIS installer
```

The first build is slow (Rust compiles from scratch); later builds are fast.

**Output:**

```
apps\desktop\src-tauri\target\release\bundle\nsis\StratForge_0.1.0_x64-setup.exe
```

Double-click it to install. It's a **per-user** install (no admin/UAC prompt), adds a Start-menu entry and the StratForge icon, and launches in a dark-themed native window.

## Run without installing

- **Native window (dev):** `pnpm desktop:dev`
- **Browser (fastest, no Rust needed):** `pnpm dev` → open http://localhost:5173

## Branding / icons

Logo and icons live in `apps/desktop/src-tauri/icons/` (`icon.ico` for Windows, plus PNG sizes and a 1024px `icon.png` master). To regenerate every size from a new source image:

```bash
pnpm --filter @stratforge/desktop tauri icon path\to\your-logo.png
```

Installer metadata (product name, publisher, description, per-user install) is in `apps/desktop/src-tauri/tauri.conf.json` under `bundle`.

## Two honest notes

1. **Unsigned binary → SmartScreen warning.** An unsigned `.exe` will show a "Windows protected your PC" prompt on first run (click *More info → Run anyway*). To remove it for distribution you need a code-signing certificate (OV/EV); add it under `bundle.windows.certificateThumbprint` (or sign the output `.exe` with `signtool`). Fine to skip for personal use.
2. **Pop-out panels in the desktop build.** The multi-monitor pop-out windows use `window.open`, which works in the browser today. In the packaged Tauri app you may need to allow extra webview windows in the Tauri capabilities/config — verify after the first desktop build and adjust `src-tauri/capabilities/default.json` if pop-outs don't open.
