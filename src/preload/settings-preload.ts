import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("settingsAPI", {
  getScale: () => ipcRenderer.invoke("get-avatar-scale"),
  setScale: (scale: number) => ipcRenderer.send("avatar-set-scale", scale),
  onScaleChanged: (callback: (scale: number) => void) => {
    ipcRenderer.on("scale-changed", (_event, scale: number) => callback(scale));
  },
  getServerInfo: () => ipcRenderer.invoke("get-server-info"),
  copyToClipboard: (text: string) => ipcRenderer.send("copy-to-clipboard", text),
});
