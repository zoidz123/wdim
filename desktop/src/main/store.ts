import fs from "node:fs/promises";
import path from "node:path";
import type { ConnectorHealth, SourceConnection, SourceCursor } from "./connectors/types";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite";
import type { AppSettings, GmailAccount, ImportantItem, ScanFinding, ScanResult, TelegramChat } from "./types";

type PersistedState = {
  settings: AppSettings;
  accounts: GmailAccount[];
  telegramChats: TelegramChat[];
  scans: ScanResult[];
  importantItems?: ImportantItem[];
  notifiedFindingKeys: string[];
  scannedMessageKeys: string[];
};

type SettingsRow = {
  id: number;
  scan_interval_minutes: number;
  gmail_credentials_path: string | null;
  telegram_export_path: string | null;
  telegram_include_dms: number;
  launch_at_login: number;
  quiet_hours_enabled: number;
  quiet_hours_start: string;
  quiet_hours_end: string;
};

type JsonRow = {
  json: string;
};

type KeyRow = {
  key: string;
};

type ImportantItemRow = {
  json: string;
};

type SourceConnectionRow = {
  id: string;
  source: SourceConnection["source"];
  backend: SourceConnection["backend"];
  label: string;
  account_identifier: string | null;
  external_account_id: string | null;
  enabled: number;
  config_json: string;
  connected_at: string;
  updated_at: string;
};

type SourceCursorRow = {
  connection_id: string;
  cursor_key: string;
  cursor_value: string;
  updated_at: string;
};

type ConnectorHealthRow = {
  connection_id: string;
  status: ConnectorHealth["status"];
  detail: string;
  checked_at: string;
};

const defaultSettings: AppSettings = {
  scanIntervalMinutes: 60,
  gmailCredentialsPath: null,
  telegramExportPath: null,
  telegramIncludeDms: true,
  launchAtLogin: false,
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "07:00"
  }
};

export class AppStore {
  private db: SqliteDatabase | null = null;
  private migrated = false;

  constructor(private readonly legacyStatePath: string) {}

  async load(): Promise<PersistedState> {
    await this.ensureReady();
    return {
      settings: await this.getSettings(),
      accounts: await this.getAccounts(),
      telegramChats: await this.getTelegramChats(),
      scans: await this.getRecentScans(50),
      notifiedFindingKeys: this.getMemoryKeys("notified", 1000),
      scannedMessageKeys: this.getMemoryKeys("scanned", 5000)
    };
  }

  async getSettings(): Promise<AppSettings> {
    await this.ensureReady();
    const row = this.database().prepare("SELECT * FROM settings WHERE id = 1").get() as SettingsRow | undefined;
    if (!row) {
      this.writeSettings(defaultSettings);
      return defaultSettings;
    }

    return normalizeSettings({
      scanIntervalMinutes: row.scan_interval_minutes,
      gmailCredentialsPath: row.gmail_credentials_path,
      telegramExportPath: row.telegram_export_path,
      telegramIncludeDms: Boolean(row.telegram_include_dms),
      launchAtLogin: Boolean(row.launch_at_login),
      quietHours: {
        enabled: Boolean(row.quiet_hours_enabled),
        start: row.quiet_hours_start,
        end: row.quiet_hours_end
      }
    });
  }

  async updateSettings(update: Partial<AppSettings>): Promise<AppSettings> {
    validateSettingsUpdate(update);
    const current = await this.getSettings();
    const settings = normalizeSettings({
      ...current,
      ...update,
      quietHours: {
        ...current.quietHours,
        ...(update.quietHours ?? {})
      }
    });
    this.writeSettings(settings);
    return settings;
  }

  async getAccounts(): Promise<GmailAccount[]> {
    await this.ensureReady();
    return (this.database()
      .prepare("SELECT json FROM accounts ORDER BY rowid DESC")
      .all() as JsonRow[])
      .map((row) => JSON.parse(row.json) as GmailAccount);
  }

  async upsertAccount(account: GmailAccount): Promise<GmailAccount[]> {
    await this.ensureReady();
    this.database()
      .prepare(`
        INSERT INTO accounts (id, email, display_name, connected_at, json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          display_name = excluded.display_name,
          connected_at = excluded.connected_at,
          json = excluded.json
      `)
      .run(account.id, account.email, account.displayName, account.connectedAt, JSON.stringify(account));
    return this.getAccounts();
  }

  async removeAccount(accountId: string): Promise<GmailAccount[]> {
    await this.ensureReady();
    this.database().prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    return this.getAccounts();
  }

  async getTelegramChats(): Promise<TelegramChat[]> {
    await this.ensureReady();
    return (this.database()
      .prepare("SELECT json FROM telegram_chats ORDER BY title COLLATE NOCASE")
      .all() as JsonRow[])
      .map((row) => JSON.parse(row.json) as TelegramChat);
  }

  async replaceTelegramChats(chats: TelegramChat[]): Promise<TelegramChat[]> {
    await this.ensureReady();
    const save = this.database().transaction((items: TelegramChat[]) => {
      this.database().prepare("DELETE FROM telegram_chats").run();
      const insert = this.database().prepare("INSERT INTO telegram_chats (id, title, enabled, kind, json) VALUES (?, ?, ?, ?, ?)");
      for (const chat of items) {
        insert.run(chat.id, chat.title, chat.enabled ? 1 : 0, chat.kind, JSON.stringify(chat));
      }
    });
    save(chats);
    return this.getTelegramChats();
  }

  async addScan(scan: ScanResult): Promise<ScanResult[]> {
    await this.ensureReady();
    this.database()
      .prepare(`
        INSERT OR REPLACE INTO scans (id, started_at, completed_at, status, json)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(scan.id, scan.startedAt, scan.completedAt ?? null, scan.status, JSON.stringify(scan));
    this.database()
      .prepare("DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY rowid DESC LIMIT 50)")
      .run();
    return this.getRecentScans(50);
  }

  async upsertImportantFindings(scan: ScanResult): Promise<ImportantItem[]> {
    await this.ensureReady();
    if (scan.status !== "completed" || !scan.findings.length) return this.getImportantItems();

    this.saveImportantFindings(scan.findings, scan.id, scan.completedAt);
    return this.getImportantItems();
  }

  async getImportantItems(status: ImportantItem["status"] = "active"): Promise<ImportantItem[]> {
    await this.ensureReady();
    return (this.database()
      .prepare("SELECT json FROM important_items WHERE status = ? ORDER BY last_seen_at DESC")
      .all(status) as ImportantItemRow[])
      .map((row) => JSON.parse(row.json) as ImportantItem);
  }

  async updateImportantItemStatus(id: string, status: ImportantItem["status"]): Promise<ImportantItem[]> {
    await this.ensureReady();
    if (!["active", "completed", "dismissed"].includes(status)) {
      throw new Error("Expected important item status to be active, completed, or dismissed.");
    }

    const row = this.database()
      .prepare("SELECT json FROM important_items WHERE id = ?")
      .get(id) as ImportantItemRow | undefined;
    if (!row) throw new Error("That important item is no longer available.");

    const item = {
      ...(JSON.parse(row.json) as ImportantItem),
      status
    };
    this.writeImportantItem(item);
    return this.getImportantItems();
  }

  async getLastScan(): Promise<ScanResult | null> {
    await this.ensureReady();
    const row = this.database().prepare("SELECT json FROM scans ORDER BY rowid DESC LIMIT 1").get() as JsonRow | undefined;
    return row ? JSON.parse(row.json) as ScanResult : null;
  }

  async getLastCompletedScan(): Promise<ScanResult | null> {
    await this.ensureReady();
    const row = this.database()
      .prepare("SELECT json FROM scans WHERE status = 'completed' ORDER BY rowid DESC LIMIT 1")
      .get() as JsonRow | undefined;
    return row ? JSON.parse(row.json) as ScanResult : null;
  }

  async getRecentScans(limit = 5): Promise<ScanResult[]> {
    await this.ensureReady();
    return (this.database()
      .prepare("SELECT json FROM scans ORDER BY rowid DESC LIMIT ?")
      .all(limit) as JsonRow[])
      .map((row) => JSON.parse(row.json) as ScanResult);
  }

  async claimNewNotifiedFindingKeys(keys: string[]): Promise<string[]> {
    await this.ensureReady();
    const existing = new Set(this.getMemoryKeys("notified", 1000));
    const newKeys = [...new Set(keys)].filter((key) => !existing.has(key));
    if (!newKeys.length) return [];

    const insert = this.database().prepare("INSERT OR IGNORE INTO memory_keys (kind, key) VALUES ('notified', ?)");
    const save = this.database().transaction((items: string[]) => {
      for (const key of items) insert.run(key);
      this.trimMemoryKeys("notified", 1000);
    });
    save(newKeys);
    return newKeys;
  }

  async clearNotifiedFindingKeysByPrefix(prefix: string): Promise<void> {
    await this.ensureReady();
    this.database().prepare("DELETE FROM memory_keys WHERE kind = 'notified' AND key LIKE ? ESCAPE '\\'").run(`${escapeLike(prefix)}%`);
  }

  async getScannedMessageKeys(): Promise<string[]> {
    await this.ensureReady();
    return this.getMemoryKeys("scanned", 5000);
  }

  async addScannedMessageKeys(keys: string[]): Promise<string[]> {
    await this.ensureReady();
    const insert = this.database().prepare("INSERT OR IGNORE INTO memory_keys (kind, key) VALUES ('scanned', ?)");
    const save = this.database().transaction((items: string[]) => {
      for (const key of [...new Set(items)]) insert.run(key);
      this.trimMemoryKeys("scanned", 5000);
    });
    save(keys);
    return this.getScannedMessageKeys();
  }

  async clearScannedMessageKeys(keys: string[]): Promise<void> {
    await this.ensureReady();
    if (!keys.length) return;
    const remove = this.database().prepare("DELETE FROM memory_keys WHERE kind = 'scanned' AND key = ?");
    const transaction = this.database().transaction((items: string[]) => {
      for (const key of items) remove.run(key);
    });
    transaction(keys);
  }

  async getDismissedSourceInsightIds(): Promise<string[]> {
    await this.ensureReady();
    return this.getMemoryKeys("dismissed_source_insight", 2000);
  }

  async dismissSourceInsight(id: string): Promise<void> {
    await this.ensureReady();
    this.database()
      .prepare("INSERT OR IGNORE INTO memory_keys (kind, key) VALUES ('dismissed_source_insight', ?)")
      .run(id);
    this.trimMemoryKeys("dismissed_source_insight", 2000);
  }

  async getDismissedDigestCardIds(): Promise<string[]> {
    await this.ensureReady();
    return this.getMemoryKeys("dismissed_digest_card", 2000);
  }

  async dismissDigestCard(id: string): Promise<void> {
    await this.ensureReady();
    this.database()
      .prepare("INSERT OR IGNORE INTO memory_keys (kind, key) VALUES ('dismissed_digest_card', ?)")
      .run(id);
    this.trimMemoryKeys("dismissed_digest_card", 2000);
  }

  async saveSourceConnection(connection: SourceConnection): Promise<void> {
    await this.ensureReady();
    this.database()
      .prepare(`
        INSERT INTO source_connections (
          id,
          source,
          backend,
          label,
          account_identifier,
          external_account_id,
          enabled,
          config_json,
          connected_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source = excluded.source,
          backend = excluded.backend,
          label = excluded.label,
          account_identifier = excluded.account_identifier,
          external_account_id = excluded.external_account_id,
          enabled = excluded.enabled,
          config_json = excluded.config_json,
          connected_at = excluded.connected_at,
          updated_at = excluded.updated_at
      `)
      .run(
        connection.id,
        connection.source,
        connection.backend,
        connection.label,
        connection.accountIdentifier,
        connection.externalAccountId,
        connection.enabled ? 1 : 0,
        JSON.stringify(connection.config),
        connection.connectedAt,
        connection.updatedAt
      );
  }

  async listSourceConnections(): Promise<SourceConnection[]> {
    await this.ensureReady();
    return (this.database()
      .prepare("SELECT * FROM source_connections ORDER BY rowid ASC")
      .all() as SourceConnectionRow[])
      .map(sourceConnectionFromRow);
  }

  async updateSourceConnectionConfig(id: string, config: Record<string, unknown>): Promise<SourceConnection> {
    await this.ensureReady();
    const existing = await this.getSourceConnection(id);
    if (!existing) throw new Error("That source connection is no longer available.");

    const updated = {
      ...existing,
      config,
      updatedAt: new Date().toISOString()
    };
    await this.saveSourceConnection(updated);
    return updated;
  }

  async getSourceConnection(id: string): Promise<SourceConnection | null> {
    await this.ensureReady();
    const row = this.database()
      .prepare("SELECT * FROM source_connections WHERE id = ?")
      .get(id) as SourceConnectionRow | undefined;
    return row ? sourceConnectionFromRow(row) : null;
  }

  async removeSourceConnection(id: string): Promise<void> {
    await this.ensureReady();
    const remove = this.database().transaction((connectionId: string) => {
      this.database().prepare("DELETE FROM source_connections WHERE id = ?").run(connectionId);
      this.database().prepare("DELETE FROM source_cursors WHERE connection_id = ?").run(connectionId);
      this.database().prepare("DELETE FROM source_health WHERE connection_id = ?").run(connectionId);
    });
    remove(id);
  }

  async clearSourceCursors(connectionId: string): Promise<void> {
    await this.ensureReady();
    this.database().prepare("DELETE FROM source_cursors WHERE connection_id = ?").run(connectionId);
  }

  async saveSourceCursors(cursors: SourceCursor[]): Promise<void> {
    await this.ensureReady();
    const insert = this.database().prepare(`
      INSERT INTO source_cursors (connection_id, cursor_key, cursor_value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(connection_id, cursor_key) DO UPDATE SET
        cursor_value = excluded.cursor_value,
        updated_at = excluded.updated_at
    `);
    const save = this.database().transaction((items: SourceCursor[]) => {
      for (const cursor of items) {
        insert.run(cursor.connectionId, cursor.cursorKey, cursor.cursorValue, cursor.updatedAt);
      }
    });
    save(cursors);
  }

  async getSourceCursor(connectionId: string, cursorKey: string): Promise<SourceCursor | null> {
    await this.ensureReady();
    const row = this.database()
      .prepare("SELECT * FROM source_cursors WHERE connection_id = ? AND cursor_key = ?")
      .get(connectionId, cursorKey) as SourceCursorRow | undefined;
    return row ? sourceCursorFromRow(row) : null;
  }

  async saveConnectorHealth(health: ConnectorHealth): Promise<void> {
    await this.ensureReady();
    this.database()
      .prepare(`
        INSERT INTO source_health (connection_id, status, detail, checked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          status = excluded.status,
          detail = excluded.detail,
          checked_at = excluded.checked_at
      `)
      .run(health.connectionId, health.status, health.detail, health.checkedAt);
  }

  async listConnectorHealth(): Promise<ConnectorHealth[]> {
    await this.ensureReady();
    return (this.database()
      .prepare("SELECT * FROM source_health ORDER BY connection_id ASC")
      .all() as ConnectorHealthRow[])
      .map(connectorHealthFromRow);
  }

  async clearScanMemory(): Promise<void> {
    await this.ensureReady();
    this.database().prepare("DELETE FROM memory_keys WHERE kind IN ('notified', 'scanned')").run();
  }

  async clearAccountScanMemory(accountId: string): Promise<void> {
    await this.ensureReady();
    const normalizedAccountId = accountId.toLowerCase();
    const deleteKeys = this.database().transaction(() => {
      for (const kind of ["notified", "scanned"]) {
        const rows = this.getMemoryKeys(kind, kind === "notified" ? 1000 : 5000);
        for (const key of rows) {
          if (keyAccountEmail(key) === normalizedAccountId) {
            this.database().prepare("DELETE FROM memory_keys WHERE kind = ? AND key = ?").run(kind, key);
          }
        }
      }
    });
    deleteKeys();
  }

  private async ensureReady(): Promise<void> {
    if (!this.db) {
      await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
      this.db = await openSqliteDatabase(this.databasePath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.createSchema();
    }

    if (!this.migrated) {
      this.migrated = true;
      await this.migrateLegacyJsonIfNeeded();
      this.backfillImportantItemsFromScansIfNeeded();
      this.normalizePrefixedImportantItemIds();
    }
  }

  private get databasePath(): string {
    return this.legacyStatePath.endsWith(".json")
      ? this.legacyStatePath.replace(/\.json$/, ".sqlite")
      : this.legacyStatePath;
  }

  private database(): SqliteDatabase {
    if (!this.db) throw new Error("AppStore database is not initialized.");
    return this.db;
  }

  private createSchema(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        scan_interval_minutes INTEGER NOT NULL,
        gmail_credentials_path TEXT,
        telegram_export_path TEXT,
        telegram_include_dms INTEGER NOT NULL DEFAULT 1,
        launch_at_login INTEGER NOT NULL,
        quiet_hours_enabled INTEGER NOT NULL,
        quiet_hours_start TEXT NOT NULL,
        quiet_hours_end TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        kind TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS important_items (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        account_email TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        scan_id TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_keys (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        created_rowid INTEGER PRIMARY KEY,
        UNIQUE(kind, key)
      );

      CREATE TABLE IF NOT EXISTS source_connections (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        backend TEXT NOT NULL,
        label TEXT NOT NULL,
        account_identifier TEXT,
        external_account_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_cursors (
        connection_id TEXT NOT NULL,
        cursor_key TEXT NOT NULL,
        cursor_value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, cursor_key)
      );

      CREATE TABLE IF NOT EXISTS source_health (
        connection_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scans_status_idx ON scans(status);
      CREATE INDEX IF NOT EXISTS important_items_status_idx ON important_items(status, last_seen_at);
      CREATE INDEX IF NOT EXISTS memory_keys_kind_idx ON memory_keys(kind);
      CREATE INDEX IF NOT EXISTS source_connections_source_idx ON source_connections(source, backend);
      CREATE INDEX IF NOT EXISTS source_cursors_connection_idx ON source_cursors(connection_id);
    `);
    this.ensureSettingsColumn("telegram_export_path", "TEXT");
    this.ensureSettingsColumn("telegram_include_dms", "INTEGER NOT NULL DEFAULT 1");
    this.ensureSourceConnectionsExternalAccountColumn();
  }

  private ensureSettingsColumn(name: string, definition: string): void {
    const rows = this.database().prepare("PRAGMA table_info(settings)").all() as { name: string }[];
    if (rows.some((row) => row.name === name)) return;
    this.database().exec(`ALTER TABLE settings ADD COLUMN ${name} ${definition}`);
  }

  private ensureSourceConnectionsExternalAccountColumn(): void {
    const rows = this.database().prepare("PRAGMA table_info(source_connections)").all() as { name: string }[];
    if (!rows.some((row) => row.name === "external_account_id")) {
      this.database().exec("ALTER TABLE source_connections ADD COLUMN external_account_id TEXT");
    }

    const legacyAccountColumn = ["composio", "connected", "account", "id"].join("_");
    if (rows.some((row) => row.name === legacyAccountColumn)) {
      this.database()
        .prepare(`UPDATE source_connections SET external_account_id = ${legacyAccountColumn} WHERE external_account_id IS NULL`)
        .run();
    }
  }

  private async migrateLegacyJsonIfNeeded(): Promise<void> {
    if (!await this.isEmptyDatabase()) return;

    let raw: PersistedState | null = null;
    try {
      raw = JSON.parse(await fs.readFile(this.legacyStatePath, "utf8")) as PersistedState;
    } catch {
      this.writeSettings(defaultSettings);
      return;
    }

    const state = {
      settings: normalizeSettings(raw.settings),
      accounts: raw.accounts ?? [],
      telegramChats: raw.telegramChats ?? [],
      scans: raw.scans ?? [],
      importantItems: raw.importantItems ?? [],
      notifiedFindingKeys: raw.notifiedFindingKeys ?? [],
      scannedMessageKeys: raw.scannedMessageKeys ?? []
    };

    const migrate = this.database().transaction(() => {
      this.writeSettings(state.settings);
      for (const account of state.accounts) {
        this.database()
          .prepare("INSERT OR REPLACE INTO accounts (id, email, display_name, connected_at, json) VALUES (?, ?, ?, ?, ?)")
          .run(account.id, account.email, account.displayName, account.connectedAt, JSON.stringify(account));
      }
      for (const chat of state.telegramChats) {
        this.database()
          .prepare("INSERT OR REPLACE INTO telegram_chats (id, title, enabled, kind, json) VALUES (?, ?, ?, ?, ?)")
          .run(chat.id, chat.title, chat.enabled ? 1 : 0, chat.kind, JSON.stringify(chat));
      }
      for (const scan of state.scans.slice().reverse()) {
        this.database()
          .prepare("INSERT OR REPLACE INTO scans (id, started_at, completed_at, status, json) VALUES (?, ?, ?, ?, ?)")
          .run(scan.id, scan.startedAt, scan.completedAt ?? null, scan.status, JSON.stringify(scan));
        if (scan.status === "completed" && scan.findings.length) {
          this.saveImportantFindings(scan.findings, scan.id, scan.completedAt);
        }
      }
      for (const item of state.importantItems) {
        this.writeImportantItem(normalizeImportantItem(item));
      }
      this.insertMemoryKeys("notified", state.notifiedFindingKeys);
      this.insertMemoryKeys("scanned", state.scannedMessageKeys);
      this.trimMemoryKeys("notified", 1000);
      this.trimMemoryKeys("scanned", 5000);
    });
    migrate();
  }

  private backfillImportantItemsFromScansIfNeeded(): void {
    const existing = this.database().prepare("SELECT COUNT(*) AS count FROM important_items").get() as { count: number };
    if (existing.count > 0) return;

    const scans = (this.database()
      .prepare("SELECT json FROM scans WHERE status = 'completed' ORDER BY rowid ASC")
      .all() as JsonRow[])
      .map((row) => JSON.parse(row.json) as ScanResult);
    for (const scan of scans) {
      if (scan.findings.length) this.saveImportantFindings(scan.findings, scan.id, scan.completedAt);
    }
  }

  private normalizePrefixedImportantItemIds(): void {
    const rows = this.database()
      .prepare("SELECT json FROM important_items")
      .all() as ImportantItemRow[];
    const normalize = this.database().transaction((items: ImportantItem[]) => {
      for (const item of items) {
        if (item.source === "gmail") continue;
        const prefix = `${item.source}:`;
        const normalizedSourceId = item.sourceId.startsWith(prefix)
          ? item.sourceId.slice(prefix.length)
          : item.sourceId;
        if (!normalizedSourceId) continue;
        const normalizedId = importantItemId({
          ...item,
          sourceId: normalizedSourceId
        });
        if (item.id === normalizedId && item.sourceId === normalizedSourceId) continue;

        const normalizedItem = normalizeImportantItem({
          ...item,
          id: normalizedId,
          sourceId: normalizedSourceId
        });
        const existing = this.database()
          .prepare("SELECT json FROM important_items WHERE id = ?")
          .get(normalizedItem.id) as ImportantItemRow | undefined;
        const itemToWrite = existing
          ? mergeImportantItems(JSON.parse(existing.json) as ImportantItem, normalizedItem)
          : normalizedItem;

        this.writeImportantItem(itemToWrite);
        if (item.id !== itemToWrite.id) {
          this.database().prepare("DELETE FROM important_items WHERE id = ?").run(item.id);
        }
      }
    });
    normalize(rows.map((row) => JSON.parse(row.json) as ImportantItem));
  }

  private async isEmptyDatabase(): Promise<boolean> {
    const settings = this.database().prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number };
    const accounts = this.database().prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
    const scans = this.database().prepare("SELECT COUNT(*) AS count FROM scans").get() as { count: number };
    const memoryKeys = this.database().prepare("SELECT COUNT(*) AS count FROM memory_keys").get() as { count: number };
    const importantItems = this.database().prepare("SELECT COUNT(*) AS count FROM important_items").get() as { count: number };
    return settings.count === 0 && accounts.count === 0 && scans.count === 0 && memoryKeys.count === 0 && importantItems.count === 0;
  }

  private writeSettings(settings: AppSettings): void {
    this.database()
      .prepare(`
        INSERT INTO settings (
          id,
          scan_interval_minutes,
          gmail_credentials_path,
          telegram_export_path,
          telegram_include_dms,
          launch_at_login,
          quiet_hours_enabled,
          quiet_hours_start,
          quiet_hours_end
        )
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          scan_interval_minutes = excluded.scan_interval_minutes,
          gmail_credentials_path = excluded.gmail_credentials_path,
          telegram_export_path = excluded.telegram_export_path,
          telegram_include_dms = excluded.telegram_include_dms,
          launch_at_login = excluded.launch_at_login,
          quiet_hours_enabled = excluded.quiet_hours_enabled,
          quiet_hours_start = excluded.quiet_hours_start,
          quiet_hours_end = excluded.quiet_hours_end
      `)
      .run(
        settings.scanIntervalMinutes,
        settings.gmailCredentialsPath,
        settings.telegramExportPath,
        settings.telegramIncludeDms ? 1 : 0,
        settings.launchAtLogin ? 1 : 0,
        settings.quietHours.enabled ? 1 : 0,
        settings.quietHours.start,
        settings.quietHours.end
      );
  }

  private saveImportantFindings(findings: ScanFinding[], scanId: string, seenAt: string): void {
    const save = this.database().transaction((items: ScanFinding[]) => {
      for (const finding of items) {
        const id = importantItemId(finding);
        const existing = this.database()
          .prepare("SELECT json FROM important_items WHERE id = ?")
          .get(id) as ImportantItemRow | undefined;
        const existingItem = existing ? JSON.parse(existing.json) as ImportantItem : null;
        const item: ImportantItem = {
          ...finding,
          id,
          status: existingItem?.status ?? "active",
          firstSeenAt: existingItem?.firstSeenAt ?? seenAt,
          lastSeenAt: seenAt,
          scanId
        };
        this.writeImportantItem(item);
      }
    });
    save(findings);
  }

  private writeImportantItem(item: ImportantItem): void {
    this.database()
      .prepare(`
        INSERT INTO important_items (
          id,
          status,
          priority,
          source,
          source_id,
          account_email,
          first_seen_at,
          last_seen_at,
          scan_id,
          json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          priority = excluded.priority,
          source = excluded.source,
          source_id = excluded.source_id,
          account_email = excluded.account_email,
          first_seen_at = excluded.first_seen_at,
          last_seen_at = excluded.last_seen_at,
          scan_id = excluded.scan_id,
          json = excluded.json
      `)
      .run(
        item.id,
        item.status,
        item.priority,
        item.source,
        item.sourceId,
        item.accountEmail,
        item.firstSeenAt,
        item.lastSeenAt,
        item.scanId,
        JSON.stringify(item)
      );
  }

  private insertMemoryKeys(kind: string, keys: string[]): void {
    const insert = this.database().prepare("INSERT OR IGNORE INTO memory_keys (kind, key) VALUES (?, ?)");
    for (const key of keys) insert.run(kind, key);
  }

  private getMemoryKeys(kind: string, limit: number): string[] {
    return (this.database()
      .prepare("SELECT key FROM memory_keys WHERE kind = ? ORDER BY created_rowid DESC LIMIT ?")
      .all(kind, limit) as KeyRow[])
      .map((row) => row.key);
  }

  private trimMemoryKeys(kind: string, limit: number): void {
    this.database()
      .prepare("DELETE FROM memory_keys WHERE kind = ? AND created_rowid NOT IN (SELECT created_rowid FROM memory_keys WHERE kind = ? ORDER BY created_rowid DESC LIMIT ?)")
      .run(kind, kind, limit);
  }
}

function normalizeSettings(settings: Partial<AppSettings> | undefined): AppSettings {
  const merged = {
    ...defaultSettings,
    ...(settings ?? {}),
    quietHours: {
      ...defaultSettings.quietHours,
      ...(settings?.quietHours ?? {})
    }
  };

  if (!isValidScanInterval(merged.scanIntervalMinutes)) {
    merged.scanIntervalMinutes = defaultSettings.scanIntervalMinutes;
  }

  if (!isValidClockTime(merged.quietHours.start)) {
    merged.quietHours.start = defaultSettings.quietHours.start;
  }

  if (!isValidClockTime(merged.quietHours.end)) {
    merged.quietHours.end = defaultSettings.quietHours.end;
  }

  return merged;
}

function validateSettingsUpdate(update: Partial<AppSettings>): void {
  if ("scanIntervalMinutes" in update && !isValidScanInterval(update.scanIntervalMinutes)) {
    throw new Error("Expected scan interval to be a whole number of minutes between 1 and 10080 (7 days).");
  }

  if (update.quietHours?.start !== undefined && !isValidClockTime(update.quietHours.start)) {
    throw new Error("Expected quiet hours start to use HH:MM time.");
  }

  if (update.quietHours?.end !== undefined && !isValidClockTime(update.quietHours.end)) {
    throw new Error("Expected quiet hours end to use HH:MM time.");
  }
}

function sourceConnectionFromRow(row: SourceConnectionRow): SourceConnection {
  return {
    id: row.id,
    source: row.source,
    backend: row.backend,
    label: row.label,
    accountIdentifier: row.account_identifier,
    externalAccountId: row.external_account_id,
    enabled: Boolean(row.enabled),
    config: parseObjectJson(row.config_json),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at
  };
}

function sourceCursorFromRow(row: SourceCursorRow): SourceCursor {
  return {
    connectionId: row.connection_id,
    cursorKey: row.cursor_key,
    cursorValue: row.cursor_value,
    updatedAt: row.updated_at
  };
}

function connectorHealthFromRow(row: ConnectorHealthRow): ConnectorHealth {
  return {
    connectionId: row.connection_id,
    status: row.status,
    detail: row.detail,
    checkedAt: row.checked_at
  };
}

function parseObjectJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty object default.
  }
  return {};
}

// Upper bound keeps the scheduling delay far below the 32-bit setTimeout limit
// (~24.8 days), where overflow makes the timer fire immediately and the scan
// loop spin continuously.
const MAX_SCAN_INTERVAL_MINUTES = 7 * 24 * 60;

function isValidScanInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_SCAN_INTERVAL_MINUTES;
}

function isValidClockTime(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function keyAccountEmail(key: string): string | null {
  const parts = key.split(":");
  if (parts[0] !== "gmail" || !parts[1]) return null;
  return parts[1].toLowerCase();
}

function importantItemId(finding: ScanFinding): string {
  if (finding.source === "youtube" && finding.sourceId.startsWith("youtube:")) return finding.sourceId;
  if (finding.source !== "gmail") return `${finding.source}:${finding.sourceId}`;
  return `${finding.source}:${(finding.accountEmail || "unknown").toLowerCase()}:${finding.sourceId}`;
}

function normalizeImportantItem(item: ImportantItem): ImportantItem {
  const fallbackSeenAt = item.receivedAt ?? item.lastSeenAt ?? item.firstSeenAt ?? new Date(0).toISOString();
  return {
    ...item,
    id: item.id || importantItemId(item),
    status: item.status ?? "active",
    firstSeenAt: item.firstSeenAt ?? fallbackSeenAt,
    lastSeenAt: item.lastSeenAt ?? fallbackSeenAt,
    scanId: item.scanId ?? "legacy"
  };
}

function mergeImportantItems(existing: ImportantItem, incoming: ImportantItem): ImportantItem {
  const status = reviewedStatus(existing.status) ? existing.status : incoming.status;
  return normalizeImportantItem({
    ...existing,
    ...incoming,
    status,
    firstSeenAt: minIso(existing.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: maxIso(existing.lastSeenAt, incoming.lastSeenAt)
  });
}

function reviewedStatus(status: ImportantItem["status"]): boolean {
  return status === "completed" || status === "dismissed";
}

function minIso(a: string, b: string): string {
  return dateMs(a) <= dateMs(b) ? a : b;
}

function maxIso(a: string, b: string): string {
  return dateMs(a) >= dateMs(b) ? a : b;
}

function dateMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
