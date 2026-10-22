import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("avatarAPI", {
  onStateChange: (callback: (state: string) => void) => {
    ipcRenderer.on("set-state", (_event, state: string) => callback(state));
  },
  notifyClick: () => ipcRenderer.send("avatar-clicked"),
  zoom: (direction: 1 | -1) => ipcRenderer.send("avatar-zoom", direction),
  showContextMenu: () => ipcRenderer.send("avatar-context-menu"),
  toggleTts: () => ipcRenderer.send("avatar-toggle-tts"),
  toggleHistory: () => ipcRenderer.send("avatar-toggle-history"),
  toggleScreenView: () => ipcRenderer.send("avatar-toggle-screenview"),
  getScreenViewState: () => ipcRenderer.invoke("get-screenview-state"),
  onScreenViewStateChange: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on("screenview-state", (_event, enabled: boolean) => callback(enabled));
  },
  setProvider: (name: "gemini" | "claude" | "local") => ipcRenderer.send("avatar-set-provider", name),
  getProviderState: () => ipcRenderer.invoke("get-provider-state"),
  onProviderStateChange: (callback: (provider: string) => void) => {
    ipcRenderer.on("provider-state", (_event, provider: string) => callback(provider));
  },
  getTtsState: () => ipcRenderer.invoke("get-tts-state"),
  onTtsStateChange: (callback: (state: string) => void) => {
    ipcRenderer.on("tts-state", (_event, state: string) => callback(state));
  },
  onHoverChange: (callback: (hovered: boolean) => void) => {
    ipcRenderer.on("avatar-hover", (_event, hovered: boolean) => callback(hovered));
  },
});
