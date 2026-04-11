# PinPoints: The missing link between your UI and your AI

**Pick UI elements and inject structured context directly into your AI coding agent** — without full-page screenshots.

## Overview

PinPoints is a VS Code extension that replaces the tedious "screenshot → paste → explain" workflow with instant, structured UI context capture. Hover over elements in a running web app, click to capture, and get AI-optimized context automatically injected into your chat.

### Problem it solves

Avoids noisy screenshots by providing structured, DOM-aware UI context that reduces ambiguity and token usage.


## Installation

### 1) VS Code extension

Install PinPoints from the VS Code Marketplace:

[PinPoints on VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pinpointpoint.pinpoints)

### 2) Global CLI installation

Install the CLI globally:

```bash
npm install -g pinpoints
```

Then run:

```bash
pinpoints start
```



## Usage

### How It Works

1. **Start the picker**: Run command `PinPoints: Start Picker`
2. **Enter URL**: Type the localhost or external URL to inspect
3. **Hover & click**: Hover over elements in the browser; click to capture
4. **Chat opens**: Formatted context is automatically injected
5. **Add your instruction**: Type "Make this button look like..." and send
6. **Close Toolbar**: Press `Esc` to toggle between **Capture** and **Interact** mode.


## Capture Modes

### Quick Fix (default)
Minimal, fast capture for one-liner fixes.

**Output:**
```markdown
## UI Element Context

**URL:** http://localhost:3000
**Selector:** `button[data-testid="submit"]`
**Role:** button
**Text:** "Submit Form"

### Element Structure
<button data-testid="submit" class="btn-primary">Submit Form</button>

### Key Styles
- display: block
- padding: 12px 24px
- background-color: #3b82f6

### Layout
- Position: absolute, top: 100px, left: 200px
- Size: 120px × 40px

---
```

### Layout
Element + parent HTML + layout-critical styles.

### CSS
Computed style diff (what's explicitly set vs. inherited) + class list.

### Visual
Screenshot + bbox + minimal metadata.

---

## Architecture

### Components

**Extension Host** (`src/extension.ts`)
- Commands, settings, status bar UI
- Lifecycle management (cleanup on deactivate)

**Browser Session Manager** (`src/browser/`)
- Puppeteer-core Chrome launch with temp profile
- Cleans up on exit (no profile pollution)

**Extraction Pipeline** (`src/extraction/`)
- `SelectorExtractor`: Robust selectors with confidence scoring
- `DomExtractor`: Element + parent HTML (clean, truncated)
- `StyleExtractor`: Computed styles + parent diff
- `LayoutExtractor`: Bbox, viewport, scroll info
- `ScreenshotExtractor`: Element screenshot via Puppeteer
- `Redactor`: Truncates text, strips data URLs, removes event handlers

**Schemas** (`src/schemas/`)
- Zod-validated `MaxContext` (internal format)
- Mode-specific exporters (QuickFix, Layout, CSS, Visual)

**Chat Injection** (`src/export/`)
- `ContextFormatter`: Markdown generation for AI agents
- Direct VS Code chat input injection via `workbench.action.chat.open`

**Picker Controller** (`src/picker/`)
- Orchestrates extraction pipeline
- Manages multi-element selection (Shift+click)
- Handles temp file cleanup

---

## Technical Details

### Browser Control
- **Puppeteer-core** (CDP) for robust element selection
- **Managed Chrome instance** (temp profile, auto-cleanup)
- Overlay hover effect + click detection

### Screenshots
- **Element-level** via `elementHandle.screenshot()`
- Saved to `.pinpoint/temp/element-<timestamp>.png`
- Auto-referenced in chat via @ mention
- Auto-deleted on extension close

### Data Flow
```
Click element →
  Extract selectors (robust priority order)
  Extract DOM (element + parents, cleaned)
  Extract styles (computed + parent diff)
  Extract layout (bbox, viewport, scroll)
  Optional: screenshot
  Redact sensitive data (truncate, strip URLs)
→ Format as markdown
→ Inject to VS Code chat
→ User adds instruction + sends
```

### Selector Priority
1. `data-testid`, `data-test`, `data-qa` (explicit automation attributes)
2. Non-UUID `id` (stable, semantic)
3. `role` + unique `aria-label` (accessibility)
4. Stable class combo (avoid utility classes)
5. Position-based (nth-of-type) fallback

### Style Diff
Computes parent styles, keeps only layout-critical properties:
- Display, position, dimensions (width, height)
- Spacing (margin, padding)
- Flexbox/Grid (flex-direction, justify-content, gap, etc.)
- Overflow, z-index

---