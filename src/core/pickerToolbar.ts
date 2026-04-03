import type * as puppeteer from 'puppeteer-core';

export interface PickerToolbarOptions {
  logoSvg: string;
  initialMode: string;
  initialTarget: string;
  showTargets?: boolean;
}

export async function injectPickerToolbar(
  page: puppeteer.Page,
  options: PickerToolbarOptions
): Promise<void> {
  const { logoSvg, initialMode, initialTarget, showTargets = true } = options;

  await page.evaluate((args: { logoSvg: string; initialMode: string; initialTarget: string; showTargets: boolean }) => {
    const { logoSvg, initialMode, initialTarget, showTargets } = args;
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
    moduleContainer.style.cssText =
      'position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; overflow: visible; z-index: 2147483647;';
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
            <button data-mode="full" title="Full" style="${btnBase}">
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

    if (!showTargets) {
      const targetGroup = document.getElementById('pinpoint-targets');
      if (targetGroup) {
        const maybeDivider = targetGroup.previousElementSibling as HTMLElement | null;
        if (maybeDivider && maybeDivider.tagName.toLowerCase() === 'div') {
          maybeDivider.remove();
        }
        targetGroup.remove();
      }
    }

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
  const targets = document.getElementById('pinpoint-targets');
    const modeSlider = document.getElementById('pinpoint-mode-slider')!;
  const targetSlider = document.getElementById('pinpoint-target-slider');
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
      tooltip.style.left = btnRect.left + btnRect.width / 2 - tipWidth / 2 + 'px';
      tooltip.style.top = btnRect.top - 32 + 'px';
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
    let activeModeBtn =
      (Array.from(modeButtons).find(
        (btn) => btn.getAttribute('data-mode') === (window as any).pinPointMode
      ) as HTMLElement) || (modeButtons[0] as HTMLElement);

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

    if (showTargets && targets && targetSlider) {
      // Target buttons
      const targetButtons = targets.querySelectorAll('button');
      let activeTargetBtn =
        (Array.from(targetButtons).find((btn) => btn.getAttribute('data-target') === initialTarget) as HTMLElement) ||
        (targetButtons[0] as HTMLElement);

      // Initialize active target button
      activeTargetBtn.style.color = '#ffffff';
      updateSlider(targetSlider as HTMLElement, activeTargetBtn);

      targetButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const target = btn.getAttribute('data-target');
          console.log('PINPOINT_TARGET_CHANGED:', target);

          if (activeTargetBtn !== btn) {
            activeTargetBtn.style.color = 'rgba(255, 255, 255, 0.6)';
            activeTargetBtn = btn as HTMLElement;
            activeTargetBtn.style.color = '#ffffff';
            updateSlider(targetSlider as HTMLElement, activeTargetBtn);
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
    }

    // Hover highlight + click handler
    document.addEventListener(
      'mousemove',
      (e: Event) => {
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
      },
      true
    );

    document.addEventListener(
      'click',
      (e: Event) => {
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
        console.log('PINPOINT_SELECTED:' + JSON.stringify({
          tag: el.tagName,
          class: el.className,
          id: el.id,
          shiftKey: Boolean((e as MouseEvent).shiftKey)
        }));
      },
      true
    );
  }, { logoSvg, initialMode, initialTarget, showTargets });
}
