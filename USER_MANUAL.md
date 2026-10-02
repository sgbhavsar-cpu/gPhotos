# gPhotos Desktop — Complete User Manual & Reference Guide

**Version**: 2.1.0  
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
15. [Albums & Chapters](#15-albums--chapters)
16. [Smart Flows: Describe a Photo, Automate the Rest](#16-smart-flows-describe-a-photo-automate-the-rest)
    - [Configuring the Local Ollama Engine](#configuring-the-local-ollama-engine)
17. [Create a Video from an Album](#17-create-a-video-from-an-album)
18. [AI Photo Search: "Ask AI"](#18-ai-photo-search-ask-ai)
19. [Auto-Describe & Tag Photos (Background)](#19-auto-describe--tag-photos-background)
20. [Videos in Your Library](#20-videos-in-your-library)

---

## 1. Overview & Core Architecture

**gPhotos Desktop** is a private, standalone desktop alternative to cloud photo services. Unlike commercial cloud platforms, your photos and biometrics **never leave your personal computer**.

### Key Architectural Highlights:
- **Zero Cloud Dependence**: All neural networks, facial recognition models, image decoders, and metadata extractors execute entirely on your device.
- **Main-Process Face Detection**: Runs via ONNX Runtime (SCRFD + ArcFace/MobileFaceNet) in the background service itself, not the browser window — face detection keeps working even while the app window is closed.
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

### Packaging Windows Standalone Installers:
```powershell
npm run dist:win
```
The command builds standard 64-bit Windows executables into the `release/` directory:
- **`gPhotos Desktop-Setup-1.0.0.exe`**: Full Windows NSIS setup wizard with Desktop and Start Menu shortcuts, custom install directory selection, and uninstaller.
- **`gPhotos Desktop-Portable-1.0.0.exe`**: Self-contained single-file portable executable. Runs immediately without installation or admin privileges (ideal for USB drives).

### Mobile Access via Local Web Server:
You can access your complete desktop photo library directly from your mobile phone (iPhone or Android) on your local Wi-Fi:
```powershell
npm run serve:mobile
```
- The server auto-detects your local network IP (e.g. `http://192.168.29.30:5173/`).
- Open this URL in **Safari** (iOS) or **Chrome** (Android).
- **Add to Home Screen**:
  - On **iPhone**: Tap Share button → "Add to Home Screen" to run as a full-screen app.
  - On **Android**: Tap Menu (⋮) → "Install App" or "Add to Home Screen".
- **iPhone HEIC / HEIF Support**: All `.heic` and `.heif` photos from iOS are automatically displayed via real-time embedded EXIF preview extraction.

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

The **Photos** gallery presents your collection in a chronological, zoomable timeline layout:

### Timeline & Grouping:
- Photos are partitioned by **Year** and **Month** with sticky date headers.
- Filter tabs allow quick viewing of:
  - **All Photos**: Complete library view.
  - **Portraits**: Only photos containing recognized faces.
  - **No Faces**: Scenery, documents, and object photos.
  - **Favorites**: Starred photos.

### Filter Chips (top of the gallery):
- **All / Portraits / No Faces**: everything, only photos with detected faces, or only photos without.
- **No Album**: only photos that are **not in any album** yet (a photo in even one album — or in any
  chapter of an album — is left out). It updates live as you add photos to albums, so you can
  work down the list until it is empty. Photos you have hidden stay hidden here too.
- **Hidden (n)**: photos you excluded from the library (shown only when there are some).

### Dynamic Zoom Controls:
- **Zoom Slider**: Located in the top right corner of the gallery. Smoothly resize thumbnails between **Small**, **Medium**, and **Large**.
- **Mouse Wheel Zoom**: Hold <kbd>Ctrl</kbd> and scroll your mouse wheel anywhere in the gallery to zoom dynamically between high-density overviews and large detail thumbnails.

### Toolbar:
The header shows just your library's name (no duplicate badge next to it). **Select**, **Clean
Duplicates**, **Rescan** (network/cloud libraries only) and **Ask AI** are icon-only buttons —
hover any of them for a tooltip explaining what it does. Once you've selected one or more photos
(**Select** mode, or a press-and-drag selection), a selection toolbar appears with **Album**,
**Edit Date/Location** (set one date/time and/or location on every selected photo at once — the
same map picker described above opens from its "Pin on Map" button), and **Delete**.

---

## 5. Fullscreen Photo Lightbox & Photo Editing

Clicking any photo thumbnail launches the high-performance **Fullscreen Lightbox**:

### Lightbox Features:
- **Fit / Fill / 1:1 buttons** (next to the zoom controls at the bottom): **Fit** shows the photo
  shrunk to fit the window, never enlarged (the classic view); **Fill** enlarges it to fill as much of
  the screen as its shape allows (small photos are stretched up, keeping their proportions); **1:1**
  shows it at its real pixel size — drag to pan around. Your choice is remembered and applied to every
  photo you open next.
- **Keyboard Navigation**:
  - <kbd>&larr;</kbd> / <kbd>&rarr;</kbd>: Navigate previous / next photo.
  - <kbd>Esc</kbd>: Exit Lightbox.
  - <kbd>I</kbd>: Toggle EXIF specification panel.
  - <kbd>F</kbd>: Toggle Favorite status.
  - <kbd>+</kbd> / <kbd>-</kbd>: Zoom in / zoom out.
- **EXIF Specification Panel**: Inspect camera model, lens, focal length, aperture, ISO, shutter speed, file dimensions, and GPS coordinates.
- **Face Overlays**: Click the **Face Bounding Box** icon to highlight all detected faces in the frame. Click on any face box to reveal that person's name or assign a new identity.
- **Location editing**: type a place name and press Enter (looked up the same way as Places), or click
  **"Pin on Map"** for the map picker, which now also has a **"Paste a Google Maps link"** box — paste
  a link copied from Google Maps (a full `google.com/maps/...` link, or a share link like
  `maps.app.goo.gl/...`) and it drops the pin at the *exact* coordinates from that link, instead of
  searching OpenStreetMap for a name match. The picker also has its own **Label** field — always
  editable, independent of how the pin got there — so you can give the spot a name you'll actually
  recognise later (e.g. *"Grandma's House"*) rather than whatever the map search returned.
  **"Use This Location" stays disabled until you've named the pin** — an amber-bordered label box
  and a short note tell you a name is still needed — so the spot you just pinned always comes back
  into whichever screen opened the map picker (including the bulk **Edit Date/Location** dialog
  below) instead of silently staying blank there.

### In-App Photo Editing:
- Click the **Edit** (pencil) icon in the Lightbox toolbar:
  - **Rotate**: Rotate 90°, 180°, or 270°.
  - **Flip**: Flip horizontally.
  - **Crop**: click **"Crop"** to drop a handled frame onto the photo (PowerPoint-style) — drag
    **inside** the frame to move the whole thing, or drag any of its 8 corner/edge **handles** to
    resize it, exactly like resizing a picture crop in PowerPoint or Word. There's no more
    click-and-drag-to-draw-a-box step. Click **"Crop"** again to hide the frame without discarding
    it, or **"Clear Crop"** to remove the selection entirely. Only available at 0°/180° rotation —
    save or undo a 90°/270° rotation first.
  - **Safety Guard**: Choose **"Save Copy"** (exports `filename_edited.jpg`) or **"Overwrite"** (automatically creates a non-destructive `filename.jpg.bak` backup).
  - **Requires the full-resolution photo**: the **Edit** button (and, if you're already editing,
    **Save Changes**/**Save Copy**) stay disabled — with a tooltip explaining why — until the
    actual full-resolution photo has finished loading. This matters most for a OneDrive/cloud
    mirror still downloading, or one you've switched to view as its cached offline thumbnail
    (the small cloud icon next to Edit): editing then would otherwise permanently bake in that
    lower-resolution version. HEIC photos are the one exception, since their editor always works
    on the local cached preview by design.
  - **Thumbnails update immediately**: saving (either button) refreshes the photo's thumbnail
    right away everywhere it's shown — the gallery grid, albums, People — instead of only catching
    up the next time thumbnails happen to be rebuilt.

---

## 6. AI Face Recognition & People Management

### Finding Someone Quickly:
Type into the **search box** at the top of the People tab to filter the grid by name as you type.

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
- **Assigning a face to a person** (right-click a face / "Reassign" in the lightbox or People view): type part of a name and press <kbd>Enter</kbd> to assign to the **first matching person** (exact name first, then names starting with what you typed, then names containing it) — or simply **click a person** to assign at once; there is no confirm button. If nobody matches, <kbd>Enter</kbd> creates a new person with that name (a "Create new person" row also appears while you type, in case you want a new one despite a partial match). To move *all* of the current person's photos instead of just this face, tick **Merge the whole person** *before* picking.
- **Merge People**: If the same person was split into two cards, click **Merge**. When the second person isn't already chosen, search for them exactly as when assigning a face: type part of a name and press <kbd>Enter</kbd> to select the first match (or click a person), pick the final name, then press <kbd>Enter</kbd> once more or click **Confirm & Merge**.

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

### Finding a Place Quickly:
Type into the **search box** in the Places header to filter the map down to pins whose city,
country, or custom label matches what you typed — the map automatically flies to the matching
pins. Clear the search to see everything again.

### Bubble Cluster Pins:
- Photos taken in the same geographic region are grouped into custom circular bubble pins featuring the latest photo thumbnail and a photo count badge.
- Clicking a pin opens a floating bottom drawer displaying all photos at that location.

### Cluster Location Renaming:
1. Click any map pin to open the bottom drawer.
2. Click the **Edit (pencil)** icon next to the location name.
3. Enter a custom name (e.g. *"Summer Trip in Goa"*, *"Eiffel Tower, Paris"*) and click the checkmark.
4. All photos in that cluster are instantly updated with the new location label — shown everywhere
   (Places, the "#place" search autocomplete) exactly as typed, with no country automatically
   appended. The city/country already recorded on those photos is kept, just no longer used for the
   displayed name — renaming to "Andaman" shows as "Andaman", not "Andaman, India".

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

If you store photos on a network-attached storage (NAS), remote SMB share, or external hard drive:
1. Go to **Network Storage** &rarr; **Add Virtual Storage**.
2. Select your remote network folder.
3. The engine generates compressed 500px JPEG thumbnails and `.json` EXIF sidecars in `C:\GPhotos_VirtualMirrors\[StorageName]`.
4. **Instant Startup & Non-Blocking First Paint**:
   - The application launches instantly (<10ms) by populating your library from cache.
   - Remote network checks and orphan pruning are deferred to background slices with event loop yields, guaranteeing the first screen renders immediately without frozen windows or white screens.
5. **Live Dual-Stage Progress in Network Storage List**:
   - Both the **left sidebar** and the **Network Storage view** display live real-time progress for each network share:
     - **Stage 1 (Thumbnails)**: Displays live count and progress bar: `Thumbnails: X/Y (Z%)` with active file indicator.
     - **Stage 2 (Face Recognition)**: Displays live AI detection: `Faces: A/B (C%)` with dedicated progress bar.
     - **Stage 3 (Complete)**: Displays `✓ Up to date` badge when all sync and face processing tasks are finished.
6. **Smooth Responsiveness & Non-Blocking Execution**:
   - Background scanning and face detection process in small batches with automated event loop yields (`setTimeout(..., 4ms)`).
   - The user interface remains 100% responsive at 60 FPS at all times—you can browse, zoom, organize, and edit photos without any UI stutter or Windows "Not Responding" prompts.
7. **Apple HEIC / iPhone Live Support**:
   - High-quality unrotated 500px thumbnails are extracted and stored locally for instant timeline browsing.
   - When viewing photos in fullscreen, high-resolution preview extractions are loaded on demand.
8. **Benefits**:
   - Browse your entire 500,000+ photo collection offline at lightning speed.
   - When connected to your network, clicking any photo serves the original high-resolution RAW or JPEG file.
   - Clicking **"Open in Explorer"** highlights the original network file directly in Windows File Explorer.
9. **Rotating a mirrored photo**: the small local thumbnail rotates and updates on screen
   immediately — rotating the full-resolution original (potentially a large file over the network)
   always happens in the background afterward, whether the storage is currently reachable or not,
   so rotating never sits waiting on a slow network write. If the original can't be rotated after a
   few attempts (format not supported, or a persistent write error), you're notified and the
   thumbnail is automatically rotated back to match — so what's on screen never permanently disagrees
   with the actual file.

---

## 11. Background Daemon & Windows Service

Continuous background synchronization can be configured in **Settings**:
- **Windows System Service (Recommended)**: 1-click install in Settings. Runs as an autonomous background daemon 24/7 without needing the application window to remain open.
- **System Tray Mode**: Runs inside the Windows system tray when the main window is closed.
- Sync interval is customizable (e.g. every 15, 30, or 60 minutes).

---

## 12. Settings, Backup (.ZIP Export) & Recovery

**Settings** is organized into top tabs: **General** (background sync, performance throttling),
**Mobile & Sharing** (Wi-Fi/LAN access), **Search with AI** (the cloud provider and the local Ollama
engine), **Duplicates**, **Backup**, and **Logs**. Only one tab's content loads at a time.

Protect your library database, tags, face recognitions, and settings:

### Creating a `.ZIP` Backup:
1. Open **Settings** from the sidebar, then the **Backup** tab.
2. Under **Library Backup (.zip)**, click **"Create Backup (.zip)"**.
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
| <kbd>Esc</kbd> | Anywhere | Goes back exactly one step: closes the Lightbox or a modal if one is open, then clears an AI search filter / open folder / open person profile, then — once there's nothing left to close — returns to the previous **tab** you were actually on (not just back to Photos), repeatable to walk back through your whole navigation history one screen at a time |
| <kbd>I</kbd> | Lightbox | Toggle EXIF specification panel |
| <kbd>F</kbd> | Lightbox | Toggle photo Favorite status |
| <kbd>+</kbd> / <kbd>-</kbd> | Lightbox | Zoom in / Zoom out |
| <kbd>0</kbd> | Lightbox | Reset zoom to fit screen |
| <kbd>Ctrl</kbd> + <kbd>Wheel</kbd> | Gallery | Zoom thumbnail grid density dynamically |
| <kbd>F12</kbd> | Anywhere | Toggle Developer Tools console |
| <kbd>Ctrl</kbd> + <kbd>R</kbd> | Anywhere | Reload application view |
| <kbd>Enter</kbd> | Person Rename | Save edited name |
| <kbd>Esc</kbd> | Person Rename | Cancel name editing |

---

## 15. Albums & Chapters

An album can be split into named **chapters** — e.g. a wedding album into "Day 1 — Ceremony" and
"Day 2 — Reception" — for a large event with several distinct parts. An album with no chapters
looks and behaves exactly as it always has; nothing changes until you add one.

- **Creating a chapter**: open an album &rarr; **"New Chapter"** &rarr; name it. Each chapter
  renders as its own heading with its own photo grid inside the album detail view.
- **Auto-generated chapter cover**: each chapter shows a live collage of up to 4 of its own photos
  next to its title. This is rendered on the fly, not saved as a file — it's never counted as a
  photo, never backed up, and never appears in your main Photos timeline.
- **Rename / reorder / delete**: the pencil icon renames a chapter; the up/down arrows reorder
  chapters; deleting a chapter keeps its photos — they move to the album's "Other Photos" bucket
  instead of being removed.
- **Adding photos asks which chapter**: the "Add Photos" picker shows a chapter dropdown,
  defaulting to whichever chapter you added to most recently.
- **Moving a photo between chapters**: click the small book icon on a photo tile (shown once the
  album has at least one chapter) to reassign it. A photo belongs to one chapter at a time, like a
  folder — moving it into a new chapter removes it from its previous one automatically.
- **"Other Photos" goes away when it's empty**: once every photo has been placed in a named
  chapter, the "Other Photos" section disappears (it comes back automatically if a photo is ever
  sent back to "No chapter" via its move-to-chapter button).
- **Ordering photos inside a chapter**: drag a photo and drop it *onto another photo of the same
  chapter* to place it just before that one. The same drop works across chapters — drop a photo
  onto a specific photo of another chapter and it lands at that exact position there.
- **Selecting photos in an album** works like the main gallery. Every photo has a small circular
  checkmark at its bottom-left: click it to select the photo. To select many at once, **press the mouse
  button on empty space between the photos (or on a photo's checkmark) and drag** — a green box appears and
  every photo it touches is selected; make the box smaller and they drop out again. Hold **Ctrl** (or
  Shift) to add to what is already selected; a press that starts on a checkmark always adds. The box
  scrolls the album by itself when you hold it near the top or bottom edge. Once anything is
  selected, clicking a photo selects / unselects it instead of opening it (**Ctrl-click** does the same at
  any time); click empty space, or the **×** on the selection bar, to clear. Pressing on the photo
  itself still opens it or drags it — only empty space and checkmarks start a selection box.
- **Drag and drop between chapters**: drag a photo (or, if several are selected, **any one of the
  selected photos — they all move together**, shown as a "3 photos" badge) and **as soon as you start
  dragging, every chapter appears as a target in a bar at the top of the photos**, plus "Other Photos (no
  chapter)". Drop on the one you want — no scrolling to find it in a long album. You can still drop
  directly onto a chapter's section, or onto a photo to place it at that exact position. A photo that
  isn't part of the current selection is dragged on its own.
- **Selection bar** (no dragging needed — handy on a touch screen): while photos are selected, a bar
  at the bottom shows how many, with **"Move to chapter…"** (pick a chapter, "No chapter", or **create a
  new chapter that already contains the selected photos**) and a clear button. It works in an album
  that has no chapters yet, too.
- **One-click add from the photo viewer**: in the Lightbox, the quick "Add to Album" buttons show
  "Add to *Album* &rarr; *Chapter*" and add straight into that chapter in one click (the album's
  last-used chapter). A small arrow next to the button opens a picker to choose a different
  chapter, or "No chapter", for that one photo without changing the default for next time.
- **Adding a gallery selection to an album**: select photos in Photos (or Favorites) and click
  **"Add to Album"** — the dialog opens with the search box already focused, listing every album
  with its cover photo and name, exactly like picking a person. Type to filter (matches anywhere in
  the title, not just the start), then press **Enter** to pick the best match, or click any album's
  card. If nothing matches what you typed, Enter (or clicking the dashed "Create new album" row)
  creates a new album with that name.
  - **Then pick a chapter** — picking (or creating) the album moves to a second step listing that
    album's existing chapters, with the same type-to-filter/Enter mechanic. Press **Enter** with
    nothing typed (or click the pinned **"Others"** card) to drop the whole selection into a
    catch-all **"Others"** chapter — created automatically the first time, reused after that — so
    you're never forced to name something just to finish adding photos. Type a chapter's name and
    press Enter to add straight to it, or type a new name to create that chapter instead. A **back
    arrow** returns to album selection without adding anything, and this step appears even for an
    album that has no chapters yet.

Turning an album into a video is covered in §17.

---

## 16. Smart Flows: Describe a Photo, Automate the Rest

Open **Smart Flows** from the sidebar to define rules like *"a screenshot of a Facebook or
LinkedIn post"*, *"a photo of a UPI payment"*, *"a scanned bill"* or *"a visiting card"* — every
matching photo is automatically collected into an album or moved to a folder.

- **Create a flow**: give it a name, a plain-English description of the kind of photo to look for,
  and an action — **Add to album** (name it) or **Move to folder** (you choose the destination
  folder the first time you run it).
- **Consent, once per flow**: checking a photo can send it to a cloud AI provider, so each flow
  needs its checkbox — *"I understand each photo checked by this flow is sent to..."* — ticked
  once before it can run. There's no default-on path.
- **Run now, with a cap**: click **"Run now"** and say how many not-yet-checked photos to send
  this run (default 200, capped to however many are left) — a flow never silently classifies your
  whole library in one go, and a re-run only spends effort on photos it hasn't seen yet. This opens
  a **run window** showing the flow's name and description, its source (whole library or the album
  you picked), a **progress bar**, and a live **detail log** — one line per photo, saying exactly
  what happened to it ("already described", "trying the local Ollama model...", "sending to the
  cloud...", matched/not matched, or the reason it failed). Closing the window does not stop the
  run; it keeps going and the flow's counts update once it finishes.
- **Runs even with no AI configured**: a flow is not blocked from running just because no cloud key
  is set — the shared cache and a local Ollama model (if installed) may already answer some or all
  of the photos for free. Anything that genuinely needs the cloud and isn't configured shows a
  clear error in that photo's own log line (e.g. *"Set a Gemini or OpenAI API key in Smart Flows'
  cloud settings first"*) instead of the whole run being blocked or silently doing nothing.
- **Three passes, cheapest first**: every photo is checked in order —
  1. a **shared local cache** (instant, free) — remembers what any flow has ever found out about
     that photo, including a semantic match against a differently-worded description;
  2. a **local Ollama model**, if one is installed (private, free) — only trusted when it's
     confident; otherwise it falls through to the next step;
  3. your configured **cloud provider** (Gemini or OpenAI, set up under **Settings → Smart Flows:
     Cloud Fallback** — its own, separate settings from AI Search's) — only for whatever the first
     two passes couldn't decide.
- **Run against just one album — or a selection of photos**: the modal's **"Run against"** picker
  (next to the Ollama status line) defaults to the whole library but can be pointed at any one
  album instead — handy for trying a flow's wording on a small, known set of photos before turning
  it loose on everything. The "how many to send" prompt then counts only that scope's
  not-yet-checked photos. There's also a **"Run Smart Flow"** button on the selection bar in the
  main **Photos** gallery and inside an **Album** (select photos as usual — the checkbox, or
  press-and-drag — then the button appears next to the other selection actions): it opens Smart
  Flows with that exact selection already chosen as the scope, so you can run a flow against just
  a handful of photos without leaving the selection you made to get there.
- **AI Info in the photo viewer**: once a photo has been checked by any flow, its info panel gets
  an **"AI Info"** card with its cached caption and tags on an **Overview** tab; if the photo has
  been checked by more than one of your Smart Flows, a second **Smart Flows** tab lists each flow's
  name, whether it matched, and its confidence.

### Smart Flows' Cloud Fallback is configured separately from AI Search

AI Photo Search and Smart Flows are two different features with two different jobs — searching
your existing library conversationally vs. auto-sorting new photos into albums/folders — so they
each get their **own** cloud provider and API key: AI Search under **Settings → AI Search
Assistant**, Smart Flows' cloud fallback under **Settings → Search with AI → Smart Flow
Configuration** (its "Cloud Fallback" section). You can point Search at Gemini and Smart Flows at
OpenAI (or vice versa, or turn either one off and rely on the local model/cache alone) — saving one
never touches the other's key.

### Configuring the Local Ollama Engine

The local pass is entirely optional — everything still works through the cloud provider alone if
you skip this — but it's private, free, and (once installed) makes repeated flows dramatically
cheaper. It's shared by both AI Search and Smart Flows, and configured under **Settings → Search
with AI → Smart Flow Configuration** — Cloud Fallback and the local Ollama model live in that one
section together, Ollama below the cloud provider fields — the same screen on the mobile web view
too:

1. Install [Ollama](https://ollama.com) and make sure it's running.
2. Open **Settings → Smart Flow Configuration**. It lists every model Ollama currently has
   installed, split into a **Vision Model** picker and an **Embedding Model** picker.
3. If nothing suitable is installed yet, a **"Recommended models to download"** list appears with
   a **Download** button per model — this pulls it straight from Ollama, with a live progress bar,
   no terminal needed. `qwen2.5vl:7b` is recommended by default for photo categories with dense
   text to read (payment screenshots, bills, visiting cards); `nomic-embed-text` for the embedding
   model. A smaller/faster vision model can be picked instead, at some cost to accuracy on that
   kind of text-heavy photo.
4. Once a model is installed, select it from the dropdown and click **"Save & Re-check"**. The
   status line above (also shown in Smart Flows itself) turns green once it's detected.
5. If a download or the model list fails, the reason is shown right under the status line (for
   example "Could not connect to Ollama — is it running?") and in the error message, so you can see
   what to fix. Model listing and downloads are done by the desktop app itself, so they only work in
   the desktop app — not from the phone/browser view.
6. A custom **Ollama Host** field is also available, if Ollama is running somewhere other than the
   default `http://127.0.0.1:11434` (e.g. a different machine on your network), next to a
   **Context Window (tokens)** field — see below.

**Batch size adjusts itself to your context window**: Ollama has no API that reports back what
context length (`num_ctx` / `OLLAMA_CONTEXT_LENGTH`) you've actually set a running model to use, so
the **Context Window** field in Settings is where you tell gPhotos what you configured in Ollama
(default 4096, matching Ollama's own out-of-the-box default). Before each local run, gPhotos also
asks Ollama for that model's own maximum architectural context (via `/api/show`) and uses whichever
is smaller, so a typo or a too-high number here can never overrun what the model itself supports.
That effective context is then converted into a batch size — each photo's 512px thumbnail costs
roughly 360 tokens of context, so a bigger window means more photos per call (and fewer, faster
round-trips), capped at 20 photos per call for reliability. The run window's log shows the exact
numbers it resolved to at the top of every run (e.g. *"Local model context: 32768 tokens — sending
up to 20 photos per call"*). **If you've set Ollama's own context window to 32768** (or raised the
`OLLAMA_CONTEXT_LENGTH` environment variable), set this field to match — otherwise gPhotos will
assume the 4096-token default and batch far more conservatively than your setup actually allows.

---

## 17. Create a Video from an Album

Open an album and click **"Create Video"** in its header to turn its photos into a real MP4
slideshow — rendered with a bundled FFmpeg (no separate install needed), suitable for posting to
social media. A 6-step wizard:

1. **Group Photos** — every photo in the album is shown **under its chapter heading, in the same
   order as the album** (chapters in order, then any photos in no chapter). Select 2-4 photos and
   click **"Group as Collage"**: a popup then shows the collage in every available **style** —
   *Grid*, *Side by Side*, *Stacked* and *Featured* (one big photo with the rest in a strip) — drawn
   from your own photos, so you can pick the look you want. A grouped collage can be **ungrouped**
   again from the same step.
2. **Arrange Slides** — every resulting slide (individual photos and any collages) is listed in
   order. **Drag** a row (via its handle) to reorder it, or use the **up/down arrows**; uncheck a
   slide to leave it out of the video without deleting anything from the album.
3. **Video Settings** — aspect ratio (16:9 landscape/YouTube, 9:16 reels/stories, 1:1 square, 4:3),
   resolution (720p/1080p), quality/generation speed (draft = fastest, good, best = slowest/
   sharpest), the **transition effect** — *one effect for every cut* (fade, dissolve, wipes, slides,
   circle open, or none for hard cuts), *random* (a different effect on each cut), or *pick several*
   (tick the effects you like; each cut uses a random one of those) — and its duration, either a
   fixed number of seconds per photo or a target total video length (the other is calculated for
   you, with a live estimate shown), and **where to save** the `.mp4`: by default this is already filled in
   as `<your library folder>\videos\<album name>.mp4` (the `videos` folder is created for you);
   click **"Change Location"** to pick somewhere else.
4. **Music** *(optional)* — put a song under the video. The step opens on the **Free music
   library**: 20 royalty-free tracks by Kevin MacLeod (incompetech.com), each listed with **cover
   art, title, artist, mood and length**. Use the mood buttons (*Upbeat, Relaxed, Emotional,
   Cinematic, Playful, Acoustic*) to narrow the list, press **Preview** to hear a track, or **Use** to
   pick it. A track is downloaded (about 8 MB) the first time you preview or use it and kept for
   next time — the list marks the ones already downloaded. The tracks are licensed *Creative Commons
   Attribution 4.0*, which requires a credit: choosing one **turns on the end-credits screen and adds
   the credit line to it automatically** (you can restyle it in the designer; the credits tab warns
   you if you switch it off). Alternatively **choose an audio file** from your
   computer (mp3, m4a, wav, flac, ogg, …) or use the **From YouTube** tab: paste a video link and
   click **Download audio**. YouTube downloads use **yt-dlp**, a free open-source tool
   (github.com/yt-dlp/yt-dlp) that is *not* bundled — the first time, click **Install yt-dlp**
   (about 18 MB, fetched from its official GitHub release and verified against the release's
   published checksum; a yt-dlp already on your PATH is used if there is one). Once you have a song:
   set **Start at** / **End at** (`m:ss`; leave *End at* empty to use the rest of the song) to pick the
   part you want, tick **Repeat to fill the whole video** to loop that part until the video ends (a
   line under the settings tells you how many times it repeats), choose a **fade-out** and
   **volume**, and press **Preview this section** to hear exactly that part. Music longer than the
   video is cut where the video ends. Only use music you have the right to use.
5. **Title & Credits** *(both optional)* — a small designer for the opening **title screen** and,
   on its second tab, a closing **end-credits screen** (the same designer for both). The preview is
   drawn at your video's **exact size** (e.g. 1080×1920 for 9:16), and text is automatically wrapped
   and, if needed, shrunk so it can **never run off the screen** — including on vertical video.
   You can: pick the **background** — a gradient, a solid colour, or **one of the album's photos**
   (with a *Darken* slider so the text stays readable); **add, edit and remove text lines**, each with
   its own **font**, **size**, **colour**, bold / italic, left-centre-right alignment, shadow, and
   position (drag it on the preview, or use the Across / Down sliders); set how many seconds the
   screen stays up; and **Reset design** to start over. Sizes are a percentage of the screen's
   shorter side, so the look is the same at 720p and 1080p. The title starts as the album's name
   and year; the credits start as "Thank you for watching" with the album name.
6. **Review & Generate** — a summary of the plan, then **"Generate Video"** with a live progress
   bar (preparing slides, then encoding) and a **Cancel** button. When it finishes, the video
   **opens automatically in your default video player**; "Open Video" and "Show in Folder" buttons
   are also there if you need them again. A photo that couldn't be read (unsupported format,
   missing file) is skipped and reported rather than failing the whole video.

Not built yet: Ken Burns-style pan/zoom on individual photos.

---

## 18. AI Photo Search: "Ask AI"

Click **"Ask AI"** (Photos gallery toolbar) to open a chat box for finding photos with a plain-English
question — "Photo of sachin and monika", "Photos of sachin in andaman", "Photo of monika alone" — answered
by whichever provider is configured under **Settings → Search with AI**. A match applies as a filter on
the main gallery.

- **Several people together**: "Photo of stavan and stuti" finds photos with both of them in it
  (and possibly others too).
- **Only these people, nobody else**: add **"only"** — "Photo of stavan and stuti only" finds photos
  where it's just the two of them, excluding any photo where a third person also appears. "Only photo
  of monika" (one name) works the same way as "photo of monika alone".
- **Excluding someone**: add **"but not NAME"** (also works as "except NAME" / "without NAME") at the
  end — "Photo of monika but not raji" finds monika's photos with raji nowhere in them.
- **Combine with a place or tag**: these all stack with a location or Smart Flow tag in the same
  question — "Only photo of monika at #andaman" finds just-monika photos taken in Andaman.

- **@mention people, #mention places, &mention Smart Flow tags**: type **@** to get a dropdown of the
  people in your library, **#** for places (from your Places map), or **&** for content **tags** —
  the captions/tags Smart Flows has already recorded about your photos (e.g. "receipt", "screenshot",
  "visiting-card") — no need to spell any of them exactly. The list **matches anywhere in the name**,
  not just the start: typing `@bhavsar` finds both "Sachin Bhavsar" and "Bhavsar Tarun". Keep typing to
  narrow it, use **↑/↓** and **Enter** (or click) to pick one, or **Esc** to dismiss the list without
  picking anything. Picking an entry drops its plain text into your question in place of what you
  typed — the sentence still reads naturally, e.g. "Photo of Sachin Bhavsar in Udaipur tagged receipt".
  People not yet given a real name (shown as "Person 12" etc. until you name them) aren't offered,
  since there's nothing meaningful to search by yet. A place picked this way is matched against your
  photos' actual city and country, even when the entry is a combined "City, Country" name — picking
  "Udaipur, India" finds every photo taken in Udaipur, specifically — never every photo in the
  country just because the country happens to be part of the name, even for a place the app saw
  mentioned in other photos' data first. A tag only ever lists what at least one Smart
  Flow run has actually found — if the list is empty, run a Smart Flow against your photos first (see
  [§16](#16-smart-flows-describe-a-photo-automate-the-rest)); those tags are stored durably per photo
  in the library's own database (not just kept in memory), shared across every Smart Flow and by this
  search, so they survive a restart and don't need re-analysing. A tagged search only matches photos a
  Smart Flow has actually analysed — one never checked by any flow won't match even if it probably
  would qualify.

## 19. Auto-Describe & Tag Photos (Background)

**Settings → Search with AI → "Auto-describe & tag photos in the background"** — off by default. When
turned on, gPhotos quietly captions and tags every photo in the open library using your local
**Ollama** model (the same one configured just above it for Smart Flows), without you running a Smart
Flow against them yourself. It never uses a cloud provider for this, even if one is configured — this
background pass only ever uses the local model, so nothing leaves your machine.

- Runs in small batches while the app is open and idle, pausing automatically if Ollama isn't
  reachable and resuming once it is.
- Backs off while you're running a Smart Flow manually, so the two never compete for the same model
  at once.
- Picks up exactly where it left off after a restart — a photo already captioned (by this feature or
  by any Smart Flow) is never re-sent.
- The payoff: **"&tag"** autocomplete in [Ask AI](#18-ai-photo-search-ask-ai) fills in for your whole
  library over time, not just the photos you've manually run a Smart Flow against.
- The status line under the toggle shows live progress ("Indexing — 120 / 5,000 photos this pass") or
  why it's idle (waiting for Ollama, or already up to date).

## 20. Videos in Your Library

Video files in a scanned folder (`.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`, `.wmv`, `.m4v`) show up in
the gallery right alongside your photos — same grid, same albums, same favorites.

- Each video tile shows a small play-icon badge with its length.
- **Hover** over a video tile for about two seconds and a short silent preview clip plays right in the
  tile — move the mouse away and it reverts to the still thumbnail. The very first hover on a given
  video generates that preview (a second or two); every hover after that is instant.
- **Click** a video to open it full-screen in gPhotos' own player with normal play/pause/seek controls
  — the same way clicking a photo opens it full-screen.
- Crop, rotate and the other photo-editing tools don't apply to a video and simply aren't shown for one.
- Videos are not face-scanned, not sent to Smart Flows, and not included in the background
  auto-tagging pass above — those all work on still images only.

### Getting videos into a library you already opened before this feature existed

Video support only applies to files a scan actually sees — a library opened for the first time
scans fresh and picks up videos automatically, but a library you opened **before** video support
existed won't show its videos until it's told to look again:

- **Network/cloud (virtual mirror) storages**: click **Rescan** — the icon-only toolbar button in
  Photos (only shown when viewing a network-backed library), the refresh icon next to a storage in
  the Sidebar, or **"Rescan / Refresh"** / **"Rescan All Network Mirrors"** in Settings → Network
  Mirrors. This re-walks the source and picks up new videos (and any other new files) immediately —
  nothing else to do.
- **A plain local folder**: the same toolbar **Rescan** button (Photos screen) now appears for a
  local library too — click it to re-walk the folder on disk. It's safe to use anytime: it only adds
  genuinely new files and removes genuinely deleted ones — your favorites, rotations, and album
  membership on existing photos are untouched. (Simply reopening the same folder from "Open Folder"
  or the recent-libraries list does **not** do this — once a folder's been indexed, reopening it just
  reloads the existing catalog instantly without checking the disk again, which is normally what you
  want for speed; Rescan is the explicit "check for anything new" action.)
