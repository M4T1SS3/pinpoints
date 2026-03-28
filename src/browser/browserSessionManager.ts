import * as puppeteer from 'puppeteer-core';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface BrowserSessionConfig {
  headless?: boolean;
  executablePath?: string;
  url?: string;
}

export class BrowserSessionManager {
  private browser: puppeteer.Browser | null = null;
  private page: puppeteer.Page | null = null;
  private tempProfileDir: string | null = null;

  async launch(config: BrowserSessionConfig = {}): Promise<puppeteer.Page> {
    try {
      // Create temp profile directory
      this.tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinpoint-'));

      // Find Chrome executable
      const executablePath =
        config.executablePath ||
        this.findChromeExecutable();

      if (!executablePath) {
        throw new Error(
          'Chrome/Chromium not found. Please install Chrome or specify executablePath.'
        );
      }

      // Launch browser with temp profile
      this.browser = await puppeteer.launch({
        executablePath,
        headless: false,
        defaultViewport: null,  // Use actual window size as viewport
        userDataDir: this.tempProfileDir,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-extensions',
          '--no-first-run',
          '--no-default-browser-check',
          '--start-maximized',
        ],
      });

      // Use the default page that Chrome opens (avoids blank tab)
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();

      // Navigate to URL if provided
      if (config.url) {
        await this.page.goto(config.url, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
      }

      return this.page;
    } catch (error) {
      throw new Error(`Failed to launch browser: ${error}`);
    }
  }

  private findChromeExecutable(): string | null {
    const possiblePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS
      '/usr/bin/google-chrome', // Linux
      '/usr/bin/chromium-browser', // Linux
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // Windows
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', // Windows 32-bit
    ];

    for (const path of possiblePaths) {
      if (fs.existsSync(path)) {
        return path;
      }
    }

    return null;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    try {
      await this.page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
    } catch (error) {
      throw new Error(`Failed to navigate to ${url}: ${error}`);
    }
  }

  getPage(): puppeteer.Page | null {
    return this.page;
  }

  getBrowser(): puppeteer.Browser | null {
    return this.browser;
  }

  async close(): Promise<void> {
    if (this.page) {
      try {
        if (!this.page.isClosed()) {
          await this.page.close();
        }
      } catch (error) {
        console.error('Error closing page:', error);
      } finally {
        this.page = null;
      }
    }

    if (this.browser) {
      try {
        if (this.browser.connected) {
          await this.browser.close();
        }
      } catch (error) {
        console.error('Error closing browser:', error);
      } finally {
        this.browser = null;
      }
    }

    // Clean up temp directory
    if (this.tempProfileDir) {
      try {
        if (fs.existsSync(this.tempProfileDir)) {
          fs.rmSync(this.tempProfileDir, { recursive: true, force: true });
        }
      } catch (error) {
        console.error('Error cleaning browser profile dir:', error);
      } finally {
        this.tempProfileDir = null;
      }
    }
  }

  async dispose(): Promise<void> {
    await this.close();
  }
}
