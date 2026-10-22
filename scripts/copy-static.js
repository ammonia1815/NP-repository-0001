const fs = require("fs");
const path = require("path");

const pairs = [
  ["src/renderer/avatar/index.html", "dist/renderer/avatar/index.html"],
  ["src/renderer/avatar/avatar.css", "dist/renderer/avatar/avatar.css"],
  ["src/renderer/chat/index.html", "dist/renderer/chat/index.html"],
  ["src/renderer/chat/chat.css", "dist/renderer/chat/chat.css"],
  ["src/renderer/settings/index.html", "dist/renderer/settings/index.html"],
  ["src/renderer/settings/settings.css", "dist/renderer/settings/settings.css"],
  ["src/renderer/history/index.html", "dist/renderer/history/index.html"],
  ["src/renderer/history/history.css", "dist/renderer/history/history.css"],
  ["src/renderer/cost-tracking/index.html", "dist/renderer/cost-tracking/index.html"],
  ["src/renderer/cost-tracking/cost-tracking.css", "dist/renderer/cost-tracking/cost-tracking.css"],
  ["src/assets/tray-icon.png", "dist/assets/tray-icon.png"],
];

for (const [src, dest] of pairs) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

console.log("Static renderer assets copied to dist/.");
