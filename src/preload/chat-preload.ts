import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("chatAPI", {
  sendMessage: (text: string) => ipcRenderer.invoke("send-message", text),
  getHistory: () => ipcRenderer.invoke("get-history"),
  getDreamingState: (): Promise<boolean> => ipcRenderer.invoke("get-dreaming-state"),
  onDreamingStateChange: (callback: (dreaming: boolean) => void) => {
    ipcRenderer.on("dreaming-state", (_event, dreaming: boolean) => callback(dreaming));
  },
  // Broadcasts turns that arrived via the phone app while this window is
  // open (see chat-service.ts's onTurnAppended) - the window's own sends are
  // already rendered locally and are never re-sent over this channel.
  onTurnAdded: (
    callback: (turn: {
      role: string;
      text: string;
      source?: string;
      model?: string;
      hasPhotoAttachment?: boolean;
      hasScreenView?: boolean;
    }) => void
  ) => {
    ipcRenderer.on("chat-turn", (_event, turn) => callback(turn));
  },
});
