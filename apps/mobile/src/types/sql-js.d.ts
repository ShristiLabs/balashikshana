/**
 * Minimal type declaration for sql.js (issue #71). The package ships
 * untyped JavaScript (its .d.ts coverage is partial upstream); the web
 * SQL seam only uses the wasm-module factory and the Database surface
 * below — pinned here instead of pulling @types/sql.js.
 */
declare module "sql.js" {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
  }

  export interface SqlJsDatabase {
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    prepare(sql: string): SqlJsStatement;
    run(sql: string, params?: unknown[]): void;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatement {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(params?: unknown[]): Record<string, unknown>;
    free(): boolean;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
