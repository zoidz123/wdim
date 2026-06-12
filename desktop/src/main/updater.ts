import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "downloading"; version: string }
  | { state: "ready"; version: string }
  | { state: "error"; detail: string };

type UpdateListener = (status: UpdateStatus) => void;

// Background auto-update against the generic R2 feed (latest-mac.yml next to the
// release artifacts). Downloads happen silently; the renderer only ever sees
// "an update is ready" and asks to install. Errors stay quiet in the UI — a
// failed check just means the user updates on a later cycle.
export class AppUpdater {
  private status: UpdateStatus = { state: "idle" };
  private listeners = new Set<UpdateListener>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly enabled: boolean) {}

  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => this.setStatus({ state: "checking" }));
    autoUpdater.on("update-available", (info) => this.setStatus({ state: "downloading", version: info.version }));
    autoUpdater.on("update-not-available", () => this.setStatus({ state: "idle" }));
    autoUpdater.on("update-downloaded", (info) => this.setStatus({ state: "ready", version: info.version }));
    autoUpdater.on("error", (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn("[updater] update check failed", detail);
      this.setStatus({ state: "error", detail });
    });

    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), UPDATE_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  async checkNow(): Promise<void> {
    if (!this.enabled) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // The error event handler above already records it; never let a failed
      // update check surface as an unhandled rejection.
      console.warn("[updater] checkForUpdates rejected", error instanceof Error ? error.message : String(error));
    }
  }

  installAndRestart(): void {
    if (this.status.state !== "ready") return;
    autoUpdater.quitAndInstall();
  }

  onStatusChange(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
