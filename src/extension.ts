import * as vscode from 'vscode';
import { PickerController } from './picker/pickerController';
import { StatusBarManager } from './ui/statusBarManager';

let pickerController: PickerController | undefined;
let statusBarManager: StatusBarManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('PinPoints extension activated');

  // Initialize managers
  statusBarManager = new StatusBarManager();
  pickerController = new PickerController(context);

  // Register commands
  const startPickerCmd = vscode.commands.registerCommand(
    'pinpoints.startPicker',
    async () => {
      if (!pickerController) return;
      try {
        statusBarManager?.update('starting', '$(loading~spin) Starting picker...');
        await pickerController.startPicker();
        statusBarManager?.update('active', '$(circle-filled~spin) Picker active');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to start picker: ${error}`);
        statusBarManager?.update('idle', '$(circle-outline) PinPoints');
      }
    }
  );

  const stopPickerCmd = vscode.commands.registerCommand(
    'pinpoints.stopPicker',
    async () => {
      if (!pickerController) return;
      try {
        await pickerController.stopPicker();
        statusBarManager?.update('idle', '$(circle-outline) PinPoints');
        vscode.window.showInformationMessage('Picker stopped');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to stop picker: ${error}`);
      }
    }
  );

  const clearSelectionCmd = vscode.commands.registerCommand(
    'pinpoints.clearSelection',
    async () => {
      if (!pickerController) return;
      pickerController.clearSelection();
      vscode.window.showInformationMessage('Selection cleared');
    }
  );

  context.subscriptions.push(
    startPickerCmd,
    stopPickerCmd,
    clearSelectionCmd
  );

  // Show welcome message
  const hasSeenWelcome = context.globalState.get('pinpoints.seenWelcome');
  if (!hasSeenWelcome) {
    vscode.window.showInformationMessage(
      'PinPoints: Hover and click UI elements to capture context for Claude'
    );
    context.globalState.update('pinpoints.seenWelcome', true);
  }

  statusBarManager?.show();
}

export function deactivate() {
  console.log('PinPoints extension deactivating');
  if (pickerController) {
    pickerController.cleanup();
  }
}
