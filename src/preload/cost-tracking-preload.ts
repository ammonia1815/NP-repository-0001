import { contextBridge, ipcRenderer } from "electron";

interface DailyGeminiCost {
  date: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  searchQueries: number;
  estimatedCostKrw: number;
}

interface SearchQuotaStatus {
  monthKey: string;
  used: number;
  limit: number;
}

contextBridge.exposeInMainWorld("costTrackingAPI", {
  getHistory: (): Promise<DailyGeminiCost[]> => ipcRenderer.invoke("get-cost-tracking"),
  getSearchQuota: (): Promise<SearchQuotaStatus> => ipcRenderer.invoke("get-search-quota"),
  onOpen: (callback: () => void) => {
    ipcRenderer.on("cost-tracking-open", () => callback());
  },
  close: () => ipcRenderer.send("avatar-toggle-cost-tracking"),
});
