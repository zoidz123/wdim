import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Api } from "telegram";
import { TelegramConnector, type GramTelegramClient, type TelegramSessionCodec } from "./telegram";

const codec: TelegramSessionCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`),
  decryptString: (value) => value.toString().replace(/^enc:/, "")
};

describe("TelegramConnector MTProto login", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wdim-telegram-"));
  });

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("starts QR login and stores the encrypted session after authorization", async () => {
    const fakeClient = new FakeGramClient();
    const connector = new TelegramConnector({
      sessionPath: path.join(tempDir, "telegram-session.json"),
      codec,
      apiId: 123,
      apiHash: "hash",
      createClient: () => fakeClient
    });

    const state = await connector.beginAccountLogin();
    await fakeClient.resolveLogin();

    expect(state.status).toBe("pending");
    if (state.status !== "pending") throw new Error("Expected Telegram login to wait for QR scan.");
    expect(state.loginUrl).toStartWith("tg://login?token=");
    expect(state.qrDataUrl).toStartWith("data:image/png;base64,");
    await waitFor(() => connector.getAuthState().status === "connected");
    expect(await connector.isConnected()).toBe(true);

    const stored = JSON.parse(await fs.readFile(path.join(tempDir, "telegram-session.json"), "utf8")) as { encryptedSession: string };
    expect(Buffer.from(stored.encryptedSession, "base64").toString()).toBe("enc:saved-session");
  });

  test("prompts for Telegram 2FA password after a QR scan requires it", async () => {
    const fakeClient = new TwoFactorQrGramClient();
    const connector = new TelegramConnector({
      sessionPath: path.join(tempDir, "telegram-session.json"),
      codec,
      apiId: 123,
      apiHash: "hash",
      createClient: () => fakeClient
    });

    const state = await connector.beginAccountLogin();
    fakeClient.resolveQrScan();
    await waitFor(() => connector.getAuthState().status === "password_required");
    const authState = connector.getAuthState();

    expect(state.status).toBe("pending");
    expect(authState).toEqual({ status: "password_required", hint: "usual password" });
    await expect(connector.submitPassword("cloud-password")).resolves.toEqual({ status: "connected" });
    expect(fakeClient.password).toBe("cloud-password");
    expect(await connector.isConnected()).toBe(true);
  });

  test("connects with phone number and Telegram login code", async () => {
    const fakeClient = new PhoneLoginGramClient();
    const connector = new TelegramConnector({
      sessionPath: path.join(tempDir, "telegram-session.json"),
      codec,
      apiId: 123,
      apiHash: "hash",
      createClient: () => fakeClient
    });

    expect(await connector.beginPhoneLogin()).toEqual({ status: "phone_required" });
    await expect(connector.submitPhoneNumber("+15551234567")).resolves.toEqual({
      status: "code_required",
      phoneNumber: "+15551234567",
      isCodeViaApp: true
    });
    await expect(connector.submitPhoneCode("12345")).resolves.toEqual({ status: "connected" });

    expect(fakeClient.phoneNumber).toBe("+15551234567");
    expect(fakeClient.phoneCode).toBe("12345");
    expect(await connector.isConnected()).toBe(true);
  });

  test("does not block connection state while waiting for Telegram 2FA password", async () => {
    const fakeClient = new PhoneLoginWithPasswordGramClient();
    const connector = new TelegramConnector({
      sessionPath: path.join(tempDir, "telegram-session.json"),
      codec,
      apiId: 123,
      apiHash: "hash",
      createClient: () => fakeClient
    });

    await connector.beginPhoneLogin();
    await connector.submitPhoneNumber("+15551234567");
    await expect(connector.submitPhoneCode("12345")).resolves.toEqual({ status: "password_required", hint: "usual password" });

    await expect(connector.isConnected()).resolves.toBe(false);
  });

  test("maps dialogs to selectable chats", async () => {
    const fakeClient = new FakeGramClient();
    fakeClient.dialogFilters = [
      new Api.DialogFilter({
        id: 2,
        title: new Api.TextWithEntities({ text: "Crypto", entities: [] }),
        groups: true,
        pinnedPeers: [],
        includePeers: [new Api.InputPeerChannel({ channelId: "30" as never, accessHash: "1" as never })],
        excludePeers: []
      })
    ];
    fakeClient.dialogs = [
      { id: "10", title: "Maya", isUser: true, isGroup: false, isChannel: false, inputEntity: "maya" },
      { id: "20", title: "Launch group", isUser: false, isGroup: true, isChannel: false, inputEntity: "launch", participantsCount: 12 },
      { id: "30", title: "Announcements", isUser: false, isGroup: false, isChannel: true, inputEntity: "announcements", username: "launch_news" }
    ];
    const connector = connectedConnector(tempDir, fakeClient);

    const chats = await connector.listAccountChats();

    expect(chats).toEqual([
      { id: "user:10", title: "Maya", enabled: true, kind: "dm", username: undefined, memberCount: undefined, folders: [], peerKey: "user:10", inputEntity: "maya" },
      { id: "chat:20", title: "Launch group", enabled: false, kind: "group", username: undefined, memberCount: 12, folders: ["Crypto"], peerKey: "chat:20", inputEntity: "launch" },
      { id: "channel:30", title: "Announcements", enabled: false, kind: "channel", username: "launch_news", memberCount: undefined, folders: ["Crypto"], peerKey: "channel:30", inputEntity: "announcements" }
    ]);
  });

  test("fetches selected chat history as Telegram events", async () => {
    const fakeClient = new FakeGramClient();
    fakeClient.messagesByEntity.set("launch", [
      { id: 7, message: "Can you review the launch note?", date: 1_780_000_000, senderId: "42", mentioned: true },
      { id: 6, message: "", date: 1_779_999_000, senderId: "43" }
    ]);
    const connector = connectedConnector(tempDir, fakeClient);

    const messages = await connector.fetchRecentMessages({
      chats: [{ id: "chat:20", title: "Launch group", enabled: true, kind: "group", inputEntity: "launch" }],
      includeDms: false,
      limitPerChat: 25
    });

    expect(messages).toEqual([
      {
        id: "telegram:chat:20:7",
        chatId: "chat:20",
        chat: "Launch group",
        sender: "42",
        text: "Can you review the launch note?",
        sentAt: "2026-05-28T20:26:40.000Z",
        direct: false,
        mentionedMe: true
      }
    ]);
    expect(fakeClient.requestedHistory).toEqual([{ entity: "launch", limit: 25 }]);
  });

  test("keeps only messages inside the scan window", async () => {
    const fakeClient = new FakeGramClient();
    fakeClient.messagesByEntity.set("launch", [
      { id: 8, message: "New launch note", date: 1_780_006_000, senderId: "42" },
      { id: 7, message: "Old launch note", date: 1_780_000_000, senderId: "42" }
    ]);
    const connector = connectedConnector(tempDir, fakeClient);

    const messages = await connector.fetchRecentMessages({
      chats: [{ id: "chat:20", title: "Launch group", enabled: true, kind: "group", inputEntity: "launch" }],
      includeDms: false,
      limitPerChat: 25,
      since: "2026-05-28T21:00:00.000Z"
    });

    expect(messages.map((message) => message.text)).toEqual(["New launch note"]);
  });

  test("fetches included DMs from live dialogs instead of saved peer ids", async () => {
    const fakeClient = new FakeGramClient();
    fakeClient.dialogs = [
      { id: "10", title: "Maya", isUser: true, isGroup: false, isChannel: false, inputEntity: "maya-input", username: "maya" }
    ];
    fakeClient.messagesByEntity.set("maya-input", [
      { id: 3, message: "Can you review this?", date: 1_780_000_000, senderId: "10" }
    ]);
    const connector = connectedConnector(tempDir, fakeClient);

    const messages = await connector.fetchRecentMessages({
      chats: [{ id: "user:10", title: "Maya", enabled: true, kind: "dm", peerKey: "user:10" }],
      includeDms: true,
      limitPerChat: 10
    });

    expect(messages[0]?.text).toBe("Can you review this?");
    expect(messages[0]?.direct).toBe(true);
    expect(messages[0]?.sourceUrl).toBe("tg://resolve?domain=maya");
    expect(fakeClient.requestedHistory).toEqual([{ entity: "maya-input", limit: 10 }]);
  });

  test("skips selected chats that cannot be resolved to a live or saved input entity", async () => {
    const fakeClient = new FakeGramClient();
    fakeClient.dialogs = [];
    const connector = connectedConnector(tempDir, fakeClient);

    const messages = await connector.fetchRecentMessages({
      chats: [{ id: "chat:-4725061802", title: "Felix x Pluto", enabled: true, kind: "group", peerKey: "chat:-4725061802" }],
      includeDms: false,
      limitPerChat: 25
    });

    expect(messages).toEqual([]);
    expect(fakeClient.requestedHistory).toEqual([]);
  });

  test("caps included DM history requests to the most recent direct dialogs", async () => {
    const fakeClient = new FakeGramClient();
    fakeClient.dialogs = [
      { id: "10", title: "Maya", isUser: true, isGroup: false, isChannel: false, inputEntity: "maya-input" },
      { id: "11", title: "Noah", isUser: true, isGroup: false, isChannel: false, inputEntity: "noah-input" },
      { id: "12", title: "Ari", isUser: true, isGroup: false, isChannel: false, inputEntity: "ari-input" }
    ];
    const connector = connectedConnector(tempDir, fakeClient);

    await connector.fetchRecentMessages({
      chats: [],
      includeDms: true,
      limitPerChat: 10,
      maxDirectChats: 2
    });

    expect(fakeClient.requestedHistory).toEqual([
      { entity: "maya-input", limit: 10 },
      { entity: "noah-input", limit: 10 }
    ]);
  });
});

function connectedConnector(tempDir: string, client: FakeGramClient): TelegramConnector {
  return new TelegramConnector({
    sessionPath: path.join(tempDir, "telegram-session.json"),
    codec,
    apiId: 123,
    apiHash: "hash",
    createClient: () => client,
    initialSession: "saved-session"
  });
}

class FakeGramClient implements GramTelegramClient {
  dialogs: Array<{ id: string; title: string; isUser: boolean; isGroup: boolean; isChannel: boolean; inputEntity: string; username?: string; participantsCount?: number }> = [];
  dialogFilters: unknown[] = [];
  messagesByEntity = new Map<string, Array<{ id: number; message: string; date: number; senderId?: string; mentioned?: boolean }>>();
  requestedHistory: Array<{ entity: unknown; limit: number | undefined }> = [];
  protected loginResolve: (() => void) | null = null;

  async connect(): Promise<void> {}

  async signInUserWithQrCode(_credentials: unknown, params: { qrCode?: (qrCode: { token: Buffer; expires: number }) => Promise<void> }): Promise<unknown> {
    await params.qrCode?.({ token: Buffer.from("login-token"), expires: 1_780_000_000 });
    await new Promise<void>((resolve) => {
      this.loginResolve = resolve;
    });
    return {};
  }

  resolveLogin(): void {
    this.loginResolve?.();
  }

  session = {
    save: () => "saved-session"
  };

  async getDialogs(): Promise<unknown[]> {
    return this.dialogs;
  }

  async getMessages(entity: unknown, params?: { limit?: number }): Promise<unknown[]> {
    this.requestedHistory.push({ entity, limit: params?.limit });
    return this.messagesByEntity.get(String(entity)) ?? [];
  }

  async invoke(request: unknown): Promise<unknown> {
    if (request instanceof Api.messages.GetDialogFilters) {
      return new Api.messages.DialogFilters({ filters: this.dialogFilters as never });
    }
    return {};
  }

  disconnect(): void {}
}

class TwoFactorQrGramClient extends FakeGramClient {
  password: string | null = null;

  async signInWithPassword(
    _credentials: unknown,
    params: { password?: (hint?: string) => Promise<string> }
  ): Promise<unknown> {
    this.password = await params.password?.("usual password") ?? null;
    return {};
  }

  resolveQrScan(): void {
    this.resolveLogin();
  }

  async signInUserWithQrCode(
    _credentials: unknown,
    params: {
      qrCode?: (qrCode: { token: Buffer; expires: number }) => Promise<void>;
      password?: (hint?: string) => Promise<string>;
    }
  ): Promise<unknown> {
    await params.qrCode?.({ token: Buffer.from("login-token"), expires: 1_780_000_000 });
    await new Promise<void>((resolve) => {
      this.loginResolve = resolve;
    });
    this.password = await params.password?.("usual password") ?? null;
    return {};
  }
}

class PhoneLoginGramClient extends FakeGramClient {
  phoneNumber: string | null = null;
  phoneCode: string | null = null;

  async invoke(request: unknown): Promise<unknown> {
    if (request instanceof Api.auth.SendCode) {
      this.phoneNumber = request.phoneNumber;
      return new Api.auth.SentCode({
        type: new Api.auth.SentCodeTypeApp({ length: 5 }),
        phoneCodeHash: "phone-code-hash"
      });
    }
    if (request instanceof Api.auth.SignIn) {
      this.phoneCode = request.phoneCode ?? null;
      return new Api.auth.Authorization({
        user: new Api.User({
          id: "1" as never,
          accessHash: "1" as never,
          firstName: "Test"
        })
      });
    }
    return {};
  }
}

class PhoneLoginWithPasswordGramClient extends PhoneLoginGramClient {
  async invoke(request: unknown): Promise<unknown> {
    if (request instanceof Api.auth.SignIn) {
      const error = new Error("SESSION_PASSWORD_NEEDED") as Error & { errorMessage?: string };
      error.errorMessage = "SESSION_PASSWORD_NEEDED";
      throw error;
    }
    return super.invoke(request);
  }

  async signInWithPassword(
    _credentials: unknown,
    params: { password?: (hint?: string) => Promise<string> }
  ): Promise<unknown> {
    await params.password?.("usual password");
    return {};
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("Timed out waiting for predicate.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
