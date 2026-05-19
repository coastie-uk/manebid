#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const PREFIXES = ["pt_", "mt_", "bt_"];
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const dryRun = args.has("--dry-run");

function getOptionValue(name) {
  const index = rawArgs.indexOf(name);
  if (index === -1) return "";
  return rawArgs[index + 1] || "";
}

function readConfig() {
  const configPath = path.join(__dirname, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.DB_PATH || !config.DB_NAME) {
    throw new Error("config.json must define DB_PATH and DB_NAME");
  }
  return config;
}

function databasePath(config) {
  if (config.DB_PATH === ".") {
    return path.resolve(__dirname, config.DB_NAME);
  }
  return path.resolve(config.DB_PATH, config.DB_NAME);
}

function testUserWhereClause() {
  const clauses = PREFIXES.map(() => "lower(username) LIKE ? ESCAPE '\\'");
  return {
    sql: `(${clauses.join(" OR ")})`,
    params: PREFIXES.map((prefix) => `${prefix.replace("_", "\\_")}%`)
  };
}

function main() {
  const config = readConfig();
  const dbFile = getOptionValue("--db") || databasePath(config);
  if (!fs.existsSync(dbFile)) {
    throw new Error(`Database file not found: ${dbFile}`);
  }

  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");

  const testUsers = testUserWhereClause();
  const users = db.prepare(`
    SELECT username
    FROM users
    WHERE ${testUsers.sql}
    ORDER BY username COLLATE NOCASE
  `).all(...testUsers.params);

  console.log(`Database: ${dbFile}`);
  console.log(`Matched ${users.length} test-generated user(s).`);
  users.forEach((user) => console.log(`- ${user.username}`));

  if (dryRun) {
    console.log("Dry run only. No users deleted.");
    db.close();
    return;
  }

  const removeUsers = db.transaction(() => {
    return db.prepare(`
      DELETE FROM users
      WHERE ${testUsers.sql}
    `).run(...testUsers.params);
  });

  const result = removeUsers();
  console.log(`Deleted ${result.changes} test-generated user(s).`);
  db.close();
}

try {
  main();
} catch (err) {
  console.error(`Failed to remove test users: ${err.message}`);
  process.exit(1);
}
