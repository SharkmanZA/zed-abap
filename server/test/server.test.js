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
    // What Zed sends, as far as the server cares.
    capabilities: {
      workspace: {
        didChangeWatchedFiles: { dynamicRegistration: true },
        workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
      },
    },
  });
  assert.equal(result.serverInfo.name, "abaplint");
  for (const provider of ["hover", "definition", "implementation", "references", "documentSymbol", "documentFormatting", "rename", "codeAction"]) {
    assert.ok(result.capabilities[`${provider}Provider`], provider);
  }
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

test("a loose file matched by global.exclude has no findings", async () => {
  const excluded = nextDiagnostics(uriOf("legacy/old.abap"));
  open("legacy/old.abap", "WRITE lv_unknown.\n");
  assert.deepEqual(await excluded, []);
  close("legacy/old.abap");
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
    // Without a config, only errors are reported, not style.
    assert.deepEqual(codes(await result), []);
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
  // zquiet's error is hidden by the config's noIssues.
  const program = uriOf("src/zquiet.prog.abap");
  open("src/zquiet.prog.abap", "REPORT zquiet.\nWRITE lv_unknown.\n");
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
      const fallback = nextDiagnostics(program, (d) => codes(d).includes("check_syntax"));
      writeConfig(edit);
      await fallback; // the default config has no noIssues
      assert.ok(messages.length > before, `case ${i}: no warning`);
      const restored = nextDiagnostics(program, (d) => d.length === 0);
      writeConfig(() => undefined);
      await restored;
    }
  } finally {
    writeConfig(() => undefined);
    close("src/zquiet.prog.abap");
  }
});

test("an object outside global.files brings in its package folder and subpackages", async () => {
  const clas = "pkg/zcl_pkg.clas.abap";
  const intf = "pkg/sub/zif_pkg.intf.abap";
  const ok = nextDiagnostics(uriOf(clas));
  open(clas);
  assert.deepEqual(await ok, []);

  // Files in the folder follow the disk, including deletes and new files.
  const source = fs.readFileSync(path.join(root, intf), "utf8");
  try {
    const missing = nextDiagnostics(uriOf(clas), (d) => codes(d).includes("check_syntax"));
    fs.rmSync(path.join(root, intf));
    diskChange(intf, 3);
    await missing;
  } finally {
    const back = nextDiagnostics(uriOf(clas), (d) => d.length === 0);
    fs.writeFileSync(path.join(root, intf), source);
    diskChange(intf, 1);
    await back;
  }

  // Closing a folder file puts its disk contents back.
  const intfOk = nextDiagnostics(uriOf(intf));
  open(intf, source.replace("METHODS run", "METHODS go"));
  await intfOk;
  const broken = nextDiagnostics(uriOf(clas), (d) => d.length > 0);
  change(clas, fs.readFileSync(path.join(root, clas), "utf8") + "\n");
  await broken;
  const fixed = nextDiagnostics(uriOf(clas), (d) => d.length === 0);
  close(intf);
  await fixed;
  close(clas);
});

test("an object outside global.files without a package.devc.xml brings in its own folder", async () => {
  const ok = nextDiagnostics(uriOf("flat/zcl_flat.clas.abap"));
  open("flat/zcl_flat.clas.abap");
  assert.deepEqual(await ok, []);
  close("flat/zcl_flat.clas.abap");
});

test("copies of an object in two folders outside global.files don't merge", async () => {
  const copy = fs.readFileSync(path.join(root, "flat/zcl_flat.clas.abap"), "utf8");
  fs.mkdirSync(path.join(root, "flat2"));
  fs.writeFileSync(path.join(root, "flat2/zcl_flat.clas.abap"), copy.replace("rv_result = 1.", "rv_result = lv_unknown."));
  try {
    const first = nextDiagnostics(uriOf("flat/zcl_flat.clas.abap"));
    open("flat/zcl_flat.clas.abap");
    assert.deepEqual(await first, []);
    // The second copy is checked on its own: its interface isn't next to it.
    const second = nextDiagnostics(uriOf("flat2/zcl_flat.clas.abap"), (d) => d.length > 0);
    open("flat2/zcl_flat.clas.abap");
    assert.ok(codes(await second).includes("check_syntax"));
    const still = nextDiagnostics(uriOf("flat/zcl_flat.clas.abap"));
    change("flat/zcl_flat.clas.abap", copy + "\n");
    assert.deepEqual(await still, []);
  } finally {
    close("flat2/zcl_flat.clas.abap");
    close("flat/zcl_flat.clas.abap");
  }
});

test("a backup copy of a project object doesn't bring its folder into the project", async () => {
  fs.mkdirSync(path.join(root, "backup"));
  fs.copyFileSync(path.join(root, "src/zgreet.prog.abap"), path.join(root, "backup/zgreet.prog.abap"));
  fs.writeFileSync(
    path.join(root, "backup/zcl_gone.clas.abap"),
    fs.readFileSync(path.join(root, "src/zcl_shape.clas.abap"), "utf8").replaceAll("zcl_shape", "zcl_gone"),
  );
  const user = "src/zuse_gone.prog.abap";
  try {
    const backup = nextDiagnostics(uriOf("backup/zgreet.prog.abap"));
    open("backup/zgreet.prog.abap");
    await backup;
    // ZCL_GONE is only in the backup folder, so the project can't see it.
    const broken = nextDiagnostics(uriOf(user), (d) => d.length > 0);
    open(user, "REPORT zuse_gone.\nzcl_gone=>size( ).\n");
    assert.ok(codes(await broken).includes("check_syntax"));
  } finally {
    close(user);
    close("backup/zgreet.prog.abap");
  }
});

// ---------------------------------------------------------------------------
// Language features

const at = (relative, line, character) => ({ textDocument: { uri: uriOf(relative) }, position: { line, character } });

/** Opens `relative` and waits until it has been checked. */
async function openChecked(relative, text) {
  const checked = nextDiagnostics(uriOf(relative));
  open(relative, text);
  await checked;
}

test("hover shows what's under the cursor, without abaplint's debugging details", async () => {
  await openChecked("src/zgreet.prog.abap");
  try {
    // lv_text in `DATA lv_text TYPE string.`
    const variable = await connection.sendRequest("textDocument/hover", at("src/zgreet.prog.abap", 2, 7));
    assert.equal(variable.contents.kind, "markdown");
    assert.match(variable.contents.value, /lv_text/);
    assert.match(variable.contents.value, /string/);
    // greet in `zcl_greeter=>greet( )`
    const method = await connection.sendRequest("textDocument/hover", at("src/zgreet.prog.abap", 5, 25));
    assert.match(method.contents.value, /greet/);
    assert.doesNotMatch(method.contents.value, /Extra:|\(Resolved\)/);
    // Blank line.
    assert.equal(await connection.sendRequest("textDocument/hover", at("src/zgreet.prog.abap", 1, 0)), null);
  } finally {
    close("src/zgreet.prog.abap");
  }
});

test("go to definition finds the declaration, in other files too", async () => {
  await openChecked("src/zgreet.prog.abap");
  try {
    const local = await connection.sendRequest("textDocument/definition", at("src/zgreet.prog.abap", 6, 10));
    assert.equal(local.uri, uriOf("src/zgreet.prog.abap"));
    assert.deepEqual(local.range.start, { line: 2, character: 5 });

    const method = await connection.sendRequest("textDocument/definition", at("src/zgreet.prog.abap", 5, 25));
    assert.equal(method.uri, uriOf("src/zcl_greeter.clas.abap"));
    assert.equal(method.range.start.line, 2);

    // Follows an edit that hasn't been checked yet.
    change("src/zgreet.prog.abap", "REPORT zgreet.\n\n\nDATA lv_text TYPE string.\nlv_text = `x`.\n");
    const moved = await connection.sendRequest("textDocument/definition", at("src/zgreet.prog.abap", 4, 2));
    assert.deepEqual(moved.range.start, { line: 3, character: 5 });
  } finally {
    close("src/zgreet.prog.abap");
  }
});

test("go to definition in a file without an abapGit name points at that file", async () => {
  await openChecked("loose.abap", "DATA lv_x TYPE i.\nlv_x = 1.\n");
  try {
    const found = await connection.sendRequest("textDocument/definition", at("loose.abap", 1, 1));
    assert.equal(found.uri, uriOf("loose.abap"));
    assert.deepEqual(found.range.start, { line: 0, character: 5 });
  } finally {
    close("loose.abap");
  }
});

test("find references includes the declaration when asked", async () => {
  await openChecked("src/zgreet.prog.abap");
  try {
    const params = { ...at("src/zgreet.prog.abap", 5, 25), context: { includeDeclaration: true } };
    const found = await connection.sendRequest("textDocument/references", params);
    const where = found.map((location) => `${path.basename(location.uri)}:${location.range.start.line}`).sort();
    assert.deepEqual(where, ["zcl_greeter.clas.abap:2", "zcl_greeter.clas.abap:7", "zgreet.prog.abap:5"]);

    const without = await connection.sendRequest("textDocument/references", { ...params, context: { includeDeclaration: false } });
    assert.equal(without.length, 2);
  } finally {
    close("src/zgreet.prog.abap");
  }
});

test("go to implementation finds a method's implementation", async () => {
  await openChecked("src/zgreet.prog.abap");
  try {
    const found = await connection.sendRequest("textDocument/implementation", at("src/zgreet.prog.abap", 5, 25));
    assert.deepEqual(
      found.map((location) => [path.basename(location.uri), location.range.start.line]),
      [["zcl_greeter.clas.abap", 7]],
    );
  } finally {
    close("src/zgreet.prog.abap");
  }
});

test("document symbols list a class and its methods", async () => {
  await openChecked("src/zcl_greeter.clas.abap");
  try {
    const symbols = await connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri: uriOf("src/zcl_greeter.clas.abap") } });
    const names = JSON.stringify(symbols).toLowerCase();
    assert.match(names, /zcl_greeter/);
    assert.match(names, /greet/);
  } finally {
    close("src/zcl_greeter.clas.abap");
  }
});

test("formatting replaces the document with abaplint's pretty printed text", async () => {
  const text = "report zfmt.\ndata lv_x type i.\n    write lv_x.";
  await openChecked("src/zfmt.prog.abap", text);
  try {
    const edits = await connection.sendRequest("textDocument/formatting", {
      textDocument: { uri: uriOf("src/zfmt.prog.abap") },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].range, { start: { line: 0, character: 0 }, end: { line: 2, character: 15 } });
    assert.match(edits[0].newText, /^REPORT zfmt\.\nDATA lv_x TYPE i\.\nWRITE lv_x\./);

    change("src/zfmt.prog.abap", edits[0].newText);
    assert.deepEqual(
      await connection.sendRequest("textDocument/formatting", {
        textDocument: { uri: uriOf("src/zfmt.prog.abap") },
        options: { tabSize: 2, insertSpaces: true },
      }),
      [],
    );
  } finally {
    close("src/zfmt.prog.abap");
  }
});

test("renaming a variable edits every use, for the open document's version", async () => {
  await openChecked("src/zgreet.prog.abap");
  try {
    const prepared = await connection.sendRequest("textDocument/prepareRename", at("src/zgreet.prog.abap", 2, 7));
    assert.equal(prepared.placeholder, "lv_text");

    const edit = await connection.sendRequest("textDocument/rename", { ...at("src/zgreet.prog.abap", 2, 7), newName: "lv_msg" });
    // One change per file: Zed applies them in order, so several for the
    // same file would each shift the next one's positions.
    assert.equal(edit.documentChanges.length, 1);
    const lines = [];
    for (const change of edit.documentChanges) {
      assert.equal(change.textDocument.uri, uriOf("src/zgreet.prog.abap"));
      assert.equal(typeof change.textDocument.version, "number");
      for (const e of change.edits) {
        assert.equal(e.newText, "lv_msg");
        lines.push(e.range.start.line);
      }
    }
    assert.deepEqual([...new Set(lines)].sort(), [2, 5, 6]);

    // Nothing to rename on a keyword.
    assert.equal(await connection.sendRequest("textDocument/prepareRename", at("src/zgreet.prog.abap", 0, 2)), null);
  } finally {
    close("src/zgreet.prog.abap");
  }
});

test("find references and rename still see other files after an edit", async () => {
  await openChecked("src/zcl_greeter.clas.abap");
  const source = fs.readFileSync(path.join(root, "src/zcl_greeter.clas.abap"), "utf8");
  try {
    const params = { ...at("src/zcl_greeter.clas.abap", 2, 20), context: { includeDeclaration: true } };
    const before = await connection.sendRequest("textDocument/references", params);
    change("src/zcl_greeter.clas.abap", source + "\n");
    const after = await connection.sendRequest("textDocument/references", params);
    assert.deepEqual(after, before);
    assert.ok(after.some((location) => location.uri === uriOf("src/zgreet.prog.abap")));
  } finally {
    close("src/zcl_greeter.clas.abap");
  }
});

test("renaming a method from a call site renames its declaration, in its own file", async () => {
  await openChecked("src/zgreet.prog.abap");
  try {
    const edit = await connection.sendRequest("textDocument/rename", { ...at("src/zgreet.prog.abap", 5, 25), newName: "hello" });
    const byFile = Object.fromEntries(
      edit.documentChanges.map((change) => [path.basename(change.textDocument.uri), change.edits.map((e) => e.range.start.line).sort()]),
    );
    assert.deepEqual(byFile, { "zcl_greeter.clas.abap": [2, 7], "zgreet.prog.abap": [5] });
  } finally {
    close("src/zgreet.prog.abap");
  }
});

test("renaming an interface method renames only the name after intf~", async () => {
  await openChecked("pkg/sub/zif_pkg.intf.abap");
  try {
    // `METHODS run` in zif_pkg; zcl_pkg implements `METHOD zif_pkg~run.`
    const edit = await connection.sendRequest("textDocument/rename", { ...at("pkg/sub/zif_pkg.intf.abap", 1, 11), newName: "go" });
    const implementation = edit.documentChanges.find((change) => change.textDocument.uri === uriOf("pkg/zcl_pkg.clas.abap"));
    const line = fs.readFileSync(path.join(root, "pkg/zcl_pkg.clas.abap"), "utf8").split("\n")[implementation.edits[0].range.start.line];
    const { start, end } = implementation.edits[0].range;
    assert.equal(line.slice(start.character, end.character), "run");
    assert.equal(line.slice(0, start.character).trimStart(), "METHOD zif_pkg~");
  } finally {
    close("pkg/sub/zif_pkg.intf.abap");
  }
});

test("rename is refused for built-ins and parameters", async () => {
  const text = [
    "CLASS zcl_greeter DEFINITION PUBLIC FINAL CREATE PUBLIC.",
    "  PUBLIC SECTION.",
    "    CLASS-METHODS greet",
    "      IMPORTING iv_name TYPE string OPTIONAL",
    "      RETURNING VALUE(rv_text) TYPE string.",
    "ENDCLASS.",
    "",
    "CLASS zcl_greeter IMPLEMENTATION.",
    "  METHOD greet.",
    "    rv_text = iv_name.",
    "    IF sy-subrc = 0.",
    "    ENDIF.",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  await openChecked("src/zcl_greeter.clas.abap", text);
  try {
    for (const [line, character, name] of [[10, 8, "sy"], [9, 16, "iv_name"]]) {
      assert.equal(await connection.sendRequest("textDocument/prepareRename", at("src/zcl_greeter.clas.abap", line, character)), null, name);
      await assert.rejects(
        connection.sendRequest("textDocument/rename", { ...at("src/zcl_greeter.clas.abap", line, character), newName: "zz" }),
        new RegExp(name),
      );
    }
  } finally {
    close("src/zcl_greeter.clas.abap");
  }
});

test("requests work with the cursor just after a name", async () => {
  await openChecked("src/zgreet.prog.abap");
  try {
    // Right after `lv_text` in `  WRITE lv_text.`
    const found = await connection.sendRequest("textDocument/definition", at("src/zgreet.prog.abap", 6, 15));
    assert.deepEqual(found.range.start, { line: 2, character: 5 });
    const prepared = await connection.sendRequest("textDocument/prepareRename", at("src/zgreet.prog.abap", 2, 12));
    assert.equal(prepared.placeholder, "lv_text");
  } finally {
    close("src/zgreet.prog.abap");
  }
});

test("renaming a class renames its files and its uses", async () => {
  await openChecked("src/zgreet.prog.abap");
  try {
    const edit = await connection.sendRequest("textDocument/rename", { ...at("src/zgreet.prog.abap", 5, 14), newName: "zcl_hello" });
    const renames = edit.documentChanges.filter((change) => change.kind === "rename");
    assert.deepEqual(
      renames.map((rename) => [path.basename(rename.oldUri), path.basename(rename.newUri)]).sort(),
      [
        ["zcl_greeter.clas.abap", "zcl_hello.clas.abap"],
        ["zcl_greeter.clas.xml", "zcl_hello.clas.xml"],
      ],
    );
    // Renames come after the text edits, which use the old names.
    assert.equal(edit.documentChanges.at(-1).kind, "rename");
    const edited = edit.documentChanges.filter((change) => change.textDocument).map((change) => path.basename(change.textDocument.uri));
    assert.ok(edited.includes("zgreet.prog.abap"), edited.join());
    assert.ok(edited.includes("zcl_greeter.clas.abap"), edited.join());
    // The dependency folder's copy is left alone.
    assert.ok(edit.documentChanges.every((change) => !(change.textDocument?.uri ?? change.oldUri).includes("/deps/")));
  } finally {
    close("src/zgreet.prog.abap");
  }
});

test("dependency files can be read but not changed", async () => {
  await openChecked("deps/src/zcl_dep.clas.abap");
  try {
    const hover = await connection.sendRequest("textDocument/hover", at("deps/src/zcl_dep.clas.abap", 0, 8));
    assert.ok(hover !== null);
    assert.equal(await connection.sendRequest("textDocument/prepareRename", at("deps/src/zcl_dep.clas.abap", 0, 8)), null);
    assert.equal(
      await connection.sendRequest("textDocument/formatting", {
        textDocument: { uri: uriOf("deps/src/zcl_dep.clas.abap") },
        options: { tabSize: 2, insertSpaces: true },
      }),
      null,
    );
  } finally {
    close("deps/src/zcl_dep.clas.abap");
  }
});

test("quick fixes come from the findings at the cursor", async () => {
  // Outside every project, so the default config (with implement_methods) applies.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zed-abaplint-fix-"));
  const uri = pathToFileURL(path.join(outside, "zfix.prog.abap")).href;
  const text = [
    "REPORT zfix.",
    "INTERFACE lif_run.",
    "  METHODS run.",
    "ENDINTERFACE.",
    "CLASS lcl_run DEFINITION.",
    "  PUBLIC SECTION.",
    "    INTERFACES lif_run.",
    "ENDCLASS.",
    "CLASS lcl_run IMPLEMENTATION.",
    "ENDCLASS.",
    "",
  ].join("\n");
  try {
    const checked = nextDiagnostics(uri, (d) => codes(d).includes("implement_methods"));
    connection.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "abap", version: version++, text } });
    const [finding] = (await checked).filter((d) => d.code === "implement_methods");

    const actions = await connection.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range: finding.range,
      context: { diagnostics: [finding] },
    });
    assert.equal(actions.length, 1, JSON.stringify(actions));
    assert.equal(actions[0].kind, "quickfix");
    assert.equal(actions[0].diagnostics[0].code, "implement_methods");
    const [change] = actions[0].edit.documentChanges;
    assert.equal(change.textDocument.uri, uri);
    assert.match(change.edits.map((e) => e.newText).join(""), /METHOD lif_run~run/i);

    // Nothing at a line without findings.
    const none = await connection.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [] },
    });
    assert.deepEqual(none, []);
    connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
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

test("findFiles doesn't walk deeper than a glob without ** can match", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-abaplint-depth-"));
  try {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "zcl_a.clas.abap"), "");
    fs.writeFileSync(path.join(dir, "sub", "zcl_b.clas.abap"), "");
    const prefix = dir.split(path.sep).join("/");
    assert.deepEqual(findFiles(prefix, "/*.*"), [`${prefix}/zcl_a.clas.abap`]);
    assert.equal(findFiles(prefix, "/**/*.*").length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
