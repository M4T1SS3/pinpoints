import * as path from 'path';
import { MaxContext, CaptureMode } from '../schemas';

export class ContextFormatter {
  private static readonly MAX_SINGLE_TEXT_CHARS = 140;
  private static readonly MAX_MULTI_TEXT_CHARS = 100;
  private static readonly MAX_SINGLE_HTML_CHARS = 520;
  private static readonly MAX_MULTI_HTML_CHARS = 320;
  private static readonly MAX_STYLE_ENTRIES = 8;

  formatForChat(
    captures: MaxContext[],
    mode: CaptureMode,
    workspaceRoot: string
  ): string {
    if (captures.length === 1) {
      return this.formatSingleElement(captures[0], mode, workspaceRoot);
    } else {
      return this.formatMultipleElements(captures, mode, workspaceRoot);
    }
  }

  private formatSingleElement(
    context: MaxContext,
    mode: CaptureMode,
    workspaceRoot: string
  ): string {
  let text = `# UI Element Context\n\n`;

    // Selector
  text += `## Selected Element\n`;
    text += `**Selector:** \`${context.selectors.primary.selector}\`\n`;
    if (context.identity.role) {
      text += `**Role:** ${context.identity.role}\n`;
    }
    if (context.identity.text) {
      text += `**Text:** ${this.escapeMarkdown(this.truncatePlainText(context.identity.text, ContextFormatter.MAX_SINGLE_TEXT_CHARS))}\n`;
    }
    text += `\n`;

    // Component name
    const componentName = context.reactComponent
      || (context.sourceLocation && this.extractComponentName(context.sourceLocation.filePath));
    if (componentName) {
      text += `**Component:** \`${componentName}\`\n`;
    }

    // DOM
  text += `## Element Structure\n`;
    text += `\`\`\`html\n`;
    text += `${this.compactHtmlPreview(context.dom.element.html, ContextFormatter.MAX_SINGLE_HTML_CHARS)}\n`;
    text += `\`\`\`\n\n`;

    // Layout
  text += `## Layout\n`;
    text += `- **Box:** ${context.layout.bbox.width}px × ${context.layout.bbox.height}px at (${context.layout.bbox.left}px, ${context.layout.bbox.top}px)\n`;
    text += `\n`;

    // Styles
    const styleEntries = this.pickCompactStyleEntries(context.styles.diff, ContextFormatter.MAX_STYLE_ENTRIES);
    if (styleEntries.length > 0) {
  text += `## Key Styles\n`;
      styleEntries.forEach(([prop, value]) => {
        text += `- **${prop}:** \`${value}\`\n`;
      });
      text += `\n`;
    }

    // Source file if detected
    if (context.sourceLocation) {
      const relPath = path.relative(workspaceRoot, context.sourceLocation.filePath);
  text += `## Source File\n`;
      text += `**File:** \`${relPath}\``;
      if (context.sourceLocation.line) {
        text += ` (line ${context.sourceLocation.line})`;
      }
      text += `\n`;
    }

    // Screenshot only in full mode
    if (mode === 'full' && context.visual?.path) {
      const relPath = path.relative(workspaceRoot, context.visual.path);
  text += `## Screenshot\n`;
      text += `@${relPath}\n\n`;
    }

    // Footer for user to add instruction
    text += `---\n`;

    return text;
  }

  private formatMultipleElements(
    contexts: MaxContext[],
    mode: CaptureMode,
    workspaceRoot: string
  ): string {
  let text = `# UI Element Comparison\n\n`;
    text += `**Elements:** ${contexts.length}\n\n`;

    contexts.forEach((context, index) => {
  text += `## Element ${index + 1}\n`;
      text += `**Selector:** \`${context.selectors.primary.selector}\`\n`;

      if (context.identity.text) {
        text += `**Text:** ${this.escapeMarkdown(this.truncatePlainText(context.identity.text, ContextFormatter.MAX_MULTI_TEXT_CHARS))}\n`;
      }

      // Component name
      const componentName = context.reactComponent
        || (context.sourceLocation && this.extractComponentName(context.sourceLocation.filePath));
      if (componentName) {
        text += `**Component:** \`${componentName}\`\n`;
      }

      text += `**Structure:**\n`;
      text += `\`\`\`html\n`;
  text += `${this.compactHtmlPreview(context.dom.element.html, ContextFormatter.MAX_MULTI_HTML_CHARS)}\n`;
      text += `\`\`\`\n\n`;

      // Screenshot only in full mode
      if (mode === 'full' && context.visual?.path) {
        const relPath = path.relative(workspaceRoot, context.visual.path);
        text += `**Screenshot:** @${relPath}\n\n`;
      }

      text += `---\n\n`;
    });

    return text;
  }

  private extractComponentName(filePath: string): string | undefined {
    const basename = path.basename(filePath, path.extname(filePath));
    // Skip index files - not useful as component names
    if (basename === 'index') return undefined;
    // Return PascalCase names (likely React components) or any meaningful name
    return basename;
  }

  private escapeMarkdown(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
  }

  private truncatePlainText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars).trimEnd()}…`;
  }

  private compactHtmlPreview(html: string, maxChars: number): string {
    let compact = html
      .replace(/\s+/g, ' ')
      .replace(/\s(?:style|src|srcset|sizes|loading|decoding|fetchpriority|data-[\w-]+)="[^"]*"/g, '')
      .replace(/\sclass="([^"]+)"/g, (_match, classValue: string) => {
        return ` class="${this.truncatePlainText(classValue, 72)}"`;
      })
      .trim();

    return this.truncatePlainText(compact, maxChars);
  }

  private pickCompactStyleEntries(
    diff: MaxContext['styles']['diff'] | undefined,
    maxEntries: number
  ): Array<[string, string]> {
    if (!diff || Object.keys(diff).length === 0) return [];

    const priority = [
      'display',
      'position',
      'width',
      'height',
      'justify-content',
      'align-items',
      'background-color',
      'color',
      'font-size',
      'font-weight',
      'padding',
      'margin',
    ];

    const selected: Array<[string, string]> = [];

    for (const prop of priority) {
      const value = diff[prop];
      if (value) {
        selected.push([prop, value]);
      }
      if (selected.length >= maxEntries) {
        return selected;
      }
    }

    if (selected.length === 0) {
      return Object.entries(diff).slice(0, maxEntries);
    }

    return selected;
  }
}
