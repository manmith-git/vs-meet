const vscode = require("vscode");
const panel = require("./panel");

function activateCollab(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("webrtcCollab.start", () => {
      panel.openCollabPanel(context);
    })
  );
}

function deactivateCollab() {
  try { panel.collabCleanup(); } catch {}
}

module.exports = { activateCollab, deactivateCollab };
