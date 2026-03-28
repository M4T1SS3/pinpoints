import * as fs from 'fs';
import * as path from 'path';
import { Identity, DomContext, SourceLocation } from '../schemas';

export interface WorkspaceFileProvider {
  listSourceFiles(): Promise<string[]>;
  readText(filePath: string): Promise<string>;
}

export class NodeWorkspaceFileProvider implements WorkspaceFileProvider {
  private readonly sourceExtensions = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.html', '.ts', '.js']);
  private readonly ignoredDirectories = new Set([
    'node_modules',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'out',
    '.git',
  ]);

  constructor(private readonly workspaceRoot: string) {}

  async listSourceFiles(): Promise<string[]> {
    if (!this.workspaceRoot || !fs.existsSync(this.workspaceRoot)) {
      return [];
    }

    const files: string[] = [];
    await this.walk(this.workspaceRoot, files);
    return files;
  }

  async readText(filePath: string): Promise<string> {
    return await fs.promises.readFile(filePath, 'utf-8');
  }

  private async walk(dir: string, outFiles: string[]): Promise<void> {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.ignoredDirectories.has(entry.name)) {
          continue;
        }
        await this.walk(entryPath, outFiles);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (this.sourceExtensions.has(ext)) {
        outFiles.push(entryPath);
      }
    }
  }
}

interface Signal {
  text: string;
  weight: number;
  method: SourceLocation['method'];
}

interface FileMatch {
  filePath: string;
  line: number;
  score: number;
  signalCount: number;
  method: SourceLocation['method'];
}

// Tailwind-like utility patterns to skip
const UTILITY_CLASS_PATTERN = /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|m[trblxy]?-|p[trblxy]?-|w-|h-|min-|max-|text-|font-|bg-|border-|rounded-|shadow-|opacity-|z-|gap-|space-|overflow-|cursor-|transition-|duration-|ease-|animate-|transform|scale-|rotate-|translate-|skew-|origin-|items-|justify-|self-|place-|col-|row-|order-|float-|clear-|object-|aspect-|columns-|break-|decoration-|list-|leading-|tracking-|align-|whitespace-|underline|line-through|no-underline|sr-only|not-sr-only|dark:|hover:|focus:|active:|disabled:|sm:|md:|lg:|xl:|2xl:)/;

// CSS Modules / styled-components generated class patterns
const GENERATED_CLASS_PATTERN = /^(sc-|css-|_[a-zA-Z]+_[a-z0-9]{4,}_|[a-zA-Z]+__[a-zA-Z]+-{2}[a-zA-Z0-9]+)/;

export class WorkspaceGrep {
  constructor(private readonly fileProvider: WorkspaceFileProvider) {}

  async search(identity: Identity, dom: DomContext): Promise<SourceLocation | undefined> {
    const signals = this.buildSignals(identity, dom);
    if (signals.length === 0) return undefined;

    const sourceFiles = await this.fileProvider.listSourceFiles();

    if (sourceFiles.length === 0) return undefined;

    const matches: FileMatch[] = [];

    // Search files for signals — limit to first 200 files to avoid slowness
    const filesToSearch = sourceFiles.slice(0, 200);

    for (const filePath of filesToSearch) {
      const fileMatches = await this.searchFile(filePath, signals);
      if (fileMatches.length > 0) {
        matches.push(...fileMatches);
      }
    }

    if (matches.length === 0) return undefined;

    // Group by file and score
    return this.pickBestMatch(matches);
  }

  buildSignals(identity: Identity, dom: DomContext): Signal[] {
    const signals: Signal[] = [];

    // data-testid, data-test, data-qa (highest priority)
    if (identity.dataAttributes) {
      for (const [attr, value] of Object.entries(identity.dataAttributes)) {
        if (['data-testid', 'data-test', 'data-qa'].includes(attr)) {
          signals.push({ text: value, weight: 10, method: 'grep-data-attr' });
        }
      }
    }

    // Stable ID
    if (identity.id && !this.isGeneratedId(identity.id)) {
      signals.push({ text: identity.id, weight: 8, method: 'grep-id' });
    }

    // aria-label
    if (identity.ariaLabel && identity.ariaLabel.length >= 3) {
      signals.push({ text: identity.ariaLabel, weight: 7, method: 'grep-aria' });
    }

    // Short text content (likely written literally in source)
    if (identity.text && identity.text.length >= 3 && identity.text.length <= 50) {
      signals.push({ text: identity.text, weight: 5, method: 'grep-text' });
    }

    // Semantic class names (skip utilities and generated)
    for (const cls of identity.classes) {
      if (!UTILITY_CLASS_PATTERN.test(cls) && !GENERATED_CLASS_PATTERN.test(cls) && cls.length >= 3) {
        signals.push({ text: cls, weight: 3, method: 'grep-class' });
      }
    }

    return signals;
  }

  private isGeneratedId(id: string): boolean {
    // Skip UUIDs, base64-ish, random hashes
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(id)) return true;
    if (/^[a-zA-Z0-9+/]{20,}/.test(id)) return true;
    if (/^:r[0-9a-z]+:$/.test(id)) return true; // React useId
    return false;
  }

  private async searchFile(filePath: string, signals: Signal[]): Promise<FileMatch[]> {
    try {
      const content = await this.fileProvider.readText(filePath);

      // Penalize test/story files
      const isTestFile = /\.(test|spec|stories|story)\.[jt]sx?$/.test(filePath);

      const matches: FileMatch[] = [];
      const lines = content.split('\n');

      for (const signal of signals) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(signal.text)) {
            const weight = isTestFile ? signal.weight * 0.3 : signal.weight;
            matches.push({
              filePath,
              line: i + 1,
              score: weight,
              signalCount: 1,
              method: signal.method,
            });
            break; // One match per signal per file
          }
        }
      }

      return matches;
    } catch {
      return [];
    }
  }

  private pickBestMatch(matches: FileMatch[]): SourceLocation | undefined {
    // Group by file
    const byFile = new Map<string, FileMatch[]>();
    for (const m of matches) {
      const existing = byFile.get(m.filePath) || [];
      existing.push(m);
      byFile.set(m.filePath, existing);
    }

    let bestFile = '';
    let bestScore = 0;
    let bestLine = 1;
    let bestMethod: SourceLocation['method'] = 'grep-text';

    for (const [filePath, fileMatches] of byFile) {
      let totalScore = fileMatches.reduce((sum, m) => sum + m.score, 0);

      // Bonus for multiple signals in same file
      if (fileMatches.length > 1) {
        totalScore *= 1 + fileMatches.length * 0.2;

        // Extra bonus for proximity (signals within 20 lines)
        const lines = fileMatches.map(m => m.line).sort((a, b) => a - b);
        const spread = lines[lines.length - 1] - lines[0];
        if (spread < 20) {
          totalScore *= 1.5;
        }
      }

      // File path heuristics
      if (/\/(components|pages|views|app|src)\//.test(filePath)) {
        totalScore *= 1.1;
      }

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestFile = filePath;
        // Use the line from the highest-weight match
        const topMatch = fileMatches.reduce((a, b) => a.score > b.score ? a : b);
        bestLine = topMatch.line;
        bestMethod = topMatch.method;
      }
    }

    if (!bestFile) return undefined;

    return {
      filePath: bestFile,
      line: bestLine,
      confidence: Math.min(0.85, bestScore / 15),
      method: bestMethod,
    };
  }
}
