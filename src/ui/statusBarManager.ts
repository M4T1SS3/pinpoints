import * as vscode from 'vscode';

type PickerState = 'idle' | 'starting' | 'active';

export class StatusBarManager {
  private mainStatus: vscode.StatusBarItem;

  constructor() {
    // Create status bar item on the RIGHT side (Priority 100 puts it near other main extensions)
    this.mainStatus = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.mainStatus.name = 'PinPoint Status';
    this.initializeDefaults();
  }

  private initializeDefaults() {
    this.mainStatus.text = '$(pinpoint-logo) PinPoint';
    this.mainStatus.command = 'pinpoints.startPicker';
    this.mainStatus.tooltip = 'Click to start element picker';
    // Default color (gray/white depending on theme)
    this.mainStatus.color = undefined; 
  }

  show() {
    this.mainStatus.show();
  }

  hide() {
    this.mainStatus.hide();
  }

  update(state: PickerState, text: string) {
    if (state === 'active') {
      this.mainStatus.text = '$(pinpoint-logo) PinPoint Active';
      this.mainStatus.command = 'pinpoints.stopPicker';
      this.mainStatus.tooltip = 'Click to stop picker (Esc to cancel)';
      // Active color: Bright Green/Amber to match brand
      this.mainStatus.color = '#ABFF06'; 
      this.mainStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (state === 'starting') {
      this.mainStatus.text = '$(loading~spin) PinPoint';
      this.mainStatus.color = undefined;
      this.mainStatus.backgroundColor = undefined;
    } else {
      // Idle state: Grayed out / default color
      this.mainStatus.text = '$(pinpoint-logo) PinPoint';
      this.mainStatus.command = 'pinpoints.startPicker';
      this.mainStatus.tooltip = 'Click to start element picker';
      this.mainStatus.color = new vscode.ThemeColor('statusBar.foreground'); // Use theme foreground (usually gray/white)
      this.mainStatus.backgroundColor = undefined;
    }
  }

  // Legacy methods (no-op now as modes are handled in toolbar)
  updateModeIndicator(mode: string) {}
  updateScreenshotIndicator(enabled: boolean) {}

  dispose() {
    this.mainStatus.dispose();
  }
}
