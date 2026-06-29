#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require(path.join(__dirname, "..", "backend", "node_modules", "better-sqlite3"));
const JSZip = require(path.join(__dirname, "..", "backend", "node_modules", "jszip"));
const { initFramework } = require("./api-test-framework");

const configCandidates = [
  path.join(__dirname, "..", "config.json"),
  path.join(__dirname, "..", "backend", "config.json")
];
const configPath = configCandidates.find((candidate) => fs.existsSync(candidate));
if (!configPath) {
  throw new Error("Unable to locate config.json (checked project root and backend/).");
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const baseUrl = (process.env.BASE_URL || `http://localhost:${config.PORT}`).replace(/\/$/, "");
const bootstrapUsername = (process.env.TEST_BOOTSTRAP_USERNAME || process.env.ROOT_USERNAME || "testuser").trim().toLowerCase();
const bootstrapPassword =
  process.env.TEST_BOOTSTRAP_PASSWORD ||
  process.env.ROOT_PASSWORD ||
  process.env.MAINTENANCE_PASSWORD ||
  process.env.ADMIN_PASSWORD || "testpassword";
const outputRoot = path.join(__dirname, "generated-invalid-managed-backups");
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(outputRoot, runStamp);
const logFilePath = path.join(outputDir, "build-invalid-managed-backups.log");

fs.mkdirSync(outputDir, { recursive: true });

const framework = initFramework({
  baseUrl,
  logFilePath,
  loginRole: "maintenance",
  loginUsername: bootstrapUsername,
  loginPassword: bootstrapPassword
});

const {
  context,
  authHeaders,
  fetchJson,
  expectStatus,
  loginAs
} = framework;

async function createManagedBackup(note) {
  const { res, json, text } = await fetchJson(`${baseUrl}/maintenance/backup`, {
    method: "POST",
    headers: authHeaders(context.token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ note })
  });
  await expectStatus(res, 200);
  if (!json?.backup_id) {
    throw new Error(`Unexpected managed backup response: ${text}`);
  }
  return json;
}

async function downloadManagedBackupBuffer(backupId) {
  const res = await fetch(`${baseUrl}/maintenance/backups/${encodeURIComponent(backupId)}/download`, {
    headers: authHeaders(context.token)
  });
  await expectStatus(res, 200);
  return Buffer.from(await res.arrayBuffer());
}

async function deleteManagedBackup(backupId) {
  const res = await fetch(`${baseUrl}/maintenance/backups/${encodeURIComponent(backupId)}`, {
    method: "DELETE",
    headers: authHeaders(context.token)
  });
  if (res.status === 404) {
    return;
  }
  await expectStatus(res, 200);
}

function writeCaseFile(filename, buffer) {
  const filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function inspectManagedBackupArchiveUpload(buffer, filename) {
  const form = new FormData();
  form.append("backup", new Blob([buffer]), filename);
  const { res, json, text } = await fetchJson(`${baseUrl}/maintenance/backups/import/inspect`, {
    method: "POST",
    headers: authHeaders(context.token),
    body: form
  });
  return { res, json, text };
}

function mutateDbBuffer(sourceBuffer, mutator) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "invalid-managed-backup-db-"));
  const tempFile = path.join(tempDir, "scenario.db");
  fs.writeFileSync(tempFile, Buffer.from(sourceBuffer));

  const tempDb = new Database(tempFile);
  try {
    mutator(tempDb);
  } finally {
    tempDb.close();
  }

  const mutatedBuffer = fs.readFileSync(tempFile);
  fs.rmSync(tempDir, { recursive: true, force: true });
  return mutatedBuffer;
}

async function createArchiveWithDb(baseArchiveBuffer, archiveFilename, dbBuffer, mutateZip) {
  const zip = await JSZip.loadAsync(baseArchiveBuffer);
  const metadata = JSON.parse(await zip.file("metadata.json").async("string"));
  const dbInfo = readDbMetadataFromBuffer(dbBuffer);

  metadata.backup_id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  metadata.archive_backup_id = metadata.backup_id;
  metadata.archive_filename = archiveFilename;
  metadata.schema_version = dbInfo.schemaVersion;
  metadata.database_id = dbInfo.databaseId;
  zip.file("database/auction.db", Buffer.from(dbBuffer));
  zip.file("metadata.json", JSON.stringify(metadata, null, 2));

  if (typeof mutateZip === "function") {
    await mutateZip(zip, metadata, dbInfo);
  }

  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function readDbMetadataFromBuffer(buffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "invalid-managed-backup-read-"));
  const tempFile = path.join(tempDir, "metadata.db");
  fs.writeFileSync(tempFile, Buffer.from(buffer));
  const tempDb = new Database(tempFile, { readonly: true });
  try {
    const schemaRow = tempDb.prepare("SELECT value FROM metadata WHERE data = 'schema_version'").get();
    const databaseRow = tempDb.prepare("SELECT value FROM metadata WHERE data = 'database_id'").get();
    return {
      schemaVersion: String(schemaRow?.value || ""),
      databaseId: databaseRow?.value != null && String(databaseRow.value).length > 0 ? String(databaseRow.value) : null
    };
  } finally {
    tempDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function buildInvalidCases(baseArchiveBuffer) {
  const cases = [];
  const baseZip = await JSZip.loadAsync(baseArchiveBuffer);
  const baseDbBuffer = Buffer.from(await baseZip.file("database/auction.db").async("nodebuffer"));

  cases.push({
    key: "missing_metadata_json",
    filename: "invalid_missing_metadata_json.zip",
    expected: { status: 400, errorIncludes: "missing metadata.json" },
    build: async () => {
      const zip = await JSZip.loadAsync(baseArchiveBuffer);
      zip.remove("metadata.json");
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    }
  });

  cases.push({
    key: "unexpected_top_level_file",
    filename: "invalid_unexpected_top_level_file.zip",
    expected: { status: 400, errorIncludes: "Unexpected archive entry" },
    build: async () => {
      const zip = await JSZip.loadAsync(baseArchiveBuffer);
      zip.file("unexpected.txt", "This file should not be here.");
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    }
  });

  cases.push({
    key: "unexpected_photo_file_type",
    filename: "invalid_unexpected_photo_file_type.zip",
    expected: { status: 400, errorIncludes: "Unexpected file type" },
    build: async () => {
      const zip = await JSZip.loadAsync(baseArchiveBuffer);
      zip.file("photos/not-an-image.exe", "not allowed");
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    }
  });

  cases.push({
    key: "photo_manifest_count_mismatch",
    filename: "invalid_photo_manifest_count_mismatch.zip",
    expected: { status: 200, can_import: false, blockedIncludes: "Photo count mismatch" },
    build: async () => {
      const zip = await JSZip.loadAsync(baseArchiveBuffer);
      const metadata = JSON.parse(await zip.file("metadata.json").async("string"));
      metadata.component_manifest.photos.file_count = Number(metadata.component_manifest.photos.file_count || 0) + 1;
      zip.file("metadata.json", JSON.stringify(metadata, null, 2));
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    }
  });

  cases.push({
    key: "database_declared_but_missing_snapshot",
    filename: "invalid_database_declared_but_missing_snapshot.zip",
    expected: { status: 200, can_import: false, blockedIncludes: "missing database/auction.db" },
    build: async () => {
      const zip = await JSZip.loadAsync(baseArchiveBuffer);
      zip.remove("database/auction.db");
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    }
  });

  cases.push({
    key: "resources_missing_required_config",
    filename: "invalid_resources_missing_required_config.zip",
    expected: { status: 200, can_import: false, blockedIncludes: "missing slipConfig.json" },
    build: async () => {
      const zip = await JSZip.loadAsync(baseArchiveBuffer);
      zip.remove("resources/config/slipConfig.json");
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    }
  });

  cases.push({
    key: "schema_major_mismatch_live_server",
    filename: "invalid_schema_major_mismatch_live_server.zip",
    expected: { status: 200, can_import: false, comparisonStatus: "blocked", blockedIncludes: "schema major version" },
    build: async () => {
      const majorMismatchDb = mutateDbBuffer(baseDbBuffer, (tempDb) => {
        tempDb.prepare("UPDATE metadata SET value = ? WHERE data = 'schema_version'").run("99.0");
      });
      return createArchiveWithDb(baseArchiveBuffer, "invalid_schema_major_mismatch_live_server.zip", majorMismatchDb);
    }
  });

  cases.push({
    key: "corrupt_sqlite_snapshot",
    filename: "invalid_corrupt_sqlite_snapshot.zip",
    expected: { status: 400, errorIncludes: "not a valid SQLite database" },
    build: async () => {
      const zip = await JSZip.loadAsync(baseArchiveBuffer);
      zip.file("database/auction.db", Buffer.from("not sqlite"));
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    }
  });

  cases.push({
    key: "metadata_missing_component_manifest",
    filename: "invalid_metadata_missing_component_manifest.zip",
    expected: { status: 400, errorIncludes: "missing component_manifest" },
    build: async () => {
      const zip = await JSZip.loadAsync(baseArchiveBuffer);
      const metadata = JSON.parse(await zip.file("metadata.json").async("string"));
      delete metadata.component_manifest;
      zip.file("metadata.json", JSON.stringify(metadata, null, 2));
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    }
  });

  return cases;
}

function casePassed(caseDef, result) {
  if (result.status !== caseDef.expected.status) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(caseDef.expected, "can_import") && result.can_import !== caseDef.expected.can_import) {
    return false;
  }
  if (caseDef.expected.comparisonStatus && result.comparisonSchemaStatus !== caseDef.expected.comparisonStatus) {
    return false;
  }
  if (caseDef.expected.errorIncludes) {
    return String(result.error || result.responseText || "").toLowerCase().includes(String(caseDef.expected.errorIncludes).toLowerCase());
  }
  if (caseDef.expected.blockedIncludes) {
    return result.blocking_errors.some((message) =>
      String(message).toLowerCase().includes(String(caseDef.expected.blockedIncludes).toLowerCase())
    );
  }
  return true;
}

async function main() {
  let templateBackupId = null;
  try {
    context.token = await loginAs("maintenance", bootstrapPassword, bootstrapUsername);
    if (!context.token) {
      throw new Error(`Login failed for ${bootstrapUsername}.`);
    }
    console.log(`Authenticated against ${baseUrl} as ${bootstrapUsername}`);

    const templateBackup = await createManagedBackup(`Invalid backup generation template ${Date.now()}`);
    templateBackupId = templateBackup.backup_id;
    console.log(`Created temporary template backup ${templateBackupId}`);

    const templateArchiveBuffer = await downloadManagedBackupBuffer(templateBackupId);
    const cases = await buildInvalidCases(templateArchiveBuffer);
    const results = [];

    for (const caseDef of cases) {
      const buffer = await caseDef.build();
      const filePath = writeCaseFile(caseDef.filename, buffer);
      const inspection = await inspectManagedBackupArchiveUpload(buffer, caseDef.filename);
      const result = {
        key: caseDef.key,
        filename: caseDef.filename,
        file_path: filePath,
        bytes: buffer.length,
        expected: caseDef.expected,
        status: inspection.res.status,
        can_import: inspection.json?.can_import,
        comparisonSchemaStatus: inspection.json?.comparison?.schema?.status || null,
        error: inspection.json?.error || null,
        blocking_errors: Array.isArray(inspection.json?.blocking_errors) ? inspection.json.blocking_errors : [],
        warnings: Array.isArray(inspection.json?.warnings) ? inspection.json.warnings : [],
        responseText: inspection.text,
        passed: false
      };
      result.passed = casePassed(caseDef, result);
      results.push(result);
      console.log(`${result.passed ? "PASS" : "FAIL"} ${caseDef.key} -> status=${result.status} file=${caseDef.filename}`);
    }

    const summary = {
      generated_at: new Date().toISOString(),
      base_url: baseUrl,
      output_dir: outputDir,
      template_backup_id: templateBackupId,
      total_cases: results.length,
      passed_cases: results.filter((entry) => entry.passed).length,
      failed_cases: results.filter((entry) => !entry.passed).length,
      results
    };

    fs.writeFileSync(path.join(outputDir, "results.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(
      path.join(outputDir, "README.txt"),
      [
        `Generated: ${summary.generated_at}`,
        `Base URL: ${summary.base_url}`,
        `Template backup ID: ${summary.template_backup_id}`,
        "",
        "Each .zip file in this directory is intended to fail managed-backup import validation.",
        "See results.json for the live backend response captured during generation."
      ].join("\n"),
      "utf8"
    );

    console.log(`Saved ${results.length} invalid backup archives to ${outputDir}`);
    console.log(`Summary: ${summary.passed_cases} passed expectations, ${summary.failed_cases} failed expectations`);

    if (summary.failed_cases > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (templateBackupId) {
      try {
        await deleteManagedBackup(templateBackupId);
        console.log(`Deleted temporary template backup ${templateBackupId}`);
      } catch (error) {
        console.error(`Failed to delete temporary template backup ${templateBackupId}: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
