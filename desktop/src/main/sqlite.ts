type StatementResult = {
  changes?: number | bigint;
};

export type SqliteStatement = {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => StatementResult;
};

export type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  pragma: (sql: string) => void;
  transaction: <Args extends unknown[], Result>(callback: (...args: Args) => Result) => (...args: Args) => Result;
};

export async function openSqliteDatabase(filePath: string): Promise<SqliteDatabase> {
  if ("bun" in process.versions) {
    const sqlite = await import("bun:sqlite");
    const db = new sqlite.Database(filePath);
    return wrapBunDatabase(db as unknown as BunDatabase);
  }

  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(filePath);
  return wrapNodeDatabase(db as unknown as NodeDatabase);
}

type BunDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  transaction: <Args extends unknown[], Result>(callback: (...args: Args) => Result) => (...args: Args) => Result;
};

type NodeDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

function wrapBunDatabase(db: BunDatabase): SqliteDatabase {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    pragma: (sql) => {
      db.exec(`PRAGMA ${sql}`);
    },
    transaction: (callback) => db.transaction(callback)
  };
}

function wrapNodeDatabase(db: NodeDatabase): SqliteDatabase {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    pragma: (sql) => {
      db.exec(`PRAGMA ${sql}`);
    },
    transaction: (callback) => {
      return (...args) => {
        db.exec("BEGIN");
        try {
          const result = callback(...args);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      };
    }
  };
}
