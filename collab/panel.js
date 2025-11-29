// collab/panel.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

let collabPanel = null;
let collabApplyingRemote = false;
let collabSubs = [];

let collabMyId = "";
let collabMyName = "";
let collabMyColor = "";

const collabCursorDecorations = new Map();
let collabAutosaveTimer = null;
const COLLAB_AUTOSAVE_DELAY_MS = 2000;

function collabMakeId() {
  return (Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffff).toString(16));
}

function collabHexToRgba(hex, alpha = 0.22) {
  if (!hex || hex[0] !== "#" || (hex.length !== 7 && hex.length !== 4)) return `rgba(0,0,0,${alpha})`;
  if (hex.length === 4) {
    const r = parseInt(hex[1] + hex[1], 16);
    const g = parseInt(hex[2] + hex[2], 16);
    const b = parseInt(hex[3] + hex[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function collabScheduleAutosave(document) {
  if (!document) return;
  if (collabAutosaveTimer) clearTimeout(collabAutosaveTimer);
  collabAutosaveTimer = setTimeout(() => {
    collabAutosaveTimer = null;
    if (document.isDirty) document.save().catch(() => {});
  }, COLLAB_AUTOSAVE_DELAY_MS);
}

function collabRandRoom(len = 9) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s.toUpperCase();
}

function openCollabPanel(context) {
  if (collabPanel) { collabPanel.reveal(vscode.ViewColumn.Beside); return; }

  vscode.window.showInputBox({ prompt: "Enter display name for collaboration", placeHolder: "e.g. Anubhav" }).then((typed) => {
    collabMyName = (typed && typed.trim()) || `User-${Math.floor(Math.random() * 9000 + 1000)}`;
    collabMyId = collabMakeId();
    const COLORS = ["#ff5555","#55ff55","#5599ff","#ffb86c","#bd93f9","#f1fa8c","#ff79c6"];
    collabMyColor = COLORS[Math.floor(Math.random() * COLORS.length)];

    collabPanel = vscode.window.createWebviewPanel("webrtcCollab","WebRTC Collab (Yjs)",vscode.ViewColumn.Beside,{
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))],
    });

    const mediaDir = path.join(context.extensionPath, "media");
    const yjsOnDisk = path.join(mediaDir, "yjs.js");
    const collabJsOnDisk = path.join(mediaDir, "collab.js");

    const yjsUri = collabPanel.webview.asWebviewUri(vscode.Uri.file(yjsOnDisk));
    const collabJsUri = collabPanel.webview.asWebviewUri(vscode.Uri.file(collabJsOnDisk));

    const htmlPath = path.join(mediaDir, "collab.html");
    let html = fs.readFileSync(htmlPath, "utf8");

    // Replace placeholders: keep your existing placeholders but also inject a default room
    html = html.replace(/YJS_URI/g, yjsUri.toString());
    html = html.replace(/COLLAB_JS_URI/g, collabJsUri.toString());
    html = html.replace(/DEFAULT_ROOM_PLACEHOLDER/g, collabRandRoom());

    // Replace ${cspSource} token in template with actual webview.cspSource
    html = html.replace(/\$\{cspSource\}/g, collabPanel.webview.cspSource);

    collabPanel.webview.html = html;

    const recv = collabPanel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "profile-update" && msg.profile) {
        collabMyColor = msg.profile.color || collabMyColor;
        collabPanel.webview.postMessage({ type: "presence", id: collabMyId, name: collabMyName, color: collabMyColor, forward: true });
        collabPanel.webview.postMessage({ type: "user-list", users: [{ id: collabMyId, name: collabMyName, color: collabMyColor }] });
        return;
      }

      if (msg.type === "copy") {
        try { await vscode.env.clipboard.writeText(msg.text || ""); } catch {}
        return;
      }

      if (msg.type === "dc-open") {
        const editor = vscode.window.activeTextEditor;
        try {
          collabPanel.webview.postMessage({ type: "presence", id: collabMyId, name: collabMyName, color: collabMyColor, forward: true });
          if (msg.role === "host" && editor) {
            const full = editor.document.getText();
            collabPanel.webview.postMessage({ type: "editor-change", text: full, forward: false, source: "vscode-initial" });
          }
        } catch {}
        return;
      }

      if (msg.type === "presence") {
        if (!msg.id || msg.id === collabMyId) return;
        collabPanel.webview.postMessage({ type: "user-list", users: [{ id: msg.id, name: msg.name, color: msg.color }] });
        return;
      }

      if (msg.type === "editor-change") {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const newText = typeof msg.text === "string" ? msg.text : "";
        const currentText = editor.document.getText();
        if (currentText === newText) return;

        collabApplyingRemote = true;
        const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(currentText.length));
        editor.edit((ed) => { ed.replace(fullRange, newText); }).then(() => { collabScheduleAutosave(editor.document); }).finally(() => { collabApplyingRemote = false; });
        return;
      }

      if (msg.type === "cursor") {
        if (!msg.id || msg.id === collabMyId) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const pos = editor.document.positionAt(msg.pos || 0);
        const range = new vscode.Range(pos, pos);
        let dec = collabCursorDecorations.get(msg.id);
        if (!dec) {
          dec = vscode.window.createTextEditorDecorationType({
            border: `2px solid ${msg.color || "#ff79c6"}`,
            backgroundColor: collabHexToRgba(msg.color || "#ff79c6", 0.15),
          });
          collabCursorDecorations.set(msg.id, dec);
        }
        editor.setDecorations(dec, [range]);
        return;
      }

      if (msg.type === "presence-leave") {
        for (const [, dec] of collabCursorDecorations.entries()) {
          try { dec.dispose(); } catch {}
        }
        collabCursorDecorations.clear();
        collabPanel.webview.postMessage({ type: "user-list", users: [] });
        return;
      }
    });

    collabSubs.push(recv);

    let lastCursorSentTime = 0;
    let lastCursorOffset = -1;

    const send = vscode.workspace.onDidChangeTextDocument((ev) => {
      if (!collabPanel || collabApplyingRemote) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || ev.document !== editor.document) return;
      for (const change of ev.contentChanges) {
        collabPanel.webview.postMessage({ type: "editor-delta", offset: change.rangeOffset, removed: change.rangeLength, inserted: change.text, forward: true, source: "vscode" });
      }
    });
    collabSubs.push(send);

    const cursorSend = vscode.window.onDidChangeTextEditorSelection((ev) => {
      if (!collabPanel || collabApplyingRemote) return;
      const editor = ev.textEditor;
      if (!editor) return;
      const pos = editor.document.offsetAt(editor.selection.active);
      const now = Date.now();
      if (now - lastCursorSentTime < 80 && Math.abs(pos - lastCursorOffset) < 1) return;
      lastCursorSentTime = now; lastCursorOffset = pos;
      collabPanel.webview.postMessage({ type: "cursor", pos, id: collabMyId, name: collabMyName, color: collabMyColor, forward: true });
    });
    collabSubs.push(cursorSend);

    collabPanel.onDidDispose(() => collabCleanup());
    collabPanel.webview.postMessage({ type: "user-list", users: [{ id: collabMyId, name: collabMyName, color: collabMyColor }] });
  });
}

function collabCleanup() {
  while (collabSubs.length) { try { collabSubs.pop().dispose(); } catch {} }
  for (const [, dec] of collabCursorDecorations.entries()) { try { dec.dispose(); } catch {} }
  collabCursorDecorations.clear();
  if (collabPanel) {
    try { collabPanel.dispose(); } catch {}
    collabPanel = null;
  }
}

module.exports = { openCollabPanel, collabCleanup };
