#!/usr/bin/env node

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import type * as puppeteer from 'puppeteer-core';
import { BrowserSessionManager } from '../browser/browserSessionManager';
import { SelectorExtractor } from '../extraction/selectorExtractor';
import { DomExtractor } from '../extraction/domExtractor';
import { StyleExtractor } from '../extraction/styleExtractor';
import { LayoutExtractor } from '../extraction/layoutExtractor';
import { ScreenshotExtractor } from '../extraction/screenshotExtractor';
import { Redactor } from '../extraction/redactor';
import { ContextFormatter } from '../export/contextFormatter';
import { SourceLocator } from '../source/sourceLocator';
import type { CaptureMode, Identity, MaxContext } from '../schemas';
import { injectPickerToolbar } from '../core/pickerToolbar';

interface CliOptions {
  url?: string;
  mode: CaptureMode;
  contextRadius: number;
  screenshot: boolean;
}

interface DetectedServer {
  url: string;
  label: string;
}

class PinpointCliRunner {
  private browserSession: BrowserSessionManager | null = null;
  private capturedElements: MaxContext[] = [];
  private tempDir: string;
  private workspaceRoot: string;
  private currentMode: CaptureMode;
  private isStopping = false;

  constructor(private readonly options: CliOptions) {
    this.workspaceRoot = process.cwd();
    this.tempDir = path.join(this.workspaceRoot, '.pinpoint', 'temp');
    this.currentMode = options.mode;
  }

  async start(): Promise<void> {
    if (!this.workspaceRoot) {
      throw new Error('Could not determine workspace root (cwd).');
    }

    // Start with a clean temp directory every session
    this.cleanupTempDir();
    fs.mkdirSync(this.tempDir, { recursive: true });

    this.ensureGitignore();

    const url = this.options.url ?? (await this.promptForUrl());
    if (!url) {
      throw new Error('No URL provided.');
    }

    this.browserSession = new BrowserSessionManager();
    const page = await this.browserSession.launch({ url });

    await this.enableInspectMode(page);
  await this.injectPickerUI(page, this.currentMode);
    this.setupReinjectHandlers(page);

    await new Promise<void>((resolve) => {
      const onProcessExit = () => {
        this.cleanupTempDir();
      };

      process.once('exit', onProcessExit);

      const onSignal = () => {
        // Fallback cleanup first in case async shutdown is interrupted.
        this.cleanupTempDir();
        void finish();
      };

      const finish = async () => {
        if (this.isStopping) return;
        this.isStopping = true;
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('exit', onProcessExit);
        await this.stop();
        resolve();
      };

      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);

      const browser = this.browserSession?.getBrowser();
      if (browser) {
        browser.once('disconnected', () => {
          void finish();
        });
      }

      page.once('close', () => {
        void finish();
      });
    });
  }

  private setupReinjectHandlers(page: puppeteer.Page): void {
    const attemptReinject = async () => {
      if (this.isStopping) return;
      try {
        await page.waitForSelector('body', { timeout: 2000 }).catch(() => undefined);
        await this.injectPickerUI(page, this.currentMode);
      } catch (error) {
        console.warn('PinPoints: failed to re-inject toolbar after navigation.', error);
      }
    };

    page.on('domcontentloaded', attemptReinject);
    page.on('load', attemptReinject);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        void attemptReinject();
      }
    });
  }

  private async enableInspectMode(page: puppeteer.Page): Promise<void> {
    page.on('console', (msg) => {
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
        void this.captureClickedElement(page, isShiftClick);
        return;
      }

      if (text.startsWith('PINPOINT_MODE_CHANGED:')) {
        const mode = text.replace('PINPOINT_MODE_CHANGED:', '').trim();
        if (mode === 'pick' || mode === 'full') {
          this.currentMode = mode;
        }
        return;
      }

      // CLI always outputs to system clipboard; target controls are hidden in toolbar.
    });
  }

  private async captureClickedElement(page: puppeteer.Page, isShiftClick: boolean = false): Promise<void> {
    try {
      const mode = await page.evaluate(() => {
        return (window as unknown as { pinPointMode?: string }).pinPointMode || 'pick';
      });

      if (mode === 'pick' || mode === 'full') {
        this.currentMode = mode;
      }

      const selectedHandle = await page.evaluateHandle(() => {
        const win = window as unknown as { __pinpoint_clicked?: Element; pinPointMode?: string };
        const el = win.__pinpoint_clicked;
        if (el) {
          delete win.__pinpoint_clicked;
          return el;
        }
        return document.querySelector('[style*="0ea5e9"]') || document.activeElement;
      });

  const elementHandle = selectedHandle.asElement() as puppeteer.ElementHandle<Element> | null;
      if (!elementHandle) {
        await selectedHandle.dispose();
        return;
      }

      const tagName = await elementHandle.evaluate((el: Element) => el.tagName.toLowerCase());
      if (tagName === 'body' || tagName === 'html') {
        console.warn('PinPoints: clicked element was too generic (body/html), try again.');
        await elementHandle.dispose();
        return;
      }

      await this.captureElement(page, elementHandle, isShiftClick);
      await elementHandle.dispose();
    } catch (error) {
      console.error('PinPoints: failed to capture clicked element.', error);
    }
  }

  private async captureElement(page: puppeteer.Page, elementHandle: puppeteer.ElementHandle<Element>, isShiftClick: boolean = false): Promise<void> {
    try {
      const selectorExtractor = new SelectorExtractor();
      const domExtractor = new DomExtractor();
      const styleExtractor = new StyleExtractor();
      const layoutExtractor = new LayoutExtractor();
      const screenshotExtractor = new ScreenshotExtractor();
      const redactor = new Redactor();

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
          classes: Array.from(el.classList),
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          dataAttributes: Object.keys(dataAttributes).length > 0 ? dataAttributes : undefined,
          text: el.textContent?.trim().substring(0, 200) || undefined,
          accessibleName: (el as unknown as { ariaLabel?: string }).ariaLabel || undefined,
        };
      });

      const selectors = await selectorExtractor.extract(elementHandle);
      const dom = await domExtractor.extract(elementHandle, this.options.contextRadius);
      const styles = await styleExtractor.extract(elementHandle, this.currentMode);
      const layout = await layoutExtractor.extract(elementHandle, page);

      let visual;
      const shouldScreenshot = this.currentMode === 'full' || this.options.screenshot;
      if (shouldScreenshot) {
        try {
          visual = await screenshotExtractor.extract(elementHandle, this.tempDir);
        } catch (error) {
          console.warn('PinPoints: screenshot capture failed; continuing without image.', error);
        }
      }

      let sourceLocation;
      try {
        const sourceLocator = new SourceLocator();
        sourceLocation = await sourceLocator.locate(page, identity, dom, this.workspaceRoot);
      } catch (error) {
        console.warn('PinPoints: source detection failed.', error);
      }

      let reactComponent: string | undefined;
      try {
        reactComponent = await elementHandle.evaluate((el: Element) => {
          const fiberKey = Object.keys(el as unknown as Record<string, unknown>).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
          );
          if (!fiberKey) return undefined;
          let fiber = (el as Record<string, any>)[fiberKey] as any;

          while (fiber) {
            const fiberType = fiber.type as any;
            if (fiberType && typeof fiberType === 'function') {
              const name = fiberType.displayName || fiberType.name;
              if (name && name !== 'Anonymous') {
                return name;
              }
            }
            fiber = fiber.return as any;
          }
          return undefined;
        });
      } catch {
        // no-op
      }

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

      context = redactor.redact(context);

      if (!isShiftClick) {
        this.capturedElements = [];
      }
      this.capturedElements.push(context);

      const formatter = new ContextFormatter();
      const outputText = formatter.formatForChat(this.capturedElements, this.currentMode, this.workspaceRoot);
      this.deliverOutput(outputText, this.capturedElements.length, isShiftClick);
    } catch (error) {
      console.error('PinPoints: failed to process captured element.', error);
    }
  }

  private deliverOutput(text: string, count: number, isShiftClick: boolean): void {
    const copied = this.copyToClipboard(text);
    if (copied) {
      if (isShiftClick && count > 1) {
        console.log(`Appended element #${count} to clipboard (Shift-click).`);
      } else {
        console.log(`Captured element #${count} to clipboard.`);
      }
      return;
    }

    console.error('Failed to copy capture to system clipboard. Install xclip/xsel/wl-clipboard on Linux.');
  }

  private copyToClipboard(text: string): boolean {
    try {
      const platform = os.platform();

      if (platform === 'darwin') {
        const result = spawnSync('pbcopy', [], { input: text, encoding: 'utf-8' });
        return result.status === 0;
      }

      if (platform === 'win32') {
        const result = spawnSync('clip', [], { input: text, encoding: 'utf-8', shell: true });
        return result.status === 0;
      }

      const xclipResult = spawnSync('xclip', ['-selection', 'clipboard'], {
        input: text,
        encoding: 'utf-8',
      });
      if (xclipResult.status === 0) {
        return true;
      }

      const xselResult = spawnSync('xsel', ['--clipboard', '--input'], {
        input: text,
        encoding: 'utf-8',
      });
      if (xselResult.status === 0) {
        return true;
      }

      const wlCopyResult = spawnSync('wl-copy', [], { input: text, encoding: 'utf-8' });
      return wlCopyResult.status === 0;
    } catch {
      return false;
    }
  }

  private ensureGitignore(): void {
    const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
    const ignorePattern = '.pinpoint/';

    try {
      let gitignoreContent = '';
      if (fs.existsSync(gitignorePath)) {
        gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      }

      if (!gitignoreContent.includes(ignorePattern)) {
        const nextContent = `${gitignoreContent}${gitignoreContent ? '\n' : ''}${ignorePattern}`;
        fs.writeFileSync(gitignorePath, nextContent, 'utf-8');
      }
    } catch {
      // best effort
    }
  }

  private async promptForUrl(): Promise<string | undefined> {
    const CUSTOM_URL = 'Enter custom URL...';
    const recent = this.loadUrlHistory();
    const detectedServers = await this.detectLocalServers();
    const options: string[] = [];

    console.log('\nSelect URL to inspect:');

    if (detectedServers.length > 0) {
      console.log('\nDetected servers:');
      for (const server of detectedServers) {
        options.push(server.url);
        console.log(`  [${options.length}] ${server.url} (${server.label})`);
      }
    }

    const recentWithoutDuplicates = recent.filter((url) => !detectedServers.some((server) => server.url === url));
    if (recentWithoutDuplicates.length > 0) {
      console.log('\nRecent URLs:');
      for (const historyUrl of recentWithoutDuplicates) {
        options.push(historyUrl);
        console.log(`  [${options.length}] ${historyUrl}`);
      }
    }

    options.push(CUSTOM_URL);
    console.log(`\n  [${options.length}] ${CUSTOM_URL}`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const selected = await new Promise<string>((resolve) => {
      rl.question('\nChoose an option number (default 1): ', (answer) => {
        const parsed = Number(answer.trim());
        if (!answer.trim()) {
          resolve(options[0] || CUSTOM_URL);
          return;
        }

        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= options.length) {
          resolve(options[parsed - 1]);
          return;
        }

        resolve(CUSTOM_URL);
      });
    });

    let url: string;
    if (selected === CUSTOM_URL) {
      url = await new Promise<string>((resolve) => {
        rl.question('Enter URL to inspect (default http://localhost:3000): ', (answer) => {
          resolve(answer.trim() || 'http://localhost:3000');
        });
      });
    } else {
      url = selected;
    }

    rl.close();
    this.saveUrlToHistory(url, recent);
    return url;
  }

  private async detectLocalServers(): Promise<DetectedServer[]> {
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

    const results: DetectedServer[] = [];
    await Promise.all(
      commonPorts.map(async ({ port, label }) => {
        const open = await this.isPortOpen(port, 150);
        if (open) {
          results.push({ url: `http://localhost:${port}`, label: `Port ${port} · ${label}` });
        }
      })
    );

    return results.sort((a, b) => {
      const portA = Number(a.url.split(':').pop());
      const portB = Number(b.url.split(':').pop());
      return portA - portB;
    });
  }

  private async isPortOpen(port: number, timeout: number): Promise<boolean> {
    return await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
  }

  private loadUrlHistory(): string[] {
    const historyPath = path.join(this.workspaceRoot, '.pinpoint', 'url-history.json');
    try {
      if (!fs.existsSync(historyPath)) {
        return [];
      }

      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter((item): item is string => typeof item === 'string').slice(0, 10);
    } catch {
      return [];
    }
  }

  private saveUrlToHistory(url: string, existingHistory: string[]): void {
    const historyPath = path.join(this.workspaceRoot, '.pinpoint', 'url-history.json');
    const maxHistory = 10;
    const updated = [url, ...existingHistory.filter((item) => item !== url)].slice(0, maxHistory);

    try {
      fs.writeFileSync(historyPath, JSON.stringify(updated, null, 2), 'utf-8');
    } catch {
      // best effort only
    }
  }

  private async injectPickerUI(page: puppeteer.Page, initialMode: CaptureMode): Promise<void> {
    const logoSvgPath = path.resolve(__dirname, '../../resources/logo.svg');
    const logoSvg = fs.readFileSync(logoSvgPath, 'utf-8');
    const initialTarget = 'clipboard';

    await injectPickerToolbar(page, {
      logoSvg,
      initialMode,
      initialTarget,
      showTargets: false,
    });
  }

  async stop(): Promise<void> {
    try {
      if (this.browserSession) {
        await this.browserSession.close();
        this.browserSession = null;
      }
    } finally {
      this.cleanupTempDir();
    }
  }

  private cleanupTempDir(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch {
      // best effort cleanup
    }
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'pick',
    contextRadius: 1,
    screenshot: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') {
      options.url = argv[++i];
      continue;
    }

    if (arg === '--mode') {
      const value = argv[++i];
      if (value === 'pick' || value === 'full') {
        options.mode = value;
      }
      continue;
    }

    if (arg === '--context-radius') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 3) {
        options.contextRadius = parsed;
      }
      continue;
    }

    if (arg === '--screenshot') {
      options.screenshot = true;
      continue;
    }
  }

  return options;
}

function printUsage(): void {
  console.log('PinPoints CLI');
  console.log('Usage: pinpoints start [--url <url>] [--mode pick|full] [--context-radius <n>] [--screenshot]');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printUsage();
    return;
  }

  if (subcommand !== 'start') {
    console.error(`Unknown command: ${subcommand}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const options = parseArgs(args.slice(1));
  const runner = new PinpointCliRunner(options);
  await runner.start();
}

main().catch((error) => {
  console.error('PinPoints CLI failed to start.', error);
  process.exitCode = 1;
});
