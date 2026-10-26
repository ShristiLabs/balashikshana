// Infrastructure-as-code hygiene gates (issue #64) — pure filesystem scans,
// no database, no network. These are the enforced layers behind the
// acceptance criterion "No secrets in the repo (scan clean); secrets flow
// from the secret store":
//
//   1. No secret-looking literals in any committed Terraform / tfvars /
//      compose / Dockerfile file (AWS key material, PEM blocks, literal
//      password/secret/token assignments).
//   2. .gitignore actually covers Terraform state, provider caches, and
//      *.auto.tfvars (the only sanctioned per-env secret-carrying files).
//   3. dev/staging/prod differ ONLY by tfvars — the .tf files of the three
//      environment roots are byte-identical (DRY by construction).
//   4. Every module source referenced by an environment root exists.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INFRA_DIR = path.join(REPO_ROOT, "infra");

function walk(dir, matcher, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".terraform" || entry.name === "node_modules") continue;
      walk(full, matcher, acc);
    } else if (matcher.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const SCANNABLE = /\.(tf|tfvars|tfvars\.example|hcl|ya?ml|json)$/;
const COMMITTED_INFRA_FILES = walk(INFRA_DIR, SCANNABLE).filter(
  // secrets.auto.tfvars.example is committed BY DESIGN as a template; it is
  // scanned like everything else and must stay placeholder-only.
  (f) => !f.includes("/.terraform/")
);

const SECRET_PATTERNS = [
  {
    name: "AWS access key id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: "AWS secret access key shape",
    re: /\b[A-Za-z0-9/+=]{40}\b/,
    skip: (line) => !/(secret|password|token)/i.test(line), // only flag long tokens on secret-ish lines
  },
  {
    name: "PEM private key block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: "literal secret assignment",
    // password/secret/token/api_key = "literal" (tf, tfvars, yaml, json).
    // Variable references (${...}, ${var.x}, placeholders) are allowed.
    re: /["']?(?:password|passwd|secret|token|api_?key)["']?\s*[:=]\s*["'][^"']{6,}["']/i,
    allowed: [
      "balashikshana_dev", // compose/CI documented dev-only default (pre-existing, matches CI service env)
      "replace-me", // documented operator placeholder
      "placeholder", // documented operator placeholder
    ],
    allowIf: (value) => value.includes("${"), // env/compose variable indirection
  },
];

const DOCKER_FILES = [
  path.join(REPO_ROOT, "docker", "docker-compose.yml"),
  path.join(REPO_ROOT, "docker", "Dockerfile.api"),
  path.join(REPO_ROOT, "docker", "Dockerfile.web"),
];

describe("infra secret scan (no secrets in the repo, ever)", () => {
  const scanTargets = [...COMMITTED_INFRA_FILES, ...DOCKER_FILES.filter((f) => fs.existsSync(f))];

  test("the scan actually has files to check (walker not silently empty)", () => {
    assert.ok(scanTargets.length >= 20, `expected the infra tree to be scanned, found ${scanTargets.length} files`);
  });

  for (const file of scanTargets) {
    test(`clean: ${path.relative(REPO_ROOT, file)}`, () => {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        for (const { name, re, allowed = [], allowIf, skip } of SECRET_PATTERNS) {
          if (skip?.(line)) continue;
          const match = re.exec(line);
          if (!match) continue;
          const literal = match[0];
          if (allowIf?.(literal)) continue;
          if (allowed.some((a) => literal.includes(a))) continue;
          assert.fail(
            `${path.relative(REPO_ROOT, file)}:${i + 1} matches secret pattern "${name}": ${literal.slice(0, 60)}`
          );
        }
      });
    });
  }

  test(".gitignore covers tfstate, provider caches, and *.auto.tfvars", () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    for (const required of [".terraform/", "*.tfstate", "*.auto.tfvars", "*.tfplan"]) {
      assert.ok(gitignore.includes(required), `.gitignore must cover ${required}`);
    }
  });

  test("every environment references only modules that exist", () => {
    for (const env of ["dev", "staging", "prod"]) {
      const main = fs.readFileSync(path.join(INFRA_DIR, "environments", env, "main.tf"), "utf8");
      const sources = [...main.matchAll(/source\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      assert.ok(sources.length >= 5, `${env} should call >= 5 modules`);
      for (const src of sources) {
        const moduleDir = path.resolve(path.join(INFRA_DIR, "environments", env), src);
        assert.ok(
          fs.existsSync(path.join(moduleDir, "main.tf")),
          `${env}: module "${src}" does not resolve to ${moduleDir}`
        );
      }
    }
  });

  test("environments differ ONLY by tfvars — .tf files are byte-identical", () => {
    const tfFiles = ["main.tf", "variables.tf", "versions.tf", "outputs.tf"];
    const dev = {};
    for (const f of tfFiles) {
      dev[f] = fs.readFileSync(path.join(INFRA_DIR, "environments", "dev", f), "utf8");
    }
    for (const env of ["staging", "prod"]) {
      for (const f of tfFiles) {
        const other = fs.readFileSync(path.join(INFRA_DIR, "environments", env, f), "utf8");
        assert.equal(
          other,
          dev[f],
          `${env}/${f} drifted from dev/${f} — per-environment differences belong in terraform.tfvars ONLY`
        );
      }
    }
  });

  test("environment tfvars set their own environment name", () => {
    for (const env of ["dev", "staging", "prod"]) {
      const tfvars = fs.readFileSync(path.join(INFRA_DIR, "environments", env, "terraform.tfvars"), "utf8");
      assert.match(tfvars, new RegExp(`environment\\s*=\\s*"${env}"`));
    }
  });
});
