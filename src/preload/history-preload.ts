import { contextBridge, ipcRenderer } from "electron";

interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  emotion?: string;
  timestamp: number;
  source?: string;
  model?: string;
  hasPhotoAttachment?: boolean;
  hasScreenView?: boolean;
}

contextBridge.exposeInMainWorld("historyAPI", {
  getHistory: (): Promise<StoredTurn[]> => ipcRenderer.invoke("get-history"),
  onOpen: (callback: () => void) => {
    ipcRenderer.on("history-open", () => callback());
  },
  close: () => ipcRenderer.send("avatar-toggle-history"),
});
