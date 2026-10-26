/**
 * Native pack-artifact database opener (issue #71): opens a downloaded
 * content-pack .sqlite from the on-device pack directory with its own
 * connection (the #46/#47 read pattern). Web twin in packdb.web.ts.
 */
import { contentPackDirectory } from "../content/nativeContent";
import { openDatabaseAsync, type SQLiteDatabase } from "./sqlite";

export async function openPackArtifact(fileName: string): Promise<SQLiteDatabase> {
  const dir = contentPackDirectory();
  return openDatabaseAsync(fileName, { useNewConnection: true }, dir.uri);
}
