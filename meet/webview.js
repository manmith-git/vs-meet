// meet/webview.js
const fs = require("fs");
const path = require("path");

const SIGNALING_SERVER = "https://voice-collab-room.onrender.com";

async function getWebviewContent(panel, context) {
  // read media/meet.html and replace placeholder for meet.js if present
  const mediaDir = path.join(context.extensionPath, "media");
  const htmlPath = path.join(mediaDir, "meet.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  // replace token SIGNALING_SERVER
  html = html.replace(/\$\{SIGNALING_SERVER\}/g, SIGNALING_SERVER);

  // build webview URI for media/meet.js (so script loads from extension)
  const meetJsOnDisk = path.join(mediaDir, "meet.js");
  const meetJsUri = panel.webview.asWebviewUri(require("vscode").Uri.file(meetJsOnDisk));
  html = html.replace(/MEET_JS_URI/g, meetJsUri.toString());

  // return final html
  return html;
}

module.exports = { getWebviewContent };
