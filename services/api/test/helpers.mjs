// Shared harness helpers for API tests: each suite gets a throwaway
// PostgreSQL database (created from the server's maintenance connection)
// so tests never touch dev data and run in parallel safely.

import { Client } from "pg";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "../server.mjs");

const BASE_DATABASE_URL =
  process.env.DATABASE_URL || "postgres://balashikshana:balashikshana_dev@localhost:5432/balashikshana_db";

export async function createTestDatabase() {
  const admin = new Client({ connectionString: BASE_DATABASE_URL, database: "postgres" });
  await admin.connect();
  const dbName = `balashikshana_test_${process.pid}_${Math.floor(Math.random() * 100000)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(BASE_DATABASE_URL);
  url.pathname = `/${dbName}`;

  return { name: dbName, url: url.toString() };
}

export async function dropTestDatabase(name) {
  const admin = new Client({ connectionString: BASE_DATABASE_URL, database: "postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

export async function startTestServer({ port, databaseUrl, env = {}, onStdout, onStderr }) {
  const child = spawn(process.execPath, ["--no-warnings", SERVER], {
    env: { ...process.env, ...env, PORT: String(port), DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (onStdout) child.stdout.on("data", (c) => onStdout(String(c)));
  if (onStderr) child.stderr.on("data", (c) => onStderr(String(c)));
  return child;
}

export async function waitForHealth(api, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${api}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet (migrations + seed can take a few seconds on a cold DB)
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API server did not become healthy in time");
}
