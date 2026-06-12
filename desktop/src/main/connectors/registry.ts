import type { AppStore } from "../store";
import type { TelegramConnector } from "../telegram";
import type { GmailAccount } from "../types";
import { TelegramLocalConnector } from "./telegram-local";
import type { ConnectorSource, SourceConnection, SourceConnector } from "./types";

type NativeSource = Extract<ConnectorSource, "gmail" | "twitter">;
type LocalSource = Extract<ConnectorSource, "youtube" | "twitter">;

type ConnectorRegistryOptions = {
  telegram: Pick<TelegramConnector, "fetchRecentMessages"> & Partial<Pick<TelegramConnector, "isConnected">>;
  localConnectors?: Partial<Record<LocalSource, SourceConnector>>;
  nativeConnectors?: Partial<Record<NativeSource, SourceConnector>>;
};

export type ConnectorRegistry = {
  getLegacyLocalGmailAccounts(): Promise<GmailAccount[]>;
  listEnabledConnections(): Promise<Array<{ connector: SourceConnector; connection: SourceConnection }>>;
};

export function createConnectorRegistry(store: AppStore, options: ConnectorRegistryOptions): ConnectorRegistry {
  const telegramConnector = new TelegramLocalConnector(store, options.telegram);

  return {
    getLegacyLocalGmailAccounts: () => store.getAccounts(),
    async listEnabledConnections() {
      const connections: Array<{ connector: SourceConnector; connection: SourceConnection }> = [];

      for (const connection of await telegramConnector.listConnections()) {
        connections.push({ connector: telegramConnector, connection });
      }

      for (const connection of await store.listSourceConnections()) {
        if (!connection.enabled || !isProviderSource(connection.source)) continue;
        const connector = connectorForConnection(connection, options);
        if (!connector) continue;
        connections.push({ connector, connection });
      }

      return connections;
    }
  };
}

function connectorForConnection(connection: SourceConnection, options: ConnectorRegistryOptions): SourceConnector | undefined {
  if (!isProviderSource(connection.source)) return undefined;
  if (connection.backend === "local" && isLocalSource(connection.source)) return options.localConnectors?.[connection.source];
  if (connection.backend === "native" && isNativeSource(connection.source)) return options.nativeConnectors?.[connection.source];
  return undefined;
}

function isProviderSource(source: ConnectorSource): source is NativeSource | LocalSource {
  return source === "gmail" || source === "youtube" || source === "twitter";
}

function isNativeSource(source: ConnectorSource): source is NativeSource {
  return source === "gmail" || source === "twitter";
}

function isLocalSource(source: ConnectorSource): source is LocalSource {
  return source === "youtube" || source === "twitter";
}
