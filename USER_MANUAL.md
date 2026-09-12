# Google Photos Desktop — Complete User Manual & Reference Guide

**Version**: 1.2.0  
**Target OS**: Windows 10 / Windows 11 (64-bit)  
**Architecture**: 100% Local & Privacy-First (Electron, React 18, TypeScript, WebGPU/WASM Face Recognition)  

---

## Table of Contents

1. [Overview & Core Architecture](#1-overview--core-architecture)
2. [Getting Started & Installation](#2-getting-started--installation)
3. [Library Management & Library Switcher](#3-library-management--library-switcher)
4. [Timeline Gallery & Dynamic Zoom](#4-timeline-gallery--dynamic-zoom)
5. [Fullscreen Photo Lightbox & Photo Editing](#5-fullscreen-photo-lightbox--photo-editing)
6. [AI Face Recognition & People Management](#6-ai-face-recognition--people-management)
   - [Scanning & Face Detection](#scanning--face-detection)
   - [Reset & Rescan (Clean Restart)](#reset--rescan-clean-restart)
   - [Person Renaming & Merging](#person-renaming--merging)
   - [Cover Photo Selection & Active Learning](#cover-photo-selection--active-learning)
7. [Places Interactive Map (OpenStreetMap & Geotagging)](#7-places-interactive-map-openstreetmap--geotagging)
   - [Free Map Tiles (No API Keys Needed)](#free-map-tiles-no-api-keys-needed)
   - [Cluster Location Renaming](#cluster-location-renaming)
   - [Assigning Locations to Unlocated Photos](#assigning-locations-to-unlocated-photos)
8. [Physical Date-Based Photo Organizer](#8-physical-date-based-photo-organizer)
   - [Interactive Split-Pane Review](#interactive-split-pane-review)
   - [Hierarchical Tree View & High-Res Previews](#hierarchical-tree-view--high-res-previews)
   - [Safe Execution (Copy vs. Move)](#safe-execution-copy-vs-move)
9. [AI Duplicate & Burst Shot Cleaner](#9-ai-duplicate--burst-shot-cleaner)
   - [Multi-Criteria Quality Scoring (Sharpness, Eyes, Expression)](#multi-criteria-quality-scoring)
   - [Fullscreen Photo Comparison](#fullscreen-photo-comparison)
   - [Multi-Keep Selection & Safe Trash](#multi-keep-selection--safe-trash)
10. [Virtual Network Storage Mirrors (NAS / SMB / USB)](#10-virtual-network-storage-mirrors-nas--smb--usb)
11. [Background Daemon & Windows Service](#11-background-daemon--windows-service)
12. [Settings, Backup (.ZIP Export) & Recovery](#12-settings-backup-zip-export--recovery)
13. [Error Handling, Crash Recovery & Data Safety](#13-error-handling-crash-recovery--data-safety)
14. [Keyboard Shortcuts Quick Reference](#14-keyboard-shortcuts-quick-reference)

---

## 1. Overview & Core Architecture

**Google Photos Desktop** is a private, standalone desktop alternative to cloud photo services. Unlike commercial cloud platforms, your photos and biometrics **never leave your personal computer**.

### Key Architectural Highlights:
- **Zero Cloud Dependence**: All neural networks, facial recognition models, image decoders, and metadata extractors execute entirely on your device.
- **Hardware Acceleration**: Built with WebGPU and WebGL backends via `@vladmandic/face-api` for fast real-time face detection.
- **Virtual Network Mirroring**: Browse multi-terabyte network shares (NAS/SMB) using lightweight local 500px JPEG thumbnails (~50 KB) without transferring massive original files to your local drive.
- **Non-Destructive Operations**: By default, file organization and duplicate removal operate in non-destructive modes (Copy instead of Move; Recycle Bin trashing instead of permanent deletion).

---

## 2. Getting Started & Installation

### Prerequisites:
- Windows 10 or Windows 11 (64-bit)
- Node.js 18+ (if running from source)

### Running from Source:
```powershell
# 1. Install dependencies
npm install

# 2. Build production assets
npm run build

# 3. Launch application
npm start
```

### Packaging Windows Standalone `.exe`:
```powershell
npx electron-builder --win
```
The resulting installer or portable `.exe` will be located in the `release/` folder.

---

## 3. Library Management & Library Switcher

The application allows you to manage multiple photo collections independently:

### Switching Libraries:
1. In the left sidebar, click the **"Switch"** button inside the **Active Library** card (or click directly on the current library name).
2. The **Library Switcher** modal opens:
   - **Browse New Folder**: Click *Browse* to select any folder or drive on your PC.
   - **Recent Libraries**: Quickly switch back to any previously opened folders with a single click.
   - **Virtual Storage Mirrors**: Access any synced network shares.
3. Upon selecting a new folder, the app automatically indexes photos, reads EXIF metadata, and retains existing facial biometric tags.

---

## 4. Timeline Gallery & Dynamic Zoom

The **Photos** gallery presents your collection in a chronological Google Photos-style layout:

### Timeline & Grouping:
- Photos are partitioned by **Year** and **Month** with sticky date headers.
- Filter tabs allow quick viewing of:
  - **All Photos**: Complete library view.
  - **Portraits**: Only photos containing recognized faces.
  - **No Faces**: Scenery, documents, and object photos.
  - **Favorites**: Starred photos.

### Dynamic Zoom Controls:
- **Zoom Slider**: Located in the top right corner of the gallery. Smoothly resize thumbnails between **Small**, **Medium**, and **Large**.
- **Mouse Wheel Zoom**: Hold <kbd>Ctrl</kbd> and scroll your mouse wheel anywhere in the gallery to zoom dynamically between high-density overviews and large detail thumbnails.

---

## 5. Fullscreen Photo Lightbox & Photo Editing

Clicking any photo thumbnail launches the high-performance **Fullscreen Lightbox**:

### Lightbox Features:
- **Keyboard Navigation**:
  - <kbd>&larr;</kbd> / <kbd>&rarr;</kbd>: Navigate previous / next photo.
  - <kbd>Esc</kbd>: Exit Lightbox.
  - <kbd>I</kbd>: Toggle EXIF specification panel.
  - <kbd>F</kbd>: Toggle Favorite status.
  - <kbd>+</kbd> / <kbd>-</kbd>: Zoom in / zoom out.
- **EXIF Specification Panel**: Inspect camera model, lens, focal length, aperture, ISO, shutter speed, file dimensions, and GPS coordinates.
- **Face Overlays**: Click the **Face Bounding Box** icon to highlight all detected faces in the frame. Click on any face box to reveal that person's name or assign a new identity.

### In-App Photo Editing:
- Click the **Edit** (pencil) icon in the Lightbox toolbar:
  - **Rotate**: Rotate 90°, 180°, or 270°.
  - **Flip**: Flip horizontally.
  - **Safety Guard**: Choose **"Save Copy"** (exports `filename_edited.jpg`) or **"Overwrite"** (automatically creates a non-destructive `filename.jpg.bak` backup).

---

## 6. AI Face Recognition & People Management

### Scanning & Face Detection:
1. Navigate to the **People** tab from the sidebar.
2. Click **Detect Faces**. The background worker uses SSD MobileNet / TinyFaceDetector to detect face boxes, extract 128-dimensional biometric embeddings, and group matching faces into people profiles.
3. Re-running face detection will leverage previously confirmed identities to improve clustering accuracy.

### Reset & Rescan (Clean Restart):
If you want to clear all recognized faces and re-index everything from scratch:
1. In the **People** tab, click the **Reset & Rescan** button (circular arrow icon).
2. Confirm the prompt.
3. The app will:
   - Purge all people profiles and face clusters from the database.
   - Reset `faceScanCompleted = false` across all photos in the library.
   - Automatically restart face detection from photo 1 through photo N.
   - Display a live progress banner (`Photo X of Total`) until all photos are completely rescanned.

### Person Renaming & Merging:
- **Instant Inline Renaming**: Click directly on a person's name or click the **Edit (pencil)** icon. Type the new name and press <kbd>Enter</kbd> (or click the green checkmark). *Typing works immediately without requiring DevTools or F12!*
- **Merge People**: If the same person was split into two cards, click **Merge**, select the matching profiles, and confirm to combine them into a single identity.

### Cover Photo Selection & Active Learning:
- Click the **camera icon** on any person's avatar to pick a specific photo as their profile cover.
- Click **"AI Best Face"** to let the engine pick the clearest, highest-resolution smiling portrait.
- Confirmed faces receive a **2.5× centroid weight bonus**, automatically pulling similar photos of that person into their album.

---

## 7. Places Interactive Map (OpenStreetMap & Geotagging)

The **Places** tab displays an iOS/Apple Photos-style interactive geographic map of your collection:

### Free Map Tiles (No API Keys Needed):
- Powered by **OpenStreetMap** (`tile.openstreetmap.org`) by default.
- 100% free with no account registration or CARTO API key required.
- Toggle between **OpenStreetMap (Free)**, **Satellite**, and **Dark** map layers anytime.

### Bubble Cluster Pins:
- Photos taken in the same geographic region are grouped into custom circular bubble pins featuring the latest photo thumbnail and a photo count badge.
- Clicking a pin opens a floating bottom drawer displaying all photos at that location.

### Cluster Location Renaming:
1. Click any map pin to open the bottom drawer.
2. Click the **Edit (pencil)** icon next to the location name.
3. Enter a custom name (e.g. *"Summer Trip in Goa"*, *"Eiffel Tower, Paris"*) and click the checkmark.
4. All photos in that cluster are instantly updated with the new location label.

### Assigning Locations to Unlocated Photos:
If photos lack EXIF GPS coordinates:
1. In the Places tab, click **"Assign Location (N)"**.
2. Search for any city, landmark, or region using the built-in search bar (e.g. *"Taj Mahal"*, *"London"*).
3. Select the matching location and click **"Apply Location"**.
4. The photos will immediately appear on the map at the chosen coordinates.

---

## 8. Physical Date-Based Photo Organizer

The **Organizer** transforms messy photo dumps into cleanly structured date-based directories:

### Folder Schemes:
- `YYYY/YYYY-MM` (e.g. `2024/2024-08/photo.jpg`) — *Recommended*
- `YYYY/MM - Month Name` (e.g. `2024/08 - August/photo.jpg`)
- `YYYY/YYYY-MM-DD` (e.g. `2024/2024-08-25/photo.jpg`)
- `YYYY/MM/DD` (e.g. `2024/08/25/photo.jpg`)

### Interactive Split-Pane Review:
Before changing any files on disk, click **"Run Dry-Run Analysis"**:
- **Left Pane (Folder Tree)**: Shows the proposed folder hierarchy with expandable Year/Month nodes and photo counts. Clicking any folder filters the review pane.
- **Right Pane (Photo Review Grid)**:
  - Displays genuine photo thumbnails with capture date, file size, and target path.
  - Identifies duplicate files via SHA-256 cryptographic hashing (`SKIP Duplicate`).
  - Click any thumbnail to view a high-resolution preview.
  - Switch between visual **Grid View** and detailed **Table View**.

### Safe Execution:
- **Copy Mode** (*Default*): Duplicates files into the organized structure without touching the originals.
- **Move Mode**: Relocates files to save disk space.
- Click **"Execute Organization"** to start. A real-time progress bar tracks progress.

---

## 9. AI Duplicate & Burst Shot Cleaner

Smartphones frequently take rapid bursts or multiple identical shots of the same scene. The **Duplicate Cleaner** automatically identifies and resolves them:

### Multi-Criteria Quality Scoring:
Every photo in a duplicate cluster is scored from 0 to 100 points:
- **Sharpness & Focus (0–40 pts)**: Penalizes blurry or out-of-focus shots.
- **Facial Expressions (0–25 pts)**: Bonuses for smiling and pleasant expressions.
- **Eye Openness & Gaze (0–10 pts)**: Rewards subjects looking forward with open eyes.
- **Sensor Resolution (0–25 pts)**: Rewards higher megapixel utilization.

### Fullscreen Photo Comparison:
- Click the **Maximize** icon on any candidate photo to open the **Fullscreen Comparison Lightbox**.
- Use <kbd>&larr;</kbd> / <kbd>&rarr;</kbd> arrow keys to switch between photos in the burst.
- View score metrics (Sharpness, Expression, Eyes Open) side-by-side.

### Multi-Keep Selection & Safe Trash:
- **Individual "Keep" Checkmarks**: Check or uncheck any photo to keep as many as you want.
- **Quick Actions**:
  - **"Keep AI Best Only"**: Automatically keeps the single highest-rated shot.
  - **"Keep All Photos"**: Marks all photos in the cluster to be preserved.
- **Safe Trashing**: Clicking *Delete Unselected Photos* moves files to your **Windows Recycle Bin** via `shell.trashItem`. Files can easily be restored if needed.

---

## 10. Virtual Network Storage Mirrors (NAS / SMB / USB)

If you store photos on a network-attached storage (NAS) or large external drive:
1. Go to **Network Mirrors** &rarr; **Add Virtual Storage**.
2. Select your remote network folder.
3. The application generates compressed 500px JPEG thumbnails and `.json` EXIF sidecars in `C:\GPhotos_VirtualMirrors\[StorageName]`.
4. **Benefits**:
   - Browse your entire 500,000+ photo collection offline at lightning speed.
   - When connected to your network, clicking any photo automatically serves the original high-resolution RAW or JPEG file.
   - Clicking **"Open in Explorer"** highlights the original network file directly in Windows File Explorer.

---

## 11. Background Daemon & Windows Service

Continuous background synchronization can be configured in **Settings**:
- **Windows System Service (Recommended)**: 1-click install in Settings. Runs as an autonomous background daemon 24/7 without needing the application window to remain open.
- **System Tray Mode**: Runs inside the Windows system tray when the main window is closed.
- Sync interval is customizable (e.g. every 15, 30, or 60 minutes).

---

## 12. Settings, Backup (.ZIP Export) & Recovery

Protect your library database, tags, face recognitions, and settings:

### Creating a `.ZIP` Backup:
1. Open **Settings** from the sidebar.
2. Under the **Library Backup (.zip)** section, click **"Create Backup (.zip)"**.
3. Choose a destination path (defaults to `gPhotos_Library_Backup_[Date]_[Time].zip`).
4. The engine packages:
   - `library.json`: Full database containing photos, face vectors, and people identities.
   - `settings.json`: Configuration preferences.
   - `backup_manifest.json`: Verification manifest with photo and person counts.
   - `README.txt`: Plain-text restoration instructions.
5. Click **"Show in Explorer"** to view your newly created backup archive on disk.

### Restoring from Backup:
To restore, extract `library.json` from the `.zip` archive into:
`%APPDATA%\gPhotos\library.json`

---

## 13. Error Handling, Crash Recovery & Data Safety

The application is engineered with defensive fault tolerance:
- **React Error Boundary**: If a rendering error occurs in any view or component, the app displays a recovery screen with the exact error details, a **"Try Again"** button, and a **"Reload Application"** button. The application will never crash to a blank screen.
- **IPC Fault Isolation**: All IPC handlers in the Electron main process are guarded with `try / catch` blocks and safe fallback values.
- **Atomic Database Writes**: Library state saves are written to a `.tmp` file and atomically renamed to prevent corruption during sudden power loss or crashes.
- **Process Crash Recovery**: If the Chromium rendering process terminates unexpectedly, a recovery dialog prompts you to instantly reload without losing your configuration.
- **Safe Trashing**: Deletion operations route through the Windows Recycle Bin (`shell.trashItem`) rather than permanent disk deletion.

---

## 14. Keyboard Shortcuts Quick Reference

| Shortcut | Context | Action |
|---|---|---|
| <kbd>&larr;</kbd> / <kbd>&rarr;</kbd> | Lightbox | Navigate previous / next photo |
| <kbd>Esc</kbd> | Lightbox / Modals | Close Lightbox or modal dialog |
| <kbd>I</kbd> | Lightbox | Toggle EXIF specification panel |
| <kbd>F</kbd> | Lightbox | Toggle photo Favorite status |
| <kbd>+</kbd> / <kbd>-</kbd> | Lightbox | Zoom in / Zoom out |
| <kbd>0</kbd> | Lightbox | Reset zoom to fit screen |
| <kbd>Ctrl</kbd> + <kbd>Wheel</kbd> | Gallery | Zoom thumbnail grid density dynamically |
| <kbd>F12</kbd> | Anywhere | Toggle Developer Tools console |
| <kbd>Ctrl</kbd> + <kbd>R</kbd> | Anywhere | Reload application view |
| <kbd>Enter</kbd> | Person Rename | Save edited name |
| <kbd>Esc</kbd> | Person Rename | Cancel name editing |
