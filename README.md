# Google Photos Desktop — Standalone Windows Application

A modern, privacy-first desktop photo library and organization suite built with **Electron, React 18, TypeScript, and Vite**. Designed to run 100% locally and offline on Windows without cloud dependence, subscription fees, or external Python runtimes.

> **📖 Complete Documentation**: For step-by-step user instructions, architecture notes, and troubleshooting, see the [User Manual](USER_MANUAL.md).

---

## ✨ Key Features

### 1. 🗂️ Split-Pane Physical Date-Based Photo Organizer
- **Intelligent Date Detection**: Extracts capture timestamps directly from EXIF metadata (`DateTimeOriginal`, `CreateDate`), with graceful fallback to file system creation timestamps.
- **Configurable Folder Schemes**:
  - `YYYY/YYYY-MM` (e.g., `2024/2024-08/IMG_0001.jpg`) — *Default*
  - `YYYY/MM - Month Name` (e.g., `2024/08 - August/IMG_0001.jpg`)
  - `YYYY/YYYY-MM-DD` (e.g., `2024/2024-08-25/IMG_0001.jpg`)
  - `YYYY/MM/DD` (e.g., `2024/08/25/IMG_0001.jpg`)
- **Interactive Split-Pane Dry-Run Review**:
  - **Left Pane (Hierarchical Folder Tree)**: Browse collapsible Year and Month nodes with photo counts.
  - **Right Pane (Photo Review Grid)**: Inspect real photo thumbnails, file size, target paths, and operation status (`COPY`, `MOVE`, `SKIP Duplicate`).
  - **High-Res Previews**: Click any thumbnail in the review grid for an instant high-resolution modal preview.
- **Cryptographic De-duplication**: Uses SHA-256 hashing to identify exact duplicates across directories before copying or moving.
- **Safe Execution Modes**:
  - **Copy Mode** (Default, Non-destructive): Preserves your original photo dump untouched.
  - **Move Mode**: Relocates files to save disk space.

### 2. 👤 Local AI Face Recognition & "People" Virtual Albums
- **100% Local Biometric Detection**: Uses `@vladmandic/face-api` (SSD MobileNet / TinyFaceDetector + FaceRecognitionNet) accelerated with WebGPU / WebGL.
- **128-Dimensional Biometric Embeddings**: Clustered on unit hyperspheres using cosine distance with 2.5× active-learning ground-truth weighting.
- **People Management**:
  - **Instant Inline Renaming**: Click any name or pencil icon to type immediately. Native keyboard focus is active out of the box without requiring DevTools or F12.
  - **Reset & Rescan**: Purges all background face records, resets photo scan flags, and rescans all photos from 1 to Total with a live progress counter.
  - **Cover Photo Customization**: Pick custom cover avatars or use **"AI Best Face"** for the clearest smiling portrait.
  - **Merge People Tool**: Combine multiple face clusters into a single person identity.

### 3. 🔍 AI Duplicate & Burst Shot Cleaner
- **Temporal & Biometric Clustering**: Groups sequential burst shots taken within seconds or containing the same subjects.
- **Multi-Criteria AI Quality Scoring (0–100 pts)**:
  - Sharpness & Focus (0–40 pts)
  - Facial Expressions (0–25 pts)
  - Eye Openness & Gaze (0–10 pts)
  - Megapixel Resolution (0–25 pts)
- **Fullscreen Comparison**: Compare burst photos side-by-side in high resolution with arrow-key navigation.
- **Multi-Keep Selection**: Keep as many photos as you want with individual checkmarks, or use **"Keep AI Best Only"** / **"Keep All"**.
- **Safe Recycle Bin Trashing**: Moves unselected files to the Windows Recycle Bin (`shell.trashItem`) so they can easily be restored if needed.

### 4. 🗺️ Places Interactive Map (Apple Photos Style)
- **100% Free OpenStreetMap**: Powered by `tile.openstreetmap.org`. No API keys, accounts, or CARTO tokens required.
- **Bubble Cluster Pins**: Circular iOS-style map pins showing the latest thumbnail and photo count badge.
- **Batch Cluster Renaming**: Rename any map location cluster (e.g. *"Summer Trip in Paris"*) to apply that name to all photos in the cluster.
- **Custom Geotagging**: Search for landmarks or cities and assign coordinates to unlocated photos with 1 click.

### 5. 📁 Library Switcher & Multi-Folder Management
- **Instant Switching**: Change active photo libraries directly from the sidebar.
- **Recent Libraries History**: Remembers recently opened folders for instant 1-click access.
- **Persistent State**: Retains face detections and library settings across restarts.

### 6. 📦 Zero-Dependency .ZIP Library Backup
- **Native Node.js PKZIP Generator**: Generates standard `.zip` archives with zero external dependencies, 100% compatible with Windows Explorer, WinRAR, and 7-Zip.
- **1-Click Export in Settings**: Packages `library.json`, `settings.json`, manifest statistics, and restoration guides.
- **Show in Explorer**: Directly highlights the backup file in Windows Explorer upon creation.

### 7. 🌐 Virtual Network Storage Mirrors (NAS / SMB / USB)
- **Zero Remote File Movement**: Original photos on your NAS or network share are never altered or moved.
- **500px Thumbnail Cache**: Generates lightweight local thumbnails (~50 KB) and `.json` EXIF sidecars in `C:\GPhotos_VirtualMirrors` for offline browsing.
- **On-Demand High-Res**: Seamlessly serves original high-resolution camera files when connected to your network.

### 8. 🛡️ Defensive Error Handling & Crash Recovery
- **React Error Boundary**: Catches render errors and provides diagnostic logs with **"Try Again"** and **"Reload Application"** buttons. No blank screens.
- **Guarded IPC Pipeline**: Every Electron IPC handler is shielded with `try / catch` blocks and safe fallback responses.
- **Atomic Database Writes**: Library state is written to a temporary file and atomically renamed to prevent corruption.
- **Process Crash Recovery**: Monitors renderer health and offers 1-click reload if the view process restarts.

---

## 🚀 Quick Start & Running Locally

### 1. Install Dependencies
```powershell
npm install
```

### 2. Run Automated Verification Tests
```powershell
# Core logic, date formatting & deduplication
npx tsx test/test_user_enhancements_v5.ts

# Reset & Rescan integrity test
node test/test_reset_and_rescan.js
```

### 3. Build Production Bundle
```powershell
npm run build
```

### 4. Launch Desktop Application
```powershell
npm start
```

### 5. Packaging as a Standalone Windows Installer (`.exe`)
```powershell
npx electron-builder --win
```
The resulting executable will be saved in the `release/` directory.

---

## 📂 Project Structure

```
gphotos/
├── public/
│   ├── help.html             # Embedded interactive documentation viewer
│   └── models/               # Bundled face-api neural network weights
├── src/
│   ├── main/                 # Electron main process
│   │   ├── services/
│   │   │   ├── exifParser.ts # EXIF & GPS metadata extraction
│   │   │   ├── fileOrganizer.ts # Physical date organization & dry-run engine
│   │   │   ├── virtualMirrorService.ts # NAS/SMB mirror cache & thumbnailer
│   │   │   ├── zipBackupService.ts # Pure Node.js PKZIP backup generator
│   │   │   └── backgroundDaemon.ts # 24/7 background sync daemon
│   │   └── main.ts           # Window management, IPC handlers, error recovery
│   ├── preload/
│   │   └── preload.ts        # Typed contextBridge IPC interface
│   ├── renderer/             # React 18 + Vite frontend
│   │   ├── src/
│   │   │   ├── components/   # ErrorBoundary, PhotoCard, Lightbox, Modals
│   │   │   ├── views/        # GalleryView, PeopleView, PlacesMapView, OrganizerView
│   │   │   ├── services/     # faceEngine, clustering, deduplication, libraryStore
│   │   │   ├── App.tsx       # Root UI router & state coordinator
│   │   │   └── index.css     # Dark slate theme & glassmorphic tokens
│   │   └── index.html
│   └── types/
│       └── index.ts          # Shared TypeScript contracts
├── test/                     # Automated test suites
├── USER_MANUAL.md            # Comprehensive user guide & reference manual
├── electron-builder.yml      # Windows installer (.exe) configuration
└── package.json
```

---

## 📄 License
MIT License. Built for private, local, and personal photo management.
