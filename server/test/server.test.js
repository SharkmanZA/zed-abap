// Starts server.js over stdio like Zed does and checks the diagnostics it
// publishes. Run with `npm test` in server/.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const rpc = require("vscode-jsonrpc/node");
const { globToRegExp, globBase, isObjectFilename, findFiles } = require("../server.js");

// ABAPLINT_SERVER runs another copy, e.g. the one Zed installed:
// ~/Library/Application Support/Zed/extensions/work/abap/abaplint-server.js
const SERVER = process.env.ABAPLINT_SERVER ?? path.join(__dirname, "..", "server.js");
const FIXTURE = path.join(__dirname, "fixtures", "project");
const TIMEOUT_MS = 15000;

let root;
let server;
let connection;
const latest = new Map(); // uri -> diagnostics
const waiters = [];
const messages = []; // window/showMessage

const uriOf = (relative) => pathToFileURL(path.join(root, relative)).href;

/** Resolves with the first diagnostics for `uri` (published after now) that satisfy `check`. */
function nextDiagnostics(uri, check = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`No matching diagnostics for ${uri}; last: ${JSON.stringify(latest.get(uri))}`));
    }, TIMEOUT_MS);
    waiters.push({ uri, check, resolve, timer });
  });
}

const codes = (diagnostics) => diagnostics.map((d) => d.code).sort();

let version = 1;
function open(relative, text = fs.readFileSync(path.join(root, relative), "utf8")) {
  connection.sendNotification("textDocument/didOpen", {
    textDocument: { uri: uriOf(relative), languageId: "abap", version: version++, text },
  });
}

function change(relative, text) {
  connection.sendNotification("textDocument/didChange", {
    textDocument: { uri: uriOf(relative), version: version++ },
    contentChanges: [{ text }],
  });
}

function close(relative) {
  connection.sendNotification("textDocument/didClose", { textDocument: { uri: uriOf(relative) } });
}

function diskChange(relative, type = 2) {
  connection.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri: uriOf(relative), type }] });
}

before(async () => {
  // Glob syntax in the root's path must be taken literally.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zed abaplint [x] {a,b} "));
  fs.cpSync(FIXTURE, root, { recursive: true });
  server = spawn(process.execPath, [SERVER, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  connection = rpc.createMessageConnection(
    new rpc.StreamMessageReader(server.stdout),
    new rpc.StreamMessageWriter(server.stdin),
  );
  connection.onNotification("textDocument/publishDiagnostics", ({ uri, diagnostics }) => {
    latest.set(uri, diagnostics);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter.uri === uri && waiter.check(diagnostics)) {
        clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(diagnostics);
      }
    }
  });
  connection.onNotification("window/showMessage", (params) => messages.push(params.message));
  connection.onNotification("window/logMessage", (p) => process.env.LSP_LOG && console.error(p.message));
  connection.onRequest("client/registerCapability", () => null);
  connection.listen();
  const result = await connection.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    workspaceFolders: [{ uri: pathToFileURL(root).href, name: "project" }],
    capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
  });
  assert.equal(result.serverInfo.name, "abaplint");
  connection.sendNotification("initialized", {});
});

after(async () => {
  await connection.sendRequest("shutdown");
  connection.sendNotification("exit");
  connection.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

test("references to other objects in the project resolve", async () => {
  const ready = nextDiagnostics(uriOf("src/zgreet.prog.abap"));
  open("src/zgreet.prog.abap");
  assert.deepEqual(await ready, []);
});

test("edits are checked, with the rule key and a link to its docs", async () => {
  const program = fs.readFileSync(path.join(root, "src/zgreet.prog.abap"), "utf8");
  const broken = nextDiagnostics(uriOf("src/zgreet.prog.abap"), (d) => d.length > 0);
  change("src/zgreet.prog.abap", program.replace("greet( )", "farewell( )"));
  const [diagnostic, ...rest] = await broken;
  assert.equal(rest.length, 0);
  assert.equal(diagnostic.code, "check_syntax");
  assert.equal(diagnostic.source, "abaplint");
  assert.match(diagnostic.message, /farewell/i);
  assert.equal(diagnostic.range.start.line, 5);
  assert.equal(diagnostic.codeDescription.href, "https://rules.abaplint.org/check_syntax/");

  const fixed = nextDiagnostics(uriOf("src/zgreet.prog.abap"), (d) => d.length === 0);
  change("src/zgreet.prog.abap", program);
  await fixed;
});

test("an edit to one object rechecks the others that are open", async () => {
  const clas = "src/zcl_greeter.clas.abap";
  const source = fs.readFileSync(path.join(root, clas), "utf8");
  open(clas);
  const broken = nextDiagnostics(uriOf("src/zgreet.prog.abap"), (d) => codes(d).includes("check_syntax"));
  change(clas, source.replaceAll("greet", "hello"));
  await broken;

  // Closing reverts the class to its disk contents.
  const fixed = nextDiagnostics(uriOf("src/zgreet.prog.abap"), (d) => d.length === 0);
  const cleared = nextDiagnostics(uriOf(clas), (d) => d.length === 0);
  close(clas);
  await Promise.all([fixed, cleared]);
});

test("changes on disk to files that aren't open are picked up", async () => {
  const clas = "src/zcl_greeter.clas.abap";
  const source = fs.readFileSync(path.join(root, clas), "utf8");
  const broken = nextDiagnostics(uriOf("src/zgreet.prog.abap"), (d) => codes(d).includes("check_syntax"));
  fs.writeFileSync(path.join(root, clas), source.replaceAll("greet", "hello"));
  diskChange(clas);
  await broken;

  const fixed = nextDiagnostics(uriOf("src/zgreet.prog.abap"), (d) => d.length === 0);
  fs.writeFileSync(path.join(root, clas), source);
  diskChange(clas);
  await fixed;
});

test("a file without an abapGit name is checked on its own as a program", async () => {
  const ok = nextDiagnostics(uriOf("scratch.abap"));
  open("scratch.abap", "DATA lv_x TYPE i.\nlv_x = 1.\nWRITE lv_x.\n");
  assert.deepEqual(await ok, []);

  const broken = nextDiagnostics(uriOf("scratch.abap"), (d) => d.length > 0);
  change("scratch.abap", "DATA lv_x TYPE i\nWRITE lv_x.\n");
  assert.ok(codes(await broken).includes("parser_error"));
  close("scratch.abap");
});

test("loose files with the same name don't interfere", async () => {
  const a = nextDiagnostics(uriOf("a/same.abap"));
  const b = nextDiagnostics(uriOf("b/same.abap"));
  open("a/same.abap", "DATA lv_a TYPE i.\nWRITE lv_a.\n");
  open("b/same.abap", "WRITE lv_a.\n");
  assert.deepEqual(await a, []);
  assert.deepEqual(codes(await b), ["check_syntax"]);
  close("a/same.abap");
  close("b/same.abap");
});

test("global.noIssues from the config applies", async () => {
  const quiet = nextDiagnostics(uriOf("src/zquiet.prog.abap"));
  open("src/zquiet.prog.abap", "REPORT zquiet.\nWRITE lv_unknown.\n");
  assert.deepEqual(await quiet, []);
  close("src/zquiet.prog.abap");
});

test("closing a document clears its diagnostics", async () => {
  const uri = uriOf("src/zbroken.prog.abap");
  const broken = nextDiagnostics(uri, (d) => d.length > 0);
  open("src/zbroken.prog.abap", "REPORT zbroken.\nWRITE lv_unknown.\n");
  await broken;
  const cleared = nextDiagnostics(uri, (d) => d.length === 0);
  close("src/zbroken.prog.abap");
  await cleared;
});

/** Writes the fixture's abaplint.json with `edit` applied and reloads it. */
function writeConfig(edit) {
  const config = JSON.parse(fs.readFileSync(path.join(FIXTURE, "abaplint.json"), "utf8"));
  const text = edit(config) ?? JSON.stringify(config, null, 2);
  fs.writeFileSync(path.join(root, "abaplint.json"), text);
  diskChange("abaplint.json");
}

test("errors in an include are found through its main program", async () => {
  const include = "src/zmain_f01.prog.abap";
  const source = fs.readFileSync(path.join(root, include), "utf8");
  const ok = nextDiagnostics(uriOf(include));
  open(include);
  assert.deepEqual(await ok, []);

  const broken = nextDiagnostics(uriOf(include), (d) => d.length > 0);
  change(include, source.replace("WRITE gv_count.", "WRITE gv_unknown."));
  const diagnostics = await broken;
  assert.deepEqual(codes(diagnostics), ["check_syntax"]);
  assert.match(diagnostics[0].message, /gv_unknown/i);
  assert.equal(diagnostics[0].range.start.line, 2);
  close(include);
});

test("dependency folders resolve, and opening one of their files doesn't change them", async () => {
  const user = "src/zuse.prog.abap";
  const source = fs.readFileSync(path.join(root, user), "utf8");
  const ok = nextDiagnostics(uriOf(user));
  open(user);
  assert.deepEqual(await ok, []);

  const dependency = nextDiagnostics(uriOf("deps/src/zcl_dep.clas.abap"));
  open("deps/src/zcl_dep.clas.abap");
  assert.deepEqual(await dependency, []);
  close("deps/src/zcl_dep.clas.abap");

  const still = nextDiagnostics(uriOf(user));
  change(user, source + "\n\" edited\n");
  assert.deepEqual(await still, []);
  close(user);
});

test("a project object also in a dependency folder is the project's", async () => {
  const clas = "src/zcl_greeter.clas.abap";
  const source = fs.readFileSync(path.join(root, clas), "utf8");
  const broken = nextDiagnostics(uriOf(clas), (d) => d.length > 0);
  open(clas, source.replace("rv_text = `Hello`.", "rv_text = lv_undefined."));
  assert.deepEqual(codes(await broken), ["check_syntax"]);
  const cleared = nextDiagnostics(uriOf(clas), (d) => d.length === 0);
  close(clas);
  await cleared;
});

test("types used through an object that isn't open follow changes", async () => {
  const program = "src/zshape.prog.abap";
  const intf = "src/zif_shape.intf.abap";
  const source = fs.readFileSync(path.join(root, intf), "utf8");
  const ok = nextDiagnostics(uriOf(program));
  open(program);
  assert.deepEqual(await ok, []);

  const broken = nextDiagnostics(uriOf(program), (d) => codes(d).includes("check_syntax"));
  fs.writeFileSync(path.join(root, intf), source.replace("a TYPE i", "b TYPE i"));
  diskChange(intf);
  await broken;

  const fixed = nextDiagnostics(uriOf(program), (d) => d.length === 0);
  fs.writeFileSync(path.join(root, intf), source);
  diskChange(intf);
  await fixed;
  close(program);
});

test("a copy of a project object outside global.files is checked on its own", async () => {
  const copy = "old/zgreet.prog.abap";
  const broken = nextDiagnostics(uriOf(copy), (d) => d.length > 0);
  open(copy, "REPORT zgreet.\nWRITE lv_unknown.\n");
  const diagnostics = await broken;
  assert.deepEqual(codes(diagnostics), ["check_syntax"]);
  assert.match(diagnostics[0].message, /lv_unknown/i);
  close(copy);

  // The project's own object is untouched.
  const ok = nextDiagnostics(uriOf("src/zgreet.prog.abap"));
  change("src/zgreet.prog.abap", fs.readFileSync(path.join(root, "src/zgreet.prog.abap"), "utf8") + "\n");
  assert.deepEqual(await ok, []);
});

test("an abapGit-named class outside every project is checked as a class", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zed-abaplint-outside-"));
  try {
    const uri = pathToFileURL(path.join(outside, "zcl_greeter.clas.abap")).href;
    const result = nextDiagnostics(uri);
    connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "abap", version: version++, text: fs.readFileSync(path.join(root, "src/zcl_greeter.clas.abap"), "utf8") },
    });
    const found = codes(await result);
    assert.ok(!found.includes("global_class"), found.join());
    assert.ok(!found.includes("main_file_contents"), found.join());
    connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a config change reloads the project", async () => {
  const program = uriOf("src/zgreet.prog.abap");
  try {
    const longLines = nextDiagnostics(program, (d) => codes(d).includes("line_length"));
    writeConfig((config) => {
      config.rules.line_length = { length: 20 };
    });
    await longLines;

    // No `files` in `global`: abaplint's default, /src/**/*.*, still applies.
    const noFiles = nextDiagnostics(program, (d) => d.length === 0);
    writeConfig((config) => {
      delete config.global.files;
    });
    await noFiles;

    const unknownVersion = nextDiagnostics(program, (d) => d.length === 0);
    writeConfig((config) => {
      config.syntax.version = "v740";
    });
    await unknownVersion;
    assert.ok(messages.some((message) => /v740/.test(message)), messages.join("\n"));
  } finally {
    const restored = nextDiagnostics(program, (d) => d.length === 0);
    writeConfig(() => undefined);
    await restored;
  }
});

test("an unusable config falls back to the default config, with a warning", async () => {
  const program = uriOf("src/zgreet.prog.abap");
  try {
    for (const [i, edit] of [
      () => "{ not json",
      (config) => {
        config.global.noIssues = ["*_generated.prog.abap"];
      },
      (config) => {
        config.global.exclude = ["/src/legacy/**"];
      },
    ].entries()) {
      const before = messages.length;
      const fallback = nextDiagnostics(program, (d) => codes(d).includes("no_prefixes"));
      writeConfig(edit);
      await fallback; // a rule that only the default config has
      assert.ok(messages.length > before, `case ${i}: no warning`);
      const restored = nextDiagnostics(program, (d) => d.length === 0);
      writeConfig(() => undefined);
      await restored;
    }
  } finally {
    writeConfig(() => undefined);
  }
});

test("globToRegExp matches like abaplint's file globs", () => {
  const re = globToRegExp("/r/src/**/*.*");
  assert.ok(re.test("/r/src/zcl_a.clas.abap"));
  assert.ok(re.test("/r/src/sub/deeper/zcl_a.clas.abap"));
  assert.ok(!re.test("/r/other/zcl_a.clas.abap"));
  assert.ok(!re.test("/r/src/noext"));

  const alt = globToRegExp("/r/{src,lib}/*.{abap,xml}");
  assert.ok(alt.test("/r/lib/x.abap"));
  assert.ok(alt.test("/r/src/x.xml"));
  assert.ok(!alt.test("/r/src/x.json"));
  assert.ok(!alt.test("/r/src/sub/x.abap"));

  assert.ok(globToRegExp("/r/z?.[ap]rog.abap").test("/r/z1.prog.abap"));
  assert.ok(!globToRegExp("/r/z?.[!p]rog.abap").test("/r/z1.prog.abap"));
  assert.ok(globToRegExp("/r/a+b (1)/*.abap").test("/r/a+b (1)/x.abap"));
  assert.ok(globToRegExp("/r/**").test("/r/a/b/c"));
});

test("globBase stops at the first wildcard segment", () => {
  assert.equal(globBase("/r/src/**/*.*"), "/r/src");
  assert.equal(globBase("/r/{a,b}/*.abap"), "/r");
  assert.equal(globBase("/*.abap"), "");
});

test("isObjectFilename accepts only names abaplint can map to an object", () => {
  assert.ok(isObjectFilename("/r/zcl_a.clas.abap"));
  assert.ok(isObjectFilename("/r/zcl_a.clas.testclasses.abap"));
  assert.ok(isObjectFilename("/r/%23ns%23zprog.prog.abap"));
  assert.ok(isObjectFilename("/r/zview.ddls.asddls"));
  assert.ok(!isObjectFilename("/r/sample.abap"));
  assert.ok(!isObjectFilename("/r/my.report.abap"));
  assert.ok(!isObjectFilename("/r.d/sample.abap"));
});

test("package.json pins exact versions (the extension installs these)", () => {
  const { dependencies } = require("../package.json");
  for (const [name, version] of Object.entries(dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name}@${version}`);
  }
});

test("findFiles follows symlinks and skips dot folders, like the CLI", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zed-abaplint-files-")));
  try {
    const touch = (relative) => {
      fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), "");
    };
    touch("shared/zcl_a.clas.abap");
    touch("repo/src/zcl_b.clas.abap");
    touch("repo/src/.bak/zcl_b.clas.abap");
    touch("repo/.worktrees/x/src/zcl_b.clas.abap");
    fs.symlinkSync(path.join(dir, "shared"), path.join(dir, "repo/src/linked"));
    fs.symlinkSync(path.join(dir, "repo/src"), path.join(dir, "repo/src/loop"));
    const root = toUnix(path.join(dir, "repo"));
    const found = findFiles(root, "/**/*.*").map((f) => f.slice(root.length)).sort();
    assert.deepEqual(found, ["/src/linked/zcl_a.clas.abap", "/src/zcl_b.clas.abap"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function toUnix(p) {
  return p.split(path.sep).join("/");
}
