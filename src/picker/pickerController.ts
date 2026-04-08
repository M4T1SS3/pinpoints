import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { BrowserSessionManager } from '../browser/browserSessionManager';
import { SelectorExtractor } from '../extraction/selectorExtractor';
import { DomExtractor } from '../extraction/domExtractor';
import { StyleExtractor } from '../extraction/styleExtractor';
import { LayoutExtractor } from '../extraction/layoutExtractor';
import { ScreenshotExtractor } from '../extraction/screenshotExtractor';
import { Redactor } from '../extraction/redactor';
import { ContextFormatter } from '../export/contextFormatter';
import { SourceLocator } from '../source/sourceLocator';
import { MaxContext, CaptureMode, Identity } from '../schemas';
import { injectPickerToolbar } from '../core/pickerToolbar';

export class PickerController {
  private browserSession: BrowserSessionManager | null = null;
  private currentMode: CaptureMode = 'pick';
  private screenshotEnabled: boolean = false;
  private contextRadius: number = 1;
  private injectionTarget: string = 'claude-code';
  private capturedElements: MaxContext[] = [];
  private tempDir: string | null = null;
  private isPickerActive: boolean = false;
  private workspaceRoot: string;

  constructor(private context: vscode.ExtensionContext) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.loadSettings();
  }

  private loadSettings() {
    const config = vscode.workspace.getConfiguration('pinpoints');
    this.currentMode = (config.get('defaultMode') || 'pick') as CaptureMode;
    this.screenshotEnabled = config.get('screenshotEnabled', false) as boolean;
    this.contextRadius = config.get('contextRadius', 1) as number;
    this.injectionTarget = config.get('injectionTarget', 'claude-code') as string;
  }

  async startPicker() {
    try {
      // Initialize temp directory
      if (!this.workspaceRoot) {
        throw new Error('No workspace folder open. Please open a folder first.');
      }

      this.tempDir = path.join(this.workspaceRoot, '.pinpoint', 'temp');
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      // Ensure .gitignore includes .pinpoint/
      this.ensureGitignore();

      // Detect local servers and let user pick or enter custom URL
      const url = await this.promptForUrl();
      if (!url) {
        return;
      }

      // Launch browser and navigate directly to the URL
      this.browserSession = new BrowserSessionManager();

      try {
        const page = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `PinPoints: Loading ${url}...`,
          },
          async () => {
            const p = await this.browserSession!.launch({ url });
            return p;
          }
        );

        vscode.window.showInformationMessage('Page loaded. Injecting picker...');

        // Enable inspect mode
        await this.enableInspectMode(page);

        // Load logo SVG from file (single source of truth)
        const logoSvgPath = path.join(this.context.extensionPath, 'resources', 'logo.svg');
        const logoSvgContent = fs.readFileSync(logoSvgPath, 'utf-8');

        // Inject picker UI and handlers
        await this.injectPickerUI(page, logoSvgContent, this.currentMode, this.injectionTarget);

        // Re-inject on navigation/refresh to make persistent
        const attemptReinject = async () => {
          if (this.isPickerActive) {
            try {
              // Wait for body to be available just in case
              await page.waitForSelector('body', { timeout: 2000 }).catch(() => {});
              await this.injectPickerUI(page, logoSvgContent, this.currentMode, this.injectionTarget);
            } catch (e) {
              console.error('Failed to reinject picker UI:', e);
            }
          }
        };

        page.on('domcontentloaded', attemptReinject);
        page.on('load', attemptReinject);
        page.on('framenavigated', (frame: any) => {
          if (frame === page.mainFrame()) {
            attemptReinject();
          }
        });

        this.isPickerActive = true;

        vscode.window.showInformationMessage(
          'Picker active: Hover and click elements. Toolbar visible at bottom of page.'
        );
      } catch (innerError) {
        vscode.window.showErrorMessage(`Error during picker setup: ${innerError}`);
        throw innerError;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to start picker: ${error}`);
      await this.stopPicker();
    }
  }

  private async injectPickerUI(page: any, logoSvg: string, initialMode: string, initialTarget: string) {
    await injectPickerToolbar(page, { logoSvg, initialMode, initialTarget });
    return;

    await page.evaluate((args: { logoSvg: string, initialMode: string, initialTarget: string }) => {
      const { logoSvg, initialMode, initialTarget } = args;
      if (document.getElementById('pinpoint-module')) return;
      const btnBase = `
        height: 36px;
        padding: 0;
        background: transparent;
        border: none;
        border-radius: 9999px;
        color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        transition: color 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        z-index: 1;
        width: 36px;
        flex-shrink: 0;
      `;

      // Create floating toolbar that doesn't affect page layout
      const moduleContainer = document.createElement('div');
      moduleContainer.id = 'pinpoint-module';
      moduleContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; overflow: visible; z-index: 2147483647;';
      moduleContainer.innerHTML = `
        <div id="pinpoint-tooltip" style="
          position: fixed;
          z-index: 9999999999;
          background: rgba(0, 0, 0, 0.85);
          color: #fff;
          font-size: 11px;
          font-weight: 500;
          padding: 4px 10px;
          border-radius: 6px;
          pointer-events: none;
          white-space: nowrap;
          opacity: 0;
          transition: opacity 0.15s ease;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        "></div>
        <div id="pinpoint-toolbar" style="
          pointer-events: auto;
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 999999999;
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 2px;
          padding: 6px 10px;
          background: rgba(30, 30, 30, 0.92);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 9999px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.2);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          user-select: none;
          transition: padding 0.3s cubic-bezier(0.4, 0, 0.2, 1), gap 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        ">
          <!-- Toggle button (always visible) -->
          <button id="pinpoint-toggle" title="Capture mode active (click or Esc to interact)" style="
            height: 36px;
            width: 36px;
            padding: 0;
            background: rgba(14, 165, 233, 0.2);
            border: none;
            border-radius: 9999px;
            color: #0ea5e9;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          ">
            <span id="pinpoint-logo-slot" style="display:flex;align-items:center;justify-content:center;pointer-events:none;"></span>
          </button>

          <!-- Collapsible content -->
          <div id="pinpoint-toolbar-content" style="
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 2px;
            overflow: hidden;
            transition: max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
            max-width: 600px;
            opacity: 1;
          ">

          <!-- Drag handle -->
          <div id="pinpoint-drag" title="Drag to reposition" style="
            width: 28px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: grab;
            color: rgba(255, 255, 255, 0.3);
            flex-shrink: 0;
          ">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
              <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
              <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
            </svg>
          </div>

          <!-- Mode buttons -->
          <div id="pinpoint-modes" style="
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 2px;
            position: relative;
          ">
            <div id="pinpoint-mode-slider" style="
              position: absolute;
              top: 0;
              left: 0;
              height: 100%;
              background: rgba(255, 255, 255, 0.15);
              border-radius: 9999px;
              z-index: 0;
              pointer-events: none;
              width: 36px;
              transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            "></div>
            <button data-mode="pick" title="Quick Fix" style="${btnBase}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>
              </svg>
            </button>
            <button data-mode="full" title="Screenshot" style="${btnBase}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>

          <!-- Divider -->
          <div style="width: 1px; height: 20px; background: rgba(255, 255, 255, 0.15); margin: 0 6px; flex-shrink: 0;"></div>

          <!-- Target buttons -->
          <div id="pinpoint-targets" style="
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 2px;
            position: relative;
          ">
            <div id="pinpoint-target-slider" style="
              position: absolute;
              top: 0;
              left: 0;
              height: 100%;
              background: rgba(255, 255, 255, 0.15);
              border-radius: 9999px;
              z-index: 0;
              pointer-events: none;
              width: 36px;
              transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            "></div>
            <button data-target="claude-code" title="Claude Code" style="${btnBase}">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;">
                <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/>
              </svg>
            </button>
            <button data-target="copilot-chat" title="Copilot Chat" style="${btnBase}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <path d="M4 18v-5.5c0 -.667 .167 -1.333 .5 -2"/>
                <path d="M12 7.5c0 -1 -.01 -4.07 -4 -3.5c-3.5 .5 -4 2.5 -4 3.5c0 1.5 0 4 3 4c4 0 5 -2.5 5 -4"/>
                <path d="M4 12c-1.333 .667 -2 1.333 -2 2c0 1 0 3 1.5 4c3 2 6.5 3 8.5 3s5.499 -1 8.5 -3c1.5 -1 1.5 -3 1.5 -4c0 -.667 -.667 -1.333 -2 -2"/>
                <path d="M20 18v-5.5c0 -.667 -.167 -1.333 -.5 -2"/>
                <path d="M12 7.5l0 -.297l.01 -.269l.027 -.298l.013 -.105l.033 -.215c.014 -.073 .029 -.146 .046 -.22l.06 -.223c.336 -1.118 1.262 -2.237 3.808 -1.873c2.838 .405 3.703 1.797 3.93 2.842l.036 .204c0 .033 .01 .066 .013 .098l.016 .185l0 .171l0 .49l-.015 .394l-.02 .271c-.122 1.366 -.655 2.845 -2.962 2.845c-3.256 0 -4.524 -1.656 -4.883 -3.081l-.053 -.242a3.865 3.865 0 0 1 -.036 -.235l-.021 -.227a3.518 3.518 0 0 1 -.007 -.215l.005 0"/>
                <path d="M10 15v2"/><path d="M14 15v2"/>
              </svg>
            </button>
            <button data-target="clipboard" title="Clipboard" style="${btnBase}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>
              </svg>
            </button>
          </div>
          </div>
        </div>
      `;
      document.body.appendChild(moduleContainer);

      // Inject logo SVG from file and size it to fit the button
      const logoSlot = document.getElementById('pinpoint-logo-slot')!;
      logoSlot.innerHTML = logoSvg;
      const svgEl = logoSlot.querySelector('svg');
      if (svgEl) {
        svgEl.setAttribute('width', '22');
        svgEl.setAttribute('height', '22');
        svgEl.style.flexShrink = '0';
        svgEl.style.pointerEvents = 'none';
        const paths = svgEl.querySelectorAll('path');
        paths.forEach((p: Element, i: number) => {
          if (i === 0) {
            // Outer pin silhouette — fills with currentColor (mode-driven)
            p.setAttribute('fill', 'currentColor');
            p.removeAttribute('stroke');
            p.removeAttribute('stroke-width');
            p.removeAttribute('stroke-linejoin');
          } else {
            // Inner details — dark cutout so they read against the colored fill
            const cutout = 'rgba(20,20,20,0.92)';
            if (p.getAttribute('fill') === 'none') {
              p.setAttribute('stroke', cutout);
            } else {
              p.setAttribute('fill', cutout);
              p.removeAttribute('stroke');
            }
          }
        });
      }

      const toolbar = document.getElementById('pinpoint-toolbar')!;
      const modes = document.getElementById('pinpoint-modes')!;
      const targets = document.getElementById('pinpoint-targets')!;
      const modeSlider = document.getElementById('pinpoint-mode-slider')!;
      const targetSlider = document.getElementById('pinpoint-target-slider')!;
      const tooltip = document.getElementById('pinpoint-tooltip')!;

      // Slider update helper — sets position; CSS transition handles the animation
      function updateSlider(slider: HTMLElement, activeBtn: HTMLElement) {
        slider.style.left = activeBtn.offsetLeft + 'px';
        slider.style.width = activeBtn.offsetWidth + 'px';
      }


      // Tooltip helper
      function showTooltip(btn: HTMLElement, text: string) {
        tooltip.textContent = text;
        tooltip.style.opacity = '1';
        const btnRect = btn.getBoundingClientRect();
        const tipWidth = tooltip.offsetWidth;
        tooltip.style.left = (btnRect.left + btnRect.width / 2 - tipWidth / 2) + 'px';
        tooltip.style.top = (btnRect.top - 32) + 'px';
      }

      function hideTooltip() {
        tooltip.style.opacity = '0';
      }

      // Shared state
      let lastEl: HTMLElement | null = null;

      // Interact/Capture toggle
      let isInteractMode = false;
      const toggleBtn = document.getElementById('pinpoint-toggle')!;
      const toolbarContent = document.getElementById('pinpoint-toolbar-content')!;
      const shortcutLabel = 'Esc';

      function setInteractMode(interact: boolean) {
        isInteractMode = interact;
        if (interact) {
          // Collapsed: hide content, compact circle
          toolbarContent.style.maxWidth = '0';
          toolbarContent.style.opacity = '0';
          toolbar.style.padding = '6px';
          toolbar.style.gap = '0';
          // Collapsed: main logo color
          toggleBtn.style.background = '#ABFF06';
          // Always black icon
          toggleBtn.style.color = '#000000';
          // Clear any hover highlight
          if (lastEl) {
            lastEl.style.outline = '';
            lastEl = null;
          }
        } else {
          // Expanded: show content, restore padding
          toolbarContent.style.maxWidth = '600px';
          toolbarContent.style.opacity = '1';
          toolbar.style.padding = '6px 10px';
          toolbar.style.gap = '2px';
          // Expanded: use main logo color
          toggleBtn.style.background = '#ABFF06';
          // Always black icon
          toggleBtn.style.color = '#000000';
        }
      }

      // Apply initial visual state
      setInteractMode(isInteractMode);

      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setInteractMode(!isInteractMode);
      });

      toggleBtn.addEventListener('mouseenter', () => {
        const label = isInteractMode
          ? `Switch to Capture (${shortcutLabel})`
          : `Switch to Interact (${shortcutLabel})`;
        showTooltip(toggleBtn, label);
      });

      toggleBtn.addEventListener('mouseleave', () => {
        hideTooltip();
      });

      document.addEventListener('keydown', (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Escape') {
          ke.preventDefault();
          ke.stopPropagation();
          setInteractMode(!isInteractMode);
        }
      });

      // Drag logic
      const dragHandle = document.getElementById('pinpoint-drag')!;
      let isDragging = false;
      let dragOffsetX = 0;
      let dragOffsetY = 0;

      dragHandle.addEventListener('mousedown', (e: Event) => {
        const me = e as MouseEvent;
        isDragging = true;
        dragHandle.style.cursor = 'grabbing';
        const rect = toolbar.getBoundingClientRect();
        dragOffsetX = me.clientX - rect.left;
        dragOffsetY = me.clientY - rect.top;
        toolbar.style.left = rect.left + 'px';
        toolbar.style.bottom = 'auto';
        toolbar.style.top = rect.top + 'px';
        toolbar.style.transform = 'none';
        me.preventDefault();
        me.stopPropagation();
      });

      document.addEventListener('mousemove', (e: Event) => {
        if (!isDragging) return;
        const me = e as MouseEvent;
        let newX = me.clientX - dragOffsetX;
        let newY = me.clientY - dragOffsetY;
        const rect = toolbar.getBoundingClientRect();
        newX = Math.max(0, Math.min(window.innerWidth - rect.width, newX));
        newY = Math.max(0, Math.min(window.innerHeight - rect.height, newY));
        toolbar.style.left = newX + 'px';
        toolbar.style.top = newY + 'px';
        me.preventDefault();
        me.stopPropagation();
      });

      document.addEventListener('mouseup', (e: Event) => {
        if (isDragging) {
          isDragging = false;
          dragHandle.style.cursor = 'grab';
          (e as MouseEvent).preventDefault();
          (e as MouseEvent).stopPropagation();
        }
      });

      // Mode buttons
      (window as any).pinPointMode = initialMode || 'pick';
      const modeButtons = modes.querySelectorAll('button');
      let activeModeBtn = Array.from(modeButtons).find(btn => btn.getAttribute('data-mode') === (window as any).pinPointMode) as HTMLElement || modeButtons[0] as HTMLElement;

      // Initialize active mode button
      activeModeBtn.style.color = '#ffffff';
      updateSlider(modeSlider, activeModeBtn);

      modeButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const mode = btn.getAttribute('data-mode');
          (window as any).pinPointMode = mode;
          console.log('PINPOINT_MODE_CHANGED:', mode);

          if (activeModeBtn !== btn) {
            activeModeBtn.style.color = 'rgba(255, 255, 255, 0.6)';
            activeModeBtn = btn as HTMLElement;
            activeModeBtn.style.color = '#ffffff';
            updateSlider(modeSlider, activeModeBtn);
          }
        });

        btn.addEventListener('mouseenter', () => {
          if (btn !== activeModeBtn) {
            (btn as HTMLElement).style.color = 'rgba(255, 255, 255, 0.9)';
            showTooltip(btn as HTMLElement, btn.getAttribute('title') || '');
          }
        });
        btn.addEventListener('mouseleave', () => {
          if (btn !== activeModeBtn) {
            (btn as HTMLElement).style.color = 'rgba(255, 255, 255, 0.6)';
          }
          hideTooltip();
        });
      });

      // Target buttons
      const targetButtons = targets.querySelectorAll('button');
      let activeTargetBtn = Array.from(targetButtons).find(btn => btn.getAttribute('data-target') === initialTarget) as HTMLElement || targetButtons[0] as HTMLElement;

      // Initialize active target button
      activeTargetBtn.style.color = '#ffffff';
      updateSlider(targetSlider, activeTargetBtn);

      targetButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const target = btn.getAttribute('data-target');
          console.log('PINPOINT_TARGET_CHANGED:', target);

          if (activeTargetBtn !== btn) {
            activeTargetBtn.style.color = 'rgba(255, 255, 255, 0.6)';
            activeTargetBtn = btn as HTMLElement;
            activeTargetBtn.style.color = '#ffffff';
            updateSlider(targetSlider, activeTargetBtn);
          }
        });

        btn.addEventListener('mouseenter', () => {
          if (btn !== activeTargetBtn) {
            (btn as HTMLElement).style.color = 'rgba(255, 255, 255, 0.9)';
            showTooltip(btn as HTMLElement, btn.getAttribute('title') || '');
          }
        });
        btn.addEventListener('mouseleave', () => {
          if (btn !== activeTargetBtn) {
            (btn as HTMLElement).style.color = 'rgba(255, 255, 255, 0.6)';
          }
          hideTooltip();
        });
      });

      // Hover highlight + click handler
      document.addEventListener('mousemove', (e: Event) => {
        if (isDragging) return;
        if (isInteractMode) return;
        
        // Use elementFromPoint instead of e.target for more reliable hit testing,
        // especially with complex layouts or overlays
        const target = document.elementFromPoint((e as MouseEvent).clientX, (e as MouseEvent).clientY);
        if (!target) return;
        const el = target as HTMLElement;

        // Skip highlighting the module itself
        if (el.closest('#pinpoint-module')) return;

        if (lastEl && lastEl !== el && lastEl !== (window as any).__pinpoint_clicked) {
          lastEl.style.outline = '';
        }
        el.style.outline = '3px solid #0ea5e9';
        el.style.outlineOffset = '2px';
        lastEl = el;
      }, true);

      document.addEventListener('click', (e: Event) => {
        if (isDragging) return;
        if (isInteractMode) return;
        
        const target = document.elementFromPoint((e as MouseEvent).clientX, (e as MouseEvent).clientY);
        if (!target) return;
        const el = target as HTMLElement;

        // Don't capture if clicking the module
        if (el.closest('#pinpoint-module')) return;

        e.preventDefault();
        e.stopPropagation();
        (window as any).__pinpoint_clicked = el;
        console.log('PINPOINT_SELECTED:', JSON.stringify({
          tag: el.tagName,
          class: el.className,
          id: el.id,
        }));
      }, true);
    }, { logoSvg, initialMode, initialTarget });
  }

  private async promptForUrl(): Promise<string | undefined> {
    const CUSTOM_URL_LABEL = '$(edit) Enter custom URL...';
    const HISTORY_KEY = 'pinpoint.urlHistory';
    const MAX_HISTORY = 10;

    const history: string[] = this.context.globalState.get(HISTORY_KEY, []);
    const detectedServers = await this.detectLocalServers();

    const items: vscode.QuickPickItem[] = [];

    if (detectedServers.length > 0) {
      items.push({ label: 'Detected Servers', kind: vscode.QuickPickItemKind.Separator });
      for (const server of detectedServers) {
        items.push({
          label: `$(radio-tower) ${server.url}`,
          description: server.label,
          detail: server.url,
        });
      }
    }

    if (history.length > 0) {
      items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
      for (const historyUrl of history) {
        if (detectedServers.some(s => s.url === historyUrl)) continue;
        items.push({
          label: `$(history) ${historyUrl}`,
          detail: historyUrl,
        });
      }
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: CUSTOM_URL_LABEL,
      description: 'Type any URL',
      alwaysShow: true,
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a local server or enter a custom URL',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!picked) return undefined;

    let url: string | undefined;
    if (picked.label === CUSTOM_URL_LABEL) {
      url = await vscode.window.showInputBox({
        prompt: 'Enter the URL to inspect',
        placeHolder: 'e.g., http://localhost:3000',
        value: history[0] || 'http://localhost:3000',
      });
    } else {
      url = picked.detail;
    }

    if (!url) return undefined;

    const updatedHistory = [url, ...history.filter(h => h !== url)].slice(0, MAX_HISTORY);
    await this.context.globalState.update(HISTORY_KEY, updatedHistory);

    return url;
  }

  private async detectLocalServers(): Promise<{ url: string; label: string }[]> {
    const commonPorts = [
      { port: 3000, label: 'React / Express' },
      { port: 3001, label: 'React (alt)' },
      { port: 4200, label: 'Angular' },
      { port: 4321, label: 'Astro' },
      { port: 5000, label: 'Flask / .NET' },
      { port: 5173, label: 'Vite' },
      { port: 5174, label: 'Vite (alt)' },
      { port: 5500, label: 'Live Server' },
      { port: 8000, label: 'Django / Python' },
      { port: 8080, label: 'General dev server' },
      { port: 8081, label: 'General dev server' },
      { port: 8888, label: 'Jupyter / dev server' },
      { port: 3333, label: 'Dev server' },
      { port: 4000, label: 'Phoenix / Gatsby' },
      { port: 1234, label: 'Parcel' },
      { port: 9000, label: 'Webpack / PHP' },
    ];

    const results: { url: string; label: string }[] = [];

    const checks = commonPorts.map(({ port, label }) =>
      this.isPortOpen(port, 150).then(open => {
        if (open) {
          results.push({ url: `http://localhost:${port}`, label: `Port ${port} · ${label}` });
        }
      })
    );

    await Promise.all(checks);
    results.sort((a, b) => {
      const portA = parseInt(a.url.split(':').pop()!);
      const portB = parseInt(b.url.split(':').pop()!);
      return portA - portB;
    });

    return results;
  }

  private isPortOpen(port: number, timeout: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, '127.0.0.1');
    });
  }

  async stopPicker() {
    this.isPickerActive = false;
    if (this.browserSession) {
      await this.browserSession.close();
      this.browserSession = null;
    }
    this.capturedElements = [];
  }

  toggleScreenshot() {
    this.screenshotEnabled = !this.screenshotEnabled;
  }

  isScreenshotEnabled(): boolean {
    return this.screenshotEnabled;
  }

  setMode(mode: CaptureMode) {
    this.currentMode = mode;
  }

  clearSelection() {
    this.capturedElements = [];
  }

  private async enableInspectMode(page: any) {
    page.on('console', (msg: any) => {
      const text = msg.text();
      if (text.startsWith('PINPOINT_SELECTED:')) {
        const dataStr = text.substring('PINPOINT_SELECTED:'.length).trim();
        let isShiftClick = false;
        try {
          const data = JSON.parse(dataStr);
          isShiftClick = Boolean(data?.shiftKey);
        } catch (e) {
          // fallback to false
        }
        this.captureClickedElement(page, isShiftClick);
      } else if (text.startsWith('PINPOINT_MODE_CHANGED:')) {
        const mode = text.replace('PINPOINT_MODE_CHANGED:', '').trim();
        if (['pick', 'full'].includes(mode)) {
          this.currentMode = mode as CaptureMode;
          vscode.workspace.getConfiguration('pinpoints').update('defaultMode', mode, true);
        }
      } else if (text.startsWith('PINPOINT_TARGET_CHANGED:')) {
        const target = text.replace('PINPOINT_TARGET_CHANGED:', '').trim();
        if (['claude-code', 'copilot-chat', 'clipboard'].includes(target)) {
          this.injectionTarget = target;
          vscode.workspace.getConfiguration('pinpoints').update('injectionTarget', target, true);
        }
      }
    });
  }

  private async captureClickedElement(page: any, isShiftClick: boolean = false) {
    try {
      // Get the selected mode from the page
      const mode = await page.evaluate(() => {
        return (window as any).pinPointMode || 'pick';
      });

      // Update the current mode
      if (mode && ['pick', 'full'].includes(mode)) {
        this.currentMode = mode as CaptureMode;
      }

      // Get the element that was clicked (stored reference, with fallbacks)
      const elementHandle = await page.evaluateHandle(() => {
        const el = (window as any).__pinpoint_clicked;
        if (el) {
          delete (window as any).__pinpoint_clicked;
          return el;
        }
        return document.querySelector('[style*="0ea5e9"]') || document.activeElement;
      });

      if (elementHandle) {
        const tagName = await elementHandle.evaluate((el: Element) => el.tagName.toLowerCase());
        if (tagName === 'body' || tagName === 'html') {
          vscode.window.showWarningMessage('PinPoints: Could not identify the clicked element. Please try again.');
          return;
        }
        await this.captureElement(elementHandle, isShiftClick);
      }
    } catch (error) {
      console.error('Failed to capture clicked element:', error);
    }
  }

  private ensureGitignore() {
    const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
    const tmpPattern = '.pinpoint/';

    try {
      let gitignoreContent = '';

      if (fs.existsSync(gitignorePath)) {
        gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      }

      if (!gitignoreContent.includes(tmpPattern)) {
        gitignoreContent += (gitignoreContent ? '\n' : '') + tmpPattern;
        fs.writeFileSync(gitignorePath, gitignoreContent);
      }
    } catch {
      // Silently fail if we can't update gitignore
    }
  }

  async captureElement(elementHandle: any, isShiftClick: boolean = false): Promise<void> {
    try {
      if (!this.browserSession) {
        throw new Error('Browser session not active');
      }

      const page = this.browserSession.getPage();
      if (!page) {
        throw new Error('Page not available');
      }

      // Extract information
      const selectorExtractor = new SelectorExtractor();
      const domExtractor = new DomExtractor();
      const styleExtractor = new StyleExtractor();
      const layoutExtractor = new LayoutExtractor();
      const screenshotExtractor = new ScreenshotExtractor();
      const redactor = new Redactor();

      // Get identity first
      const identity: Identity = await elementHandle.evaluate((el: Element) => {
        const dataAttributes: Record<string, string> = {};
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.startsWith('data-')) {
            dataAttributes[attr.name] = attr.value;
          }
        }
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          classes: Array.from(el.classList) as string[],
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          dataAttributes: Object.keys(dataAttributes).length > 0 ? dataAttributes : undefined,
          text: (el.textContent?.trim().substring(0, 200) || undefined) as string | undefined,
          accessibleName: (el as any).ariaLabel || undefined,
        };
      });

      // Extract all data
      const selectors = await selectorExtractor.extract(elementHandle);
      const dom = await domExtractor.extract(elementHandle, this.contextRadius);
      const styles = await styleExtractor.extract(elementHandle, this.currentMode);
      const layout = await layoutExtractor.extract(elementHandle, page);

      let visual;
      const shouldScreenshot = this.currentMode === 'full' || this.screenshotEnabled;
      if (shouldScreenshot && this.tempDir) {
        try {
          visual = await screenshotExtractor.extract(elementHandle, this.tempDir);
        } catch (error) {
          console.warn('Screenshot capture failed:', error);
          vscode.window.showWarningMessage('PinPoints: Screenshot capture failed. Other data was captured successfully.');
        }
      }

      // Detect source file
      let sourceLocation;
      try {
        const sourceLocator = new SourceLocator();
        sourceLocation = await sourceLocator.locate(page, identity, dom, this.workspaceRoot);
      } catch (error) {
        console.warn('Source detection failed:', error);
      }

      // Detect React component name via fiber tree
      let reactComponent: string | undefined;
      try {
        reactComponent = await elementHandle.evaluate((el: Element) => {
          const fiberKey = Object.keys(el).find(
            k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
          );
          if (!fiberKey) return undefined;
          let fiber = (el as any)[fiberKey];
          while (fiber) {
            if (fiber.type && typeof fiber.type === 'function') {
              const name = fiber.type.displayName || fiber.type.name;
              if (name && name !== 'Anonymous') return name;
            }
            fiber = fiber.return;
          }
          return undefined;
        }) || undefined;
      } catch (error) {
        console.warn('React component detection failed:', error);
      }

      // Build MaxContext
      let context: MaxContext = {
        meta: {
          url: page.url(),
          timestamp: new Date().toISOString(),
          viewport: layout.viewport || { width: 1920, height: 1080 },
          dpr: layout.devicePixelRatio,
        },
        identity,
        selectors,
        dom,
        layout,
        styles,
        visual,
        sourceLocation,
        reactComponent,
      };

      // Redact sensitive data
      context = redactor.redact(context);

      // Store captured element
      if (!isShiftClick) {
        this.capturedElements = [];
      }
      this.capturedElements.push(context);

      // Format and inject to chat
      const formatter = new ContextFormatter();
      const injectedText = formatter.formatForChat(
        this.capturedElements,
        this.currentMode,
        this.workspaceRoot
      );

      // Inject to focused location (terminal, chat, or clipboard)
      await this.injectToFocusedLocation(injectedText, this.capturedElements.length);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to capture element: ${error}`);
    }
  }

  private async injectToFocusedLocation(injectedText: string, elementNumber: number) {
    const target = this.injectionTarget;

    if (target === 'claude-code') {
      try {
        await vscode.commands.executeCommand('claude-vscode.focus');
        // Wait for the chat to open and focus (increased delay to handle cold start)
        await new Promise(r => setTimeout(r, 600));
        await this.replaceFocusedInputWithText(injectedText + '\n\n');
        
        // Auxiliary view updates - don't fail the whole block if these error
        try {
          await new Promise(r => setTimeout(r, 100));
          await vscode.commands.executeCommand('list.scrollToBottom');
          await vscode.commands.executeCommand('cursorBottom');
        } catch (e) { /* ignore scroll errors */ }
        
        vscode.window.showInformationMessage(`Captured element #${elementNumber} to Claude Code`);
        return;
      } catch (err) {
        console.warn('Claude Code injection failed, falling back to clipboard', err);
      }
    }

    if (target === 'copilot-chat') {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open');
        // Wait enough time for the chat view to focus
        await new Promise(r => setTimeout(r, 600));
        await this.replaceFocusedInputWithText(injectedText + '\n\n');
        
        // Auxiliary view updates - don't fail the whole block if these error
        try {
          await new Promise(r => setTimeout(r, 100));
          await vscode.commands.executeCommand('workbench.action.chat.scrollToBottom');
        } catch (e) { /* might not exist in all versions */ }
        
        try {
          await vscode.commands.executeCommand('list.scrollToBottom'); // Fallback
          await vscode.commands.executeCommand('cursorBottom'); 
        } catch (e) { /* ignore scroll errors */ }

        vscode.window.showInformationMessage(`Captured element #${elementNumber} to Copilot Chat`);
        return;
      } catch (err) {
        console.warn('Copilot Chat injection failed, falling back to clipboard', err);
      }
    }

    // Clipboard fallback (or explicit clipboard target)
    await vscode.env.clipboard.writeText(injectedText);
    vscode.window.showInformationMessage(`Context copied to clipboard. Paste where needed.`);
  }

  private async replaceFocusedInputWithText(text: string) {
    await vscode.env.clipboard.writeText(text);

    // Best-effort clear of the focused input before pasting so latest capture replaces previous one.
    try {
      await vscode.commands.executeCommand('editor.action.selectAll');
      await vscode.commands.executeCommand('deleteLeft');
    } catch {
      // Ignore; fallback paste below may still work.
    }

    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  }

  cleanup() {
    if (this.browserSession) {
      this.browserSession.dispose();
      this.browserSession = null;
    }

    // Clean up temp directory
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // Silently fail
      }
    }
  }
}
