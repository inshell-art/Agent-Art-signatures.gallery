#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const solc = require("../../node_modules/solc");

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${solc.version()}\n`);
  process.exit(0);
}

if (!args.includes("--standard-json")) {
  process.stderr.write("The signatures.gallery compiler adapter only supports --version and --standard-json.\n");
  process.exit(2);
}

const repositoryRoot = path.resolve(__dirname, "../..");
const input = fs.readFileSync(0, "utf8");
const output = solc.compile(input, {
  import(importPath) {
    const candidates = [
      path.resolve(process.cwd(), importPath),
      path.resolve(repositoryRoot, importPath),
      path.resolve(repositoryRoot, "node_modules", importPath),
      path.resolve(repositoryRoot, "node_modules", importPath.replace(/^\.\.\/node_modules\//, "")),
    ];
    for (const candidate of candidates) {
      try {
        return { contents: fs.readFileSync(candidate, "utf8") };
      } catch (error) {
        if (error && error.code !== "ENOENT") throw error;
      }
    }
    return { error: `Compiler import not found: ${importPath}` };
  },
});

process.stdout.write(output);
