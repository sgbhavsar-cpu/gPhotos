# Manual Test Guide: Reset & Rescan + Person Renaming

This document provides step-by-step instructions to manually verify:
1. **The "Reset & Rescan" feature** (verifying that all background data is completely deleted, detection starts fresh, progress advances from 1 to 45, and completes).
2. **The "Person Renaming" fix** (verifying that you can click and immediately type any name smoothly without having to press F12 or open DevTools).

---

## Part 1: Manual Testcase for "Reset & Rescan"

### Objective:
Verify that clicking **Reset & Rescan** completely wipes all previous people, face boxes, and completion flags, and runs a 100% fresh face detection across all 45 photos with live progress counter and completion toast.

### Step-by-Step Test Procedure:

1. **Launch the Application**:
   - Run `npm start` (or ensure gPhotos is open).
2. **Navigate to People**:
   - Click **People** in the left sidebar.
   - Note the existing people cards and face counts (e.g. Sachin, Monika, etc.).
3. **Trigger Reset & Rescan**:
   - Click the red/pink **Reset & Rescan** button (with the circular arrow icon next to "Detect Faces").
   - A confirmation dialog will appear:
     > *"Reset all people data and restart face detection from scratch? This will remove all recognized people, face clusters, and manual tags, and re-scan your photos..."*
   - Click **OK / Yes**.
4. **Verify Background Purge (Immediate)**:
   - All people profiles immediately clear from the screen.
   - Any background face queues are terminated.
   - `library.json` reflects `people: []`, `faces: []`, and resets `faceScanCompleted: false` for all 45 photos.
5. **Verify Live Progress**:
   - The face scanner starts automatically.
   - The top banner shows:
     > **Scanning faces: Photo X of 45 (filename.jpg)...**
   - The progress counter steadily counts from **1 of 45** through **45 of 45**.
6. **Verify Completion & People Re-generation**:
   - When photo 45 completes, an alert/toast appears:
     > *"Face recognition complete! Detected X new face instances."*
   - The People grid immediately populates with newly clustered people cards and face counts.

---

## Part 2: Manual Testcase for "Renaming People" (No F12 Needed)

### Root Cause Explanation (Why F12 Was Previously Needed):
1. **Chromium Focus Detachment**: When clicking the person's name or edit button, the previous DOM element (`<h2>` or `<button>`) was destroyed during the click event. Chromium lost active text-input focus, leaving the window in an unfocused state where keystrokes were dropped.
2. **Container `onMouseDown` Interception**: The parent `PersonNameInput` wrapper div had `onMouseDown={(e) => e.stopPropagation()}`, which prevented native mouse clicks from establishing caret focus.
3. **Electron Windows OS Focus**: The Electron `BrowserWindow` did not forward initial focus to its `WebContents` on launch. Pressing **F12** opened DevTools, which triggered a blur/focus cycle on the window that inadvertently forced Chromium to re-attach the input pipeline.

### What Was Fixed:
- **Triple-Stage Focus Guarantee**: When renaming opens, focus is applied synchronously, on the next animation frame, and via `setTimeout(50ms)` after the click lifecycle finishes.
- **`autoFocus` & Native Click Handlers**: The `<input>` now has `autoFocus={true}` and its own direct `onClick` focus handler.
- **Removed `onMouseDown` Blocking**: Natural browser mouse and focus events now reach the input without interference.
- **Standard Edit Menu**: Registered standard native Edit shortcuts (`Undo`, `Redo`, `Cut`, `Copy`, `Paste`, `Select All`) in Electron's main process.
- **Window Focus Forwarding**: `mainWindow.once('ready-to-show')` and `mainWindow.on('focus')` now explicitly focus `webContents`.

### Step-by-Step Test Procedure:

1. In the **People** tab, click on any person card (or view their detail page).
2. Click directly on their name text or the **pencil (Edit)** icon.
3. **Type immediately on your keyboard** (e.g. type `Alex` or `Test Name`).
   - Notice the text appears **immediately** as you type, with a blue outline and a visible blinking text cursor.
   - **Do NOT press F12** — typing works completely natively out of the box!
4. Test keyboard shortcuts:
   - Press **Enter** to save the new name (or click the green checkmark).
   - Click rename again and press **Escape** to cancel (or click the X icon).
5. Test renaming directly in the Person Card Grid:
   - On the main People tab, click the name of any person in the grid.
   - Notice the input appears pre-filled with the cursor at the end, and you can type, delete, and rename instantly.
