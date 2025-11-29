const vscode = require("vscode");
const webview = require("./webview");
const handlers = require("./handlers");

function activateMeet(context) {
  const disposable = vscode.commands.registerCommand(
    "meetup.openRecorder",
    async () => {
      const panel = vscode.window.createWebviewPanel(
        "cameraRecorder",
        "VS Code Meet",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      panel.webview.html = await webview.getWebviewContent(panel);

      panel.webview.onDidReceiveMessage(
        async (msg) => handlers.handleMessage(msg, panel),
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(() => handlers.cleanup(), null, context.subscriptions);
    }
  );

  context.subscriptions.push(disposable);
}

function deactivateMeet() {
  const handlers = require("./handlers");
  handlers.cleanup();
}

module.exports = { activateMeet, deactivateMeet };
