#!/usr/bin/env node
// abaplint language server for Zed: publishes @abaplint/core findings as LSP
// diagnostics. The Zed extension (src/lib.rs) embeds this file, writes it next
// to the npm packages it installs and runs it with `node server.js --stdio`.
//
// Project model, matching the abaplint CLI:
// - The config is abaplint.json / abaplint.jsonc / abaplint.json5 in the
//   workspace root, or abaplint's default config if there is none.
// - The files matching `global.files` (relative to the root) are loaded into
//   one registry, so references between objects resolve. Local folder
//   dependencies are loaded first, as dependencies (an object that is also in
//   the project is the project's).
// - Registry filenames are absolute paths with `/` separators, so `exclude`
//   and `noIssues` patterns see the same names as with the CLI.
// Open documents replace their file's disk contents in the registry. A file
// without an abapGit name (`report.abap` instead of `zreport.prog.abap`) is
// checked on its own, as a program.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const abaplint = require("@abaplint/core");
const {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  MessageType,
  ShowMessageNotification,
  DiagnosticSeverity,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");

const CONFIG_NAMES = ["abaplint.json", "abaplint.jsonc", "abaplint.json5"];
// abaplint's default for `global.files` and for a dependency's `files`.
const DEFAULT_FILES = "/src/**/*.*";
// Delay between the last edit and recomputing diagnostics.
const DEBOUNCE_MS = 300;
// macOS and Windows file systems ignore case by default.
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

// Set by main(); the helpers below also work without it (tests).
let connection;
let documents;

function log(message) {
  if (connection === undefined) {
    process.stderr.write(`[abaplint] ${message}\n`);
  } else {
    connection.console.log(`[abaplint] ${message}`);
  }
}

/** Logs `message` and shows it in the editor. */
function warn(message) {
  log(message);
  // A notification, not window.showWarningMessage(): that is a request the
  // client has to answer.
  connection?.sendNotification(ShowMessageNotification.type, {
    type: MessageType.Warning,
    message: `abaplint: ${message}`,
  });
}

function errorDetail(error) {
  return error instanceof Error && error.stack ? error.stack : errorMessage(error);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Paths and names

/** Absolute filesystem path with `/` separators (the registry filename). */
function toUnixPath(fsPath) {
  return fsPath.split(path.sep).join("/");
}

/** Registry filename for a `file:` URI, or undefined for other schemes. */
function uriToFilename(uri) {
  if (!uri.startsWith("file:")) {
    return undefined;
  }
  try {
    return toUnixPath(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

/** Key for comparing filenames the way the file system does. */
function fileKey(filename) {
  return CASE_INSENSITIVE ? filename.toUpperCase() : filename;
}

function basename(filename) {
  return filename.slice(filename.lastIndexOf("/") + 1);
}

/**
 * True for abapGit / AFF style names that abaplint can map to an object,
 * `name.type.ext` with a type it knows (`zcl_x.clas.abap`, `ztab.tabl.xml`).
 */
function isObjectFilename(filename) {
  const parts = basename(filename).split(".");
  if (parts.length < 3 || parts[0] === "" || parts[1] === "") {
    return false;
  }
  // core doesn't export UnknownObject, which it returns for unknown types.
  const object = abaplint.ArtifactsObjects.newObject(parts[0].toUpperCase(), parts[1].toUpperCase());
  return object.constructor.name !== "UnknownObject";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Converts a glob to the body of a regex over `/` paths. */
function globToRegExpSource(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const segmentStart = i === 0 || glob[i - 1] === "/";
        const segmentEnd = i + 2 === glob.length || glob[i + 2] === "/";
        i++;
        if (segmentStart && segmentEnd) {
          if (glob[i + 1] === "/") {
            i++;
            re += "(?:[^/]*/)*";
          } else {
            re += ".*";
          }
          continue;
        }
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        continue;
      }
      const options = glob.slice(i + 1, end).split(",").map(globToRegExpSource);
      re += `(?:${options.join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
      if (body.startsWith("!")) {
        body = "^" + body.slice(1);
      }
      re += `[${body}]`;
      i = end;
    } else {
      re += escapeRegExp(c);
    }
  }
  return re;
}

/**
 * Regex for the paths under `prefix` (a literal directory, never read as
 * glob syntax) that match `glob` (`/src/**\/*.*`, `{a,b}`, `?`, `[abc]`).
 * `*` and `?` don't match `/`; `**` as a whole path segment matches any
 * number of directories, including none.
 */
function globToRegExp(glob, prefix = "") {
  return new RegExp(`^${escapeRegExp(prefix)}${globToRegExpSource(glob)}$`, CASE_INSENSITIVE ? "i" : "");
}

/** The directory part of a glob before its first wildcard segment. */
function globBase(glob) {
  const segments = glob.split("/");
  const fixed = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?{[]/.test(segment)) {
      break;
    }
    fixed.push(segment);
  }
  return fixed.join("/");
}

/**
 * Files under `prefix` that match `glob`. Like the CLI's glob: symlinks are
 * followed, and names starting with `.` (and node_modules) are skipped.
 */
function findFiles(prefix, glob) {
  const matcher = globToRegExp(glob, prefix);
  const found = [];
  const seen = new Set();
  const walk = (dir) => {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) {
      return;
    }
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const full = dir.endsWith("/") ? dir + entry.name : `${dir}/${entry.name}`;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        walk(full);
      } else if (isFile && matcher.test(full)) {
        found.push(full);
      }
    }
  };
  walk(prefix + globBase(glob) || "/");
  return found;
}

function readText(filename) {
  try {
    return fs.readFileSync(filename, "utf8");
  } catch {
    return undefined;
  }
}

/** Object files among `filenames`, read from disk. */
function readObjectFiles(filenames) {
  const files = [];
  for (const filename of filenames) {
    const text = isObjectFilename(filename) ? readText(filename) : undefined;
    if (text !== undefined) {
      files.push(new abaplint.MemoryFile(filename, text));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Config

/** Problems that would make abaplint throw later, on every check. */
function invalidRegexes(config) {
  const raw = config.get();
  const problems = [];
  const check = (where, pattern) => {
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      problems.push(`${where}: ${JSON.stringify(pattern)} is not a regular expression (${errorMessage(error)})`);
    }
  };
  for (const pattern of raw.global?.exclude ?? []) check("global.exclude", pattern);
  for (const pattern of raw.global?.noIssues ?? []) check("global.noIssues", pattern);
  if (raw.syntax?.errorNamespace !== undefined) check("syntax.errorNamespace", raw.syntax.errorNamespace);
  for (const [rule, settings] of Object.entries(raw.rules ?? {})) {
    for (const pattern of settings?.exclude ?? []) check(`rules.${rule}.exclude`, pattern);
  }
  return problems;
}

/** `syntax.version` as written in a config's text (JSON5, like abaplint). */
function rawSyntaxVersion(text) {
  try {
    // A dependency of @abaplint/core, which parses configs with it.
    return require("json5").parse(text)?.syntax?.version;
  } catch {
    return undefined;
  }
}

/**
 * Reads the root's config. Falls back to abaplint's default config (with a
 * warning) if it can't be used.
 */
function readConfig(root) {
  for (const name of CONFIG_NAMES) {
    const filename = `${root}/${name}`;
    const text = readText(filename);
    if (text === undefined) {
      continue;
    }
    let config;
    try {
      config = new abaplint.Config(text);
    } catch (error) {
      warn(`${filename}: ${errorMessage(error)}. Using abaplint's default config.`);
      return abaplint.Config.getDefault();
    }
    const problems = invalidRegexes(config);
    if (problems.length > 0) {
      warn(`${filename}: ${problems.join("; ")}. Using abaplint's default config.`);
      return abaplint.Config.getDefault();
    }
    // Like the CLI. abaplint itself replaces an unknown version with the
    // newest release, so this reads the raw text.
    const version = rawSyntaxVersion(text);
    if (typeof version === "string" && !Object.values(abaplint.Version).includes(version)) {
      warn(
        `${filename}: unknown syntax.version ${JSON.stringify(version)}, checking against the newest release. ` +
          `Known versions: ${Object.values(abaplint.Version).join(", ")}.`,
      );
    }
    log(`Using config ${filename}`);
    return config;
  }
  log(`No ${CONFIG_NAMES.join(" / ")} in ${root}, using abaplint's default config`);
  return abaplint.Config.getDefault();
}

// ---------------------------------------------------------------------------
// Diagnostics

const SEVERITIES = {
  [abaplint.Severity.Error]: DiagnosticSeverity.Error,
  [abaplint.Severity.Warning]: DiagnosticSeverity.Warning,
  [abaplint.Severity.Info]: DiagnosticSeverity.Information,
};

/** The issues located in `filename`, as LSP diagnostics, without duplicates. */
function toDiagnostics(issues, filename) {
  const upper = filename.toUpperCase();
  const seen = new Set();
  const diagnostics = [];
  for (const issue of issues) {
    if (issue.getFilename().toUpperCase() !== upper) {
      continue;
    }
    const diagnostic = {
      severity: SEVERITIES[issue.getSeverity()] ?? DiagnosticSeverity.Error,
      range: {
        start: { line: issue.getStart().getRow() - 1, character: issue.getStart().getCol() - 1 },
        end: { line: issue.getEnd().getRow() - 1, character: issue.getEnd().getCol() - 1 },
      },
      code: issue.getKey(),
      codeDescription: { href: `https://rules.abaplint.org/${issue.getKey()}/` },
      message: issue.getMessage().toString(),
      source: "abaplint",
    };
    const key = JSON.stringify([diagnostic.code, diagnostic.range, diagnostic.message]);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

/** Statement that includes the include `name` (`INCLUDE name.`, `INCLUDE name IF FOUND.`). */
function includeStatement(name) {
  return new RegExp(`^[ \\t]*INCLUDE[ \\t]+${escapeRegExp(name)}(?:[ \\t]+IF[ \\t]+FOUND)?[ \\t]*\\.`, "im");
}

/**
 * Checks a file in a registry of its own: a file without an abapGit name as a
 * program, an object file as itself.
 */
function standaloneDiagnostics(filename, text, config) {
  let name = filename;
  if (!isObjectFilename(filename)) {
    const base = basename(filename);
    name = `${filename.slice(0, filename.length - base.length)}${base.split(".")[0] || "program"}.prog.abap`;
  }
  const registry = new abaplint.Registry(config);
  registry.addFile(new abaplint.MemoryFile(name, text));
  const object = registry.findObjectForFile(registry.getFileByName(name));
  return object === undefined ? [] : toDiagnostics(registry.findIssuesObject(object), name);
}

// ---------------------------------------------------------------------------
// Projects

/** A workspace root: its config and a registry of its files. */
class Project {
  constructor(root) {
    this.root = root; // registry-style path, no trailing slash
    this.load();
  }

  /**
   * (Re)reads the config and every project and dependency file. Nothing is
   * replaced until the new registry is complete; if the config can't be
   * loaded (abaplint throws on some settings), the default config is used.
   */
  load() {
    let state;
    const config = readConfig(this.root);
    try {
      state = this.build(config);
    } catch (error) {
      warn(`${this.root}: ${errorMessage(error)}. Using abaplint's default config.`);
      state = this.build(abaplint.Config.getDefault());
    }
    Object.assign(this, state);
    log(`${this.root}: ${state.projectFiles} files, ${state.dependencyFiles.size} dependency files`);
  }

  build(config) {
    const registry = new abaplint.Registry(config);
    const globs = [].concat(config.getGlobal().files ?? DEFAULT_FILES);
    const dependencyGlobs = [];
    for (const dependency of config.get().dependencies ?? []) {
      if (dependency.folder) {
        dependencyGlobs.push({ prefix: this.root + dependency.folder, glob: dependency.files ?? DEFAULT_FILES });
      } else if (dependency.url) {
        log(`Skipping dependency ${dependency.url}: git dependencies aren't supported, clone it and use "folder"`);
      }
    }

    // Dependencies first, like the CLI: project files then replace any
    // object they also define.
    const dependencies = readObjectFiles(dependencyGlobs.flatMap(({ prefix, glob }) => findFiles(prefix, glob)));
    registry.addDependencies(dependencies);
    const files = readObjectFiles(globs.flatMap((glob) => findFiles(this.root, glob)));
    registry.addFiles(files);

    const projectKeys = new Set(files.map((file) => fileKey(file.getFilename())));
    return {
      config,
      registry,
      projectFiles: files.length,
      matchers: globs.map((glob) => globToRegExp(glob, this.root)),
      dependencyMatchers: dependencyGlobs.map(({ prefix, glob }) => globToRegExp(glob, prefix)),
      // Dependency files that aren't also project files.
      dependencyFiles: new Set(
        dependencies.map((file) => fileKey(file.getFilename())).filter((key) => !projectKeys.has(key)),
      ),
      // Object files outside `global.files` added while open in an editor.
      extraFiles: new Set(),
      // Bumped on every registry change. abaplint caches each object's syntax
      // result until that object changes, so an object checked before the
      // last change is marked dirty before checking it again: the change may
      // have been to something it uses.
      changes: 0,
      checkedAt: new WeakMap(),
      // Set by a change to anything but a program. abaplint also caches the
      // global definitions of classes and interfaces, which include types
      // from other objects, until that class or interface itself changes.
      definitionsStale: false,
    };
  }

  contains(filename) {
    return fileKey(filename).startsWith(fileKey(this.root + "/"));
  }

  isProjectFile(filename) {
    return this.matchers.some((matcher) => matcher.test(filename));
  }

  isDependencyFile(filename) {
    return this.dependencyFiles.has(fileKey(filename));
  }

  isInDependencyFolder(filename) {
    return this.dependencyMatchers.some((matcher) => matcher.test(filename));
  }

  isExtraFile(filename) {
    return this.extraFiles.has(fileKey(filename));
  }

  isConfigFile(filename) {
    return CONFIG_NAMES.some((name) => fileKey(filename) === fileKey(`${this.root}/${name}`));
  }

  /**
   * Whether an editor's copy of an object file outside `global.files` can be
   * added to the project. Not if the project already has that object from
   * other files (a backup or a nested copy would merge into it).
   */
  canAdd(filename) {
    const file = new abaplint.MemoryFile(filename, "");
    const object = this.registry.getObject(file.getObjectType(), file.getObjectName());
    return object === undefined || this.registry.getFileByName(filename) !== undefined;
  }

  changed(filename) {
    this.changes++;
    if (new abaplint.MemoryFile(filename, "").getObjectType() !== "PROG") {
      this.definitionsStale = true;
    }
  }

  /**
   * Puts `text` into the registry as the contents of `filename`. Returns
   * false if it already had that text.
   */
  setFile(filename, text) {
    const existing = this.registry.getFileByName(filename);
    if (existing !== undefined && existing.getRaw() === text) {
      return false;
    }
    this.changed(filename);
    // The registry looks names up ignoring case, but updates by exact name.
    const file = new abaplint.MemoryFile(existing?.getFilename() ?? filename, text);
    if (existing === undefined) {
      this.registry.addFile(file);
    } else {
      this.registry.updateFile(file);
    }
    return true;
  }

  removeFile(filename) {
    const file = this.registry.getFileByName(filename);
    if (file !== undefined) {
      this.changed(filename);
      this.registry.removeFile(file);
    }
  }

  /** Sets `filename` to its disk contents, or removes it if it's gone. */
  reloadFile(filename) {
    const text = readText(filename);
    if (text === undefined) {
      this.removeFile(filename);
    } else {
      this.setFile(filename, text);
    }
  }

  /** Marks `object` dirty if the registry changed since it was last checked. */
  refresh(object) {
    const checked = this.checkedAt.get(object);
    if (checked !== undefined && checked !== this.changes) {
      object.setDirty();
    }
    this.checkedAt.set(object, this.changes);
  }

  /** The programs that include `include`, directly or through other includes. */
  mainPrograms(include, seen = new Set()) {
    seen.add(include);
    const statement = includeStatement(include.getName());
    const mains = [];
    for (const object of this.registry.getObjectsByType("PROG")) {
      if (seen.has(object) || this.registry.isDependency(object)) {
        continue;
      }
      if (object.getFiles().some((file) => file.getFilename().endsWith(".abap") && statement.test(file.getRaw()))) {
        seen.add(object);
        if (object.isInclude()) {
          mains.push(...this.mainPrograms(object, seen));
        } else {
          mains.push(object);
        }
      }
    }
    return mains;
  }

  diagnostics(filename) {
    const file = this.registry.getFileByName(filename);
    const object = file === undefined ? undefined : this.registry.findObjectForFile(file);
    if (object === undefined) {
      return []; // excluded by global.exclude
    }
    if (this.definitionsStale) {
      this.definitionsStale = false;
      for (const other of this.registry.getObjects()) {
        if (typeof other.setDefinition === "function") {
          other.setDefinition(undefined);
        }
      }
      // The registry only rebuilds definitions while something is dirty.
      object.setDirty();
    }
    this.refresh(object);
    const issues = this.registry.findIssuesObject(object);
    // An include has no syntax check of its own: its errors are found by
    // checking the programs that include it.
    if (object.getType() === "PROG" && object.isInclude()) {
      for (const main of this.mainPrograms(object)) {
        this.refresh(main);
        issues.push(...this.registry.findIssuesObject(main));
      }
    }
    return toDiagnostics(issues, file.getFilename());
  }
}

let projects = [];
// Config for files outside every workspace root.
const defaultConfig = abaplint.Config.getDefault();

function projectFor(filename) {
  let best;
  for (const project of projects) {
    if (project.contains(filename) && (best === undefined || project.root.length > best.root.length)) {
      best = project;
    }
  }
  return best;
}

/**
 * How an open document is checked: "project" (in its project's registry),
 * "dependency" (not checked) or "standalone" (on its own).
 */
function route(filename) {
  const project = projectFor(filename);
  if (project === undefined || !isObjectFilename(filename)) {
    return { kind: "standalone", project };
  }
  if (project.isProjectFile(filename) || project.isExtraFile(filename)) {
    return { kind: "project", project };
  }
  if (project.isDependencyFile(filename)) {
    return { kind: "dependency", project };
  }
  return { kind: "standalone", project };
}

// ---------------------------------------------------------------------------
// Documents

function documentDiagnostics(document) {
  const filename = uriToFilename(document.uri);
  if (filename === undefined) {
    return [];
  }
  const { kind, project } = route(filename);
  if (kind === "project") {
    return project.diagnostics(filename);
  }
  if (kind === "dependency") {
    return [];
  }
  return standaloneDiagnostics(filename, document.getText(), project?.config ?? defaultConfig);
}

function publish(document) {
  let diagnostics;
  try {
    diagnostics = documentDiagnostics(document);
  } catch (error) {
    log(`${document.uri}: ${errorDetail(error)}`);
    // Replaces the previous findings, which may no longer be true.
    diagnostics = [
      {
        severity: DiagnosticSeverity.Warning,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        message: `abaplint couldn't check this file: ${errorMessage(error)} (details in the language server log)`,
        source: "abaplint",
      },
    ];
  }
  connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
}

let pending;
// Documents whose own text changed, checked first.
const changedUris = new Set();
// Set when a project's registry changed: every open project file is
// rechecked, since a change to one object can affect another's findings.
let projectChanged = false;

function isProjectDocument(uri) {
  const filename = uriToFilename(uri);
  return filename !== undefined && route(filename).kind === "project";
}

/** Recomputes diagnostics after a short pause in changes. */
function scheduleDiagnostics({ uri, project = false, all = false }) {
  if (uri !== undefined) {
    changedUris.add(uri);
  }
  projectChanged ||= project;
  if (all) {
    for (const document of documents.all()) {
      changedUris.add(document.uri);
    }
  }
  clearTimeout(pending);
  pending = setTimeout(() => {
    pending = undefined;
    const open = documents.all();
    const queue = open.filter((document) => changedUris.has(document.uri));
    if (projectChanged) {
      queue.push(...open.filter((document) => !changedUris.has(document.uri) && isProjectDocument(document.uri)));
    }
    changedUris.clear();
    projectChanged = false;
    for (const document of queue) {
      publish(document);
    }
  }, DEBOUNCE_MS);
}

/**
 * Puts an open document's text into its project's registry. Returns true if
 * the registry changed.
 */
function syncDocument(document, only) {
  const filename = uriToFilename(document.uri);
  if (filename === undefined || !isObjectFilename(filename)) {
    return false;
  }
  const project = projectFor(filename);
  if (project === undefined || (only !== undefined && project !== only)) {
    return false;
  }
  if (!project.isProjectFile(filename) && !project.isExtraFile(filename)) {
    // Dependencies are read-only; other copies of project objects are
    // checked on their own.
    if (project.isDependencyFile(filename) || !project.canAdd(filename)) {
      return false;
    }
    project.extraFiles.add(fileKey(filename));
  }
  return project.setFile(filename, document.getText());
}

function onDidChangeContent(event) {
  let changed = false;
  try {
    changed = syncDocument(event.document);
  } catch (error) {
    log(`${event.document.uri}: ${errorDetail(error)}`);
  }
  scheduleDiagnostics({ uri: event.document.uri, project: changed });
}

function onDidClose(event) {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  const filename = uriToFilename(event.document.uri);
  if (filename === undefined) {
    return;
  }
  const { kind, project } = route(filename);
  if (kind !== "project") {
    return;
  }
  try {
    if (project.isProjectFile(filename)) {
      project.reloadFile(filename);
    } else {
      project.extraFiles.delete(fileKey(filename));
      project.removeFile(filename);
    }
  } catch (error) {
    log(`${event.document.uri}: ${errorDetail(error)}`);
  }
  scheduleDiagnostics({ project: true });
}

// ---------------------------------------------------------------------------
// Watched files

/** Applies a change on disk; returns "config", "file" or undefined (ignored). */
function onWatchedFileChange(change) {
  const filename = uriToFilename(change.uri);
  if (filename === undefined) {
    return undefined;
  }
  const project = projectFor(filename);
  if (project === undefined) {
    return undefined;
  }
  if (project.isConfigFile(filename) || (isObjectFilename(filename) && project.isInDependencyFolder(filename))) {
    log(`${filename} changed, reloading ${project.root}`);
    project.load();
    for (const document of documents.all()) {
      syncDocument(document, project);
    }
    return "config";
  }
  const key = fileKey(filename);
  const open = documents.all().some((document) => fileKey(uriToFilename(document.uri) ?? "") === key);
  if (open || !isObjectFilename(filename) || !project.isProjectFile(filename)) {
    // An open document's editor contents win until it is closed.
    return undefined;
  }
  // Also for Deleted: after a rename that only changes case, the file still
  // exists under its new name, which the registry treats as the same file.
  project.reloadFile(filename);
  return "file";
}

function onDidChangeWatchedFiles(params) {
  let config = false;
  let file = false;
  for (const change of params.changes) {
    try {
      const effect = onWatchedFileChange(change);
      config ||= effect === "config";
      file ||= effect === "file";
    } catch (error) {
      log(`${change.uri}: ${errorDetail(error)}`);
    }
  }
  if (config || file) {
    // A config change can change any document's findings, loose files too.
    scheduleDiagnostics({ project: true, all: config });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle

function onInitialize(params) {
  const roots = (params.workspaceFolders ?? []).map((folder) => folder.uri);
  if (roots.length === 0 && params.rootUri) {
    roots.push(params.rootUri);
  }
  projects = [];
  for (const uri of roots) {
    const root = uriToFilename(uri)?.replace(/\/+$/, "");
    if (root === undefined || projects.some((project) => project.root === root)) {
      continue;
    }
    try {
      projects.push(new Project(root));
    } catch (error) {
      warn(`${root}: ${errorMessage(error)}`);
      log(errorDetail(error));
    }
  }
  const canWatchFiles = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
  connection.onInitialized(() => {
    if (canWatchFiles) {
      connection.client
        .register(DidChangeWatchedFilesNotification.type, {
          watchers: [
            { globPattern: "**/*.{abap,xml,json,asddls,acds,asbdef,asdcls}" },
            { globPattern: `**/{${CONFIG_NAMES.join(",")}}` },
          ],
        })
        .catch((error) => log(`Couldn't watch files: ${errorDetail(error)}`));
    }
  });
  return {
    capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental },
    serverInfo: { name: "abaplint", version: abaplint.Registry.abaplintVersion() },
  };
}

function main() {
  connection = createConnection(ProposedFeatures.all);
  documents = new TextDocuments(TextDocument);
  connection.onInitialize(onInitialize);
  documents.onDidChangeContent(onDidChangeContent);
  documents.onDidClose(onDidClose);
  connection.onDidChangeWatchedFiles(onDidChangeWatchedFiles);
  process.on("uncaughtException", (error) => log(`Uncaught: ${errorDetail(error)}`));
  documents.listen(connection);
  connection.listen();
}

if (require.main === module) {
  main();
}

module.exports = { globToRegExp, globBase, isObjectFilename, findFiles };
