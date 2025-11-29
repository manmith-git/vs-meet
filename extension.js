// extension.js — modular entrypoint (drop-in replacement)
const vscode = require("vscode");
const path = require("path");

// Modular requires (must exist in your repo)
const meetWebview = require("./meet/webview");
const meetHandlers = require("./meet/handlers");
const collabPanel = require("./collab/panel");

function activate(context) {
  // Register Meet command (open recorder webview)
  context.subscriptions.push(
    vscode.commands.registerCommand("meetup.openRecorder", async () => {
      const panel = vscode.window.createWebviewPanel(
        "cameraRecorder",
        "VS Code Meet",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.file(path.join(context.extensionPath, "media")),
            vscode.Uri.file(path.join(context.extensionPath, "meet")),
          ],
        }
      );

      // try to get HTML from meet/webview.js
      try {
        if (typeof meetWebview.getWebviewContent === "function") {
          panel.webview.html = await meetWebview.getWebviewContent(panel, context);
        } else {
          panel.webview.html = "<h3>Meet UI unavailable (getWebviewContent missing)</h3>";
        }
      } catch (err) {
        console.error("[meet] getWebviewContent error:", err);
        panel.webview.html = `<h3>Failed to load Meet UI</h3><pre>${String(err)}</pre>`;
      }

      // wire messages from webview to meet/handlers.handleMessage
      const recv = panel.webview.onDidReceiveMessage(
        async (message) => {
          try {
            if (meetHandlers && typeof meetHandlers.handleMessage === "function") {
              await meetHandlers.handleMessage(message, panel, context);
            } else {
              console.warn("[meet] handleMessage not implemented in meet/handlers.js");
            }
          } catch (e) {
            console.error("[meet] handleMessage error:", e);
          }
        },
        undefined,
        context.subscriptions
      );

      // on dispose, notify handlers to cleanup
      panel.onDidDispose(() => {
        try {
          if (meetHandlers && typeof meetHandlers.onPanelDispose === "function") {
            meetHandlers.onPanelDispose(panel);
          }
        } catch (e) {
          console.warn("[meet] onPanelDispose error", e);
        }
        try {
          if (meetHandlers && typeof meetHandlers.cleanup === "function") {
            meetHandlers.cleanup();
          }
        } catch (e) {
          console.warn("[meet] cleanup error", e);
        }
      }, null, context.subscriptions);
    })
  );

  // Register Collab command
  context.subscriptions.push(
    vscode.commands.registerCommand("webrtcCollab.start", () => {
      try {
        if (collabPanel && typeof collabPanel.openCollabPanel === "function") {
          collabPanel.openCollabPanel(context);
        } else {
          vscode.window.showErrorMessage("Collab panel is not available (openCollabPanel missing).");
        }
      } catch (e) {
        console.error("[collab] openCollabPanel error:", e);
        vscode.window.showErrorMessage("Failed to open collab panel");
      }
    })
  );

  // Status bar: Meet
  const meetButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  meetButton.text = `$(device-camera-video) Meet`;
  meetButton.tooltip = "Open VS Meet (Video + Audio)";
  meetButton.command = "meetup.openRecorder";
  meetButton.show();
  context.subscriptions.push(meetButton);

  // Status bar: Collab
  const collabButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  collabButton.text = `$(group-by-ref-type) Collaborate`;
  collabButton.tooltip = "Open Collaborative Coding Panel";
  collabButton.command = "webrtcCollab.start";
  collabButton.show();
  context.subscriptions.push(collabButton);
}

function deactivate() {
  try {
    if (meetHandlers && typeof meetHandlers.cleanup === "function") {
      meetHandlers.cleanup();
    }
  } catch (e) {
    console.warn("[meet] cleanup failed on deactivate", e);
  }

  try {
    if (collabPanel && typeof collabPanel.collabCleanup === "function") {
      collabPanel.collabCleanup();
    } else if (collabPanel && typeof collabPanel.cleanup === "function") {
      collabPanel.cleanup();
    }
  } catch (e) {
    console.warn("[collab] cleanup failed on deactivate", e);
  }
}

module.exports = { activate, deactivate };
