#!/usr/bin/env node
// abaplint language server for Zed: publishes @abaplint/core findings as LSP
// diagnostics. The Zed extension (src/lib.rs) embeds this file, writes it next
// to the npm packages it installs and runs it with `node server.js --stdio`.
//
// Project model, matching the abaplint CLI:
// - The config is abaplint.json / abaplint.jsonc / abaplint.json5 in the
//   workspace root. Without one, abaplint's default config with only the
//   rules that find real errors (DEFAULT_RULES), not its style rules.
// - The files matching `global.files` (relative to the root) are loaded into
//   one registry, so references between objects resolve. Local folder
//   dependencies are loaded first, as dependencies (an object that is also in
//   the project is the project's).
// - Registry filenames are absolute paths with `/` separators, so `exclude`
//   and `noIssues` patterns see the same names as with the CLI.
// - An object file outside `global.files` brings its abapGit package folder
//   into the registry when it is opened, so the objects next to it resolve.
// Open documents replace their file's disk contents in the registry. A file
// without an abapGit name (`report.abap` instead of `zreport.prog.abap`) is
// checked on its own, as a program.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
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
  CodeActionKind,
  LSPErrorCodes,
  ResponseError,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");

const CONFIG_NAMES = ["abaplint.json", "abaplint.jsonc", "abaplint.json5"];
// abaplint's default for `global.files` and for a dependency's `files`.
const DEFAULT_FILES = "/src/**/*.*";
// The rules checked without a config: errors, not style.
const DEFAULT_RULES = [
  "parser_error",
  "check_syntax",
  "unknown_types",
  "implement_methods",
  "method_implemented_twice",
  "superclass_final",
  "cyclic_oo",
  "check_include",
  "xml_consistency",
];
// Marks an abapGit package folder.
const PACKAGE_FILE = "package.devc.xml";
// Delay between the last edit and recomputing diagnostics.
const DEBOUNCE_MS = 300;
// macOS and Windows file systems ignore case by default.
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

// Used without a config, with a config that can't be used, and for files
// outside every workspace root.
const defaultConfig = makeDefaultConfig();

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
  // Without `**`, the glob can't match below a fixed depth.
  const base = globBase(glob);
  const maxDepth = glob.includes("**") ? Infinity : glob.split("/").length - base.split("/").length - 1;
  const walk = (dir, depth) => {
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
        if (depth < maxDepth) {
          walk(full, depth + 1);
        }
      } else if (isFile && matcher.test(full)) {
        found.push(full);
      }
    }
  };
  walk(prefix + base || "/", 0);
  return found;
}

function dirname(filename) {
  const slash = filename.lastIndexOf("/");
  return slash <= 0 ? "/" : filename.slice(0, slash);
}

/**
 * The abapGit package folder of `filename` (in `root`): the top of the chain
 * of folders holding package.devc.xml, with its subfolders. A folder without
 * one is just that folder.
 */
function packageFolder(filename, root) {
  let dir = dirname(filename);
  if (!fs.existsSync(`${dir}/${PACKAGE_FILE}`)) {
    return { dir, glob: "/*.*" };
  }
  const inRoot = (candidate) => fileKey(`${candidate}/`).startsWith(fileKey(`${root}/`));
  for (let parent = dirname(dir); parent !== dir && inRoot(parent); parent = dirname(parent)) {
    if (!fs.existsSync(`${parent}/${PACKAGE_FILE}`)) {
      break;
    }
    dir = parent;
  }
  return { dir, glob: "/**/*.*" };
}

/** The editor text of an open document, or undefined. */
function openDocumentText(filename) {
  const key = fileKey(filename);
  for (const document of documents?.all() ?? []) {
    if (fileKey(uriToFilename(document.uri) ?? "") === key) {
      return document.getText();
    }
  }
  return undefined;
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

/** abaplint's default config with only DEFAULT_RULES. */
function makeDefaultConfig() {
  const config = abaplint.Config.getDefault().get();
  config.rules = Object.fromEntries(DEFAULT_RULES.map((rule) => [rule, true]));
  return new abaplint.Config(JSON.stringify(config));
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
 * Reads the root's config. Falls back to the default config (with a warning)
 * if it can't be used.
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
      warn(`${filename}: ${errorMessage(error)}. Using the default config.`);
      return defaultConfig;
    }
    const problems = invalidRegexes(config);
    if (problems.length > 0) {
      warn(`${filename}: ${problems.join("; ")}. Using the default config.`);
      return defaultConfig;
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
  log(`No ${CONFIG_NAMES.join(" / ")} in ${root}, using the default config (${DEFAULT_RULES.join(", ")})`);
  return defaultConfig;
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

// The registry of each open document checked on its own, by URI. Hover and
// the other requests reuse it until the document or the config changes.
const standalones = new Map();

/**
 * A registry of its own for an open document: a file without an abapGit name
 * as a program (`<stem>.prog.abap`), an object file as itself. Returns
 * `{ registry, name }`, `name` being the file's name in the registry.
 */
function standaloneRegistry(document, filename, config) {
  const cached = standalones.get(document.uri);
  if (cached !== undefined && cached.version === document.version && cached.config === config) {
    return cached;
  }
  let name = filename;
  if (!isObjectFilename(filename)) {
    const base = basename(filename);
    name = `${filename.slice(0, filename.length - base.length)}${base.split(".")[0] || "program"}.prog.abap`;
  }
  const registry = new abaplint.Registry(config);
  registry.addFile(new abaplint.MemoryFile(name, document.getText()));
  const entry = { version: document.version, config, registry, name };
  standalones.set(document.uri, entry);
  return entry;
}

/** The findings for a file checked on its own, as for Project.issues(). */
function standaloneIssues({ registry, name }) {
  const file = registry.getFileByName(name); // undefined if global.exclude matches
  const object = file === undefined ? undefined : registry.findObjectForFile(file);
  return object === undefined ? undefined : { issues: registry.findIssuesObject(object), filename: name };
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
    const folders = this.folders ?? [];
    // Keeps counting up across reloads: cached findings are keyed by it.
    const changes = (this.changes ?? 0) + 1;
    let state;
    const config = readConfig(this.root);
    try {
      state = this.build(config);
    } catch (error) {
      warn(`${this.root}: ${errorMessage(error)}. Using the default config.`);
      state = this.build(defaultConfig);
    }
    Object.assign(this, state, { changes });
    log(`${this.root}: ${state.projectFiles} files, ${state.dependencyFiles.size} dependency files`);
    for (const folder of folders) {
      try {
        this.addFolder(folder);
      } catch (error) {
        log(`${folder.dir}: ${errorDetail(error)}`);
      }
    }
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
      // Object files outside `global.files`: open in an editor, or in the
      // package folder of one that was.
      extraFiles: new Set(),
      // Package folders loaded for files outside `global.files`, each
      // `{ dir, glob, matcher }`.
      folders: [],
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

  /** Whether `filename` is in a package folder loaded by addFolder(). */
  isFolderFile(filename) {
    return this.folders.some((folder) => folder.matcher.test(filename));
  }

  isConfigFile(filename) {
    return CONFIG_NAMES.some((name) => fileKey(filename) === fileKey(`${this.root}/${name}`));
  }

  /**
   * Whether an object file outside `global.files` can be added to the
   * project: only as a new object, or as another file of an object already
   * added from the same folder. A backup or another copy of an object would
   * merge into it.
   */
  canAdd(filename) {
    const object = this.objectOf(filename);
    const dir = fileKey(dirname(filename));
    return (
      object === undefined ||
      object
        .getFiles()
        .every((other) => this.isExtraFile(other.getFilename()) && fileKey(dirname(other.getFilename())) === dir)
    );
  }

  objectOf(filename) {
    const file = new abaplint.MemoryFile(filename, "");
    return this.registry.getObject(file.getObjectType(), file.getObjectName());
  }

  /**
   * Removes the files of `filename`'s object that came from outside
   * `global.files`, so a project file for that object doesn't merge with
   * them. They are then checked on their own.
   */
  evictExtras(filename) {
    for (const other of this.objectOf(filename)?.getFiles() ?? []) {
      if (this.isExtraFile(other.getFilename())) {
        this.extraFiles.delete(fileKey(other.getFilename()));
        this.removeFile(other.getFilename());
      }
    }
  }

  /**
   * Adds an object file outside `global.files` from disk, if it can be.
   * Returns true if the registry changed.
   */
  addExtraFile(filename) {
    if (this.isProjectFile(filename) || this.isInDependencyFolder(filename) || this.isDependencyFile(filename)) {
      return false;
    }
    if (!this.isExtraFile(filename) && !this.canAdd(filename)) {
      return false;
    }
    // An open document's editor text wins over the disk.
    const text = openDocumentText(filename) ?? readText(filename);
    if (text === undefined) {
      return false;
    }
    this.extraFiles.add(fileKey(filename));
    return this.setFile(filename, text);
  }

  /**
   * Loads the object files of a package folder (from packageFolder()) and
   * keeps them in step with the disk. Returns true if the registry changed.
   */
  addFolder({ dir, glob }) {
    if (this.folders.some((folder) => folder.dir === dir && folder.glob === glob)) {
      return false;
    }
    let changed = false;
    for (const filename of findFiles(dir, glob).filter(isObjectFilename)) {
      try {
        changed = this.addExtraFile(filename) || changed;
      } catch (error) {
        log(`${filename}: ${errorMessage(error)}`);
      }
    }
    // Only now: isFolderFile() is true for its files once they're loaded.
    this.folders.push({ dir, glob, matcher: globToRegExp(glob, dir) });
    log(`${dir}: loaded the package folder of a file outside global.files`);
    return changed;
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

  /**
   * Marks `object` dirty unless it was checked through here since the last
   * registry change. Also if it was never checked here: abaplint may have
   * cached results for it while checking other objects (cyclic_oo, finding
   * implementations).
   */
  refresh(object) {
    if (this.checkedAt.get(object) !== this.changes) {
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

  /** The object of a file in the registry, or undefined (also if excluded by global.exclude). */
  objectForFile(filename) {
    const file = this.registry.getFileByName(filename);
    return file === undefined ? undefined : this.registry.findObjectForFile(file);
  }

  /**
   * Makes abaplint's cached results for `object` current. With `all`, for
   * every object, as finding references or renaming looks at all of them.
   */
  prepare(object, { all = false } = {}) {
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
    if (all) {
      for (const other of this.registry.getObjects()) {
        this.refresh(other);
      }
    } else {
      this.refresh(object);
    }
  }

  /**
   * The findings for `filename`: `{ issues, filename }`, `filename` being its
   * name in the registry. Undefined if global.exclude excludes it.
   */
  issues(filename) {
    const object = this.objectForFile(filename);
    if (object === undefined) {
      return undefined;
    }
    this.prepare(object);
    const issues = this.registry.findIssuesObject(object);
    // An include has no syntax check of its own: its errors are found by
    // checking the programs that include it.
    if (object.getType() === "PROG" && object.isInclude()) {
      for (const main of this.mainPrograms(object)) {
        this.refresh(main);
        issues.push(...this.registry.findIssuesObject(main));
      }
    }
    return { issues, filename: this.registry.getFileByName(filename).getFilename() };
  }
}

let projects = [];

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

// The findings last computed for each open document, by URI, shared by
// diagnostics and code actions: `{ version, changes, result }`, `result`
// being from documentIssues().
const published = new Map();

/** The project-wide change count a document's findings depend on. */
function changesFor(filename) {
  const { kind, project } = route(filename);
  return kind === "standalone" ? project?.config : project.changes;
}

/**
 * An open document's findings: `{ issues, filename }` (its name in the
 * registry), or undefined if it isn't checked.
 */
function documentIssues(document) {
  const filename = uriToFilename(document.uri);
  if (filename === undefined) {
    return undefined;
  }
  const { kind, project } = route(filename);
  if (kind === "project") {
    return project.issues(filename);
  }
  if (kind === "dependency") {
    return undefined;
  }
  return standaloneIssues(standaloneRegistry(document, filename, project?.config ?? defaultConfig));
}

/** documentIssues(), reusing the last result if still current. */
function currentIssues(document) {
  const filename = uriToFilename(document.uri);
  const changes = filename === undefined ? undefined : changesFor(filename);
  const last = published.get(document.uri);
  if (last !== undefined && last.version === document.version && last.changes === changes) {
    return last.result;
  }
  const result = documentIssues(document);
  published.set(document.uri, { version: document.version, changes, result });
  return result;
}

function publish(document) {
  let diagnostics;
  try {
    // Reuses the findings if a code action request already computed them.
    const result = currentIssues(document);
    diagnostics = result === undefined ? [] : toDiagnostics(result.issues, result.filename);
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
  let changed = false;
  if (!project.isProjectFile(filename) && !project.isExtraFile(filename)) {
    // Dependencies are read-only.
    if (project.isDependencyFile(filename)) {
      return false;
    }
    // Other copies of project objects are checked on their own, without
    // bringing in their folder.
    if (!project.canAdd(filename)) {
      return false;
    }
    // The objects next to it, so references to them resolve.
    changed = project.addFolder(packageFolder(filename, project.root));
    if (!project.isExtraFile(filename)) {
      if (!project.canAdd(filename)) {
        return changed;
      }
      project.extraFiles.add(fileKey(filename));
    }
  }
  return project.setFile(filename, document.getText()) || changed;
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
  standalones.delete(event.document.uri);
  published.delete(event.document.uri);
  formatted.delete(event.document.uri);
  const filename = uriToFilename(event.document.uri);
  if (filename === undefined) {
    return;
  }
  const { kind, project } = route(filename);
  if (kind !== "project") {
    return;
  }
  try {
    if (project.isProjectFile(filename) || (project.isFolderFile(filename) && readText(filename) !== undefined)) {
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
// Language features: hover, go to definition and the rest, answered by
// @abaplint/core's LanguageServer. It names files by their registry
// filename where LSP has URIs, so requests and results are translated, and
// its edits are checked before they reach the editor.

// Client capabilities that change how workspace edits are sent.
let clientSupportsDocumentChanges = false;
let clientSupportsFileRenames = false;

/**
 * What a request about `uri` is answered from: `{ registry, filename, uri,
 * project, editable, standaloneName }`. `filename` is the document's name in
 * `registry`. `editable` is false for dependency files, and for a document
 * whose registry copy isn't its editor text. Undefined if the document isn't
 * open or is excluded.
 */
function requestContext(uri, { all = false } = {}) {
  const document = documents.get(uri);
  const filename = uriToFilename(uri);
  if (document === undefined || filename === undefined) {
    return undefined;
  }
  const { kind, project } = route(filename);
  if (kind === "standalone") {
    const { registry, name } = standaloneRegistry(document, filename, project?.config ?? defaultConfig);
    if (registry.getFileByName(name) === undefined) {
      return undefined;
    }
    registry.parse();
    return { registry, filename: name, uri, editable: true, standaloneName: name };
  }
  const object = project.objectForFile(filename);
  if (object === undefined) {
    return undefined;
  }
  project.prepare(object, { all });
  // Before abaplint looks anything up: it would otherwise parse objects
  // itself, without the config's syntax version and macros, and cache that.
  project.registry.parse();
  const file = project.registry.getFileByName(filename);
  return {
    registry: project.registry,
    filename: file.getFilename(),
    uri,
    project,
    editable: kind === "project" && file.getRaw() === document.getText(),
  };
}

/** Whether a rename or fix may change `filename` (a registry filename). */
function isEditableFile(context, filename) {
  if (typeof filename !== "string") {
    return false;
  }
  if (context.standaloneName !== undefined) {
    return fileKey(filename) === fileKey(context.standaloneName);
  }
  const { project } = context;
  return (
    /^(\/|[A-Za-z]:\/)/.test(filename) && // not one of abaplint's built-in definitions
    (project.isProjectFile(filename) || project.isExtraFile(filename)) &&
    !project.isDependencyFile(filename)
  );
}

/** The URI for a registry filename in results, or undefined (abaplint's built-in definitions). */
function filenameToUri(context, filename) {
  if (typeof filename !== "string") {
    return undefined;
  }
  if (context.standaloneName !== undefined) {
    return fileKey(filename) === fileKey(context.standaloneName) ? context.uri : undefined;
  }
  if (!/^(\/|[A-Za-z]:\/)/.test(filename)) {
    return undefined;
  }
  // The open document's own URI, which may differ in case.
  const key = fileKey(filename);
  for (const document of documents.all()) {
    if (fileKey(uriToFilename(document.uri) ?? "") === key) {
      return document.uri;
    }
  }
  return pathToFileURL(filename).href;
}

function toLocation(context, location) {
  const uri = filenameToUri(context, location?.uri);
  return uri === undefined ? undefined : { uri, range: location.range };
}

function toLocations(context, locations) {
  const result = [];
  const seen = new Set();
  for (const location of [].concat(locations ?? [])) {
    const mapped = toLocation(context, location);
    const key = JSON.stringify(mapped);
    if (mapped !== undefined && !seen.has(key)) {
      seen.add(key);
      result.push(mapped);
    }
  }
  return result;
}

/** A position in the context's document, as abaplint's LanguageServer wants it. */
function positionParams(context, position) {
  return { textDocument: { uri: context.filename }, position };
}

const isEmpty = (result) => result === undefined || result === null || (Array.isArray(result) && result.length === 0);

/**
 * Runs `request` at `position`, and if that finds nothing, one character
 * before it: abaplint only finds a token under the cursor, and the cursor is
 * often just after one (after typing or double-clicking a name). Returns
 * `{ result, position }`, the position being the one that was used.
 */
function atCursor(position, request) {
  const result = request(position);
  if (!isEmpty(result) || position.character === 0) {
    return { result, position };
  }
  const before = { line: position.line, character: position.character - 1 };
  const retry = request(before);
  return isEmpty(retry) ? { result, position } : { result: retry, position: before };
}

function requestFailed(message) {
  return new ResponseError(LSPErrorCodes.RequestFailed, message);
}

const comparePositions = (a, b) => a.line - b.line || a.character - b.character;

/** `edits` sorted, without duplicates; throws if two of them overlap. */
function checkedTextEdits(uri, edits) {
  const unique = [...new Map(edits.map((edit) => [JSON.stringify(edit), edit])).values()];
  unique.sort((a, b) => comparePositions(a.range.start, b.range.start) || comparePositions(a.range.end, b.range.end));
  for (let i = 1; i < unique.length; i++) {
    const previous = unique[i - 1].range;
    const next = unique[i].range;
    if (comparePositions(next.start, previous.end) < 0 || comparePositions(next.start, previous.start) === 0) {
      throw requestFailed(`abaplint's changes to ${uri} overlap`);
    }
  }
  return unique;
}

/**
 * The file a renamed object's file is renamed to: `rename.oldName` replaced
 * by `rename.newName` at the start of its name, in the same folder. abaplint
 * replaces the first match anywhere in the path, folders included.
 */
function renamedFile(filename, rename) {
  const toFile = (name) => name.toLowerCase().replaceAll("/", "#"); // abapGit names /NS/X as #ns#x
  const base = basename(filename);
  const from = toFile(rename?.oldName ?? "");
  if (from === "" || !base.toLowerCase().startsWith(`${from}.`)) {
    throw requestFailed(`abaplint can't work out the new name of ${filename}`);
  }
  const renamed = `${dirname(filename)}/${toFile(rename.newName)}${base.slice(from.length)}`;
  if (fileKey(renamed) !== fileKey(filename) && fs.existsSync(renamed)) {
    throw requestFailed(`${renamed} already exists`);
  }
  return renamed;
}

/**
 * Translates an abaplint workspace edit (registry filenames) for the client,
 * with one text edit list per file. Fails if it would change a file that
 * isn't editable, or if its edits overlap. `rename` (`{ oldName, newName }`)
 * is the object rename that renames files, if any.
 */
function toWorkspaceEdit(context, edit, rename) {
  const target = (filename) => {
    if (!isEditableFile(context, filename)) {
      throw requestFailed(
        context.project?.isDependencyFile(filename)
          ? `${filename} is in a dependency folder, which isn't changed`
          : `abaplint can't change ${filename}`,
      );
    }
    return filenameToUri(context, filename);
  };
  const byUri = new Map();
  const addEdits = (uri, edits) => byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits]);
  const renames = [];
  for (const [filename, edits] of Object.entries(edit?.changes ?? {})) {
    addEdits(target(filename), edits);
  }
  for (const change of edit?.documentChanges ?? []) {
    if (change.kind === "rename") {
      if (context.standaloneName !== undefined) {
        throw requestFailed("renaming files needs the file to be part of a project");
      }
      const oldUri = target(change.oldUri);
      const newUri = pathToFileURL(renamedFile(change.oldUri, rename)).href;
      if (oldUri !== newUri) {
        renames.push({ kind: "rename", oldUri, newUri });
      }
    } else if (change.textDocument !== undefined) {
      addEdits(target(change.textDocument.uri), change.edits);
    } else {
      throw requestFailed(`unexpected change ${change.kind ?? ""}`);
    }
  }
  if (renames.length > 0 && !(clientSupportsDocumentChanges && clientSupportsFileRenames)) {
    throw requestFailed("this change renames files, which the editor doesn't support");
  }
  const files = [...byUri].map(([uri, edits]) => ({ uri, edits: checkedTextEdits(uri, edits) }));
  if (!clientSupportsDocumentChanges) {
    return { changes: Object.fromEntries(files.map(({ uri, edits }) => [uri, edits])) };
  }
  const documentChanges = files.map(({ uri, edits }) => ({
    // The open document's version, so the client can refuse an edit made
    // for older text; null for files that aren't open.
    textDocument: { uri, version: documents.get(uri)?.version ?? null },
    edits,
  }));
  // Text edits refer to the files' old names, so they come first.
  return { documentChanges: [...documentChanges, ...renames] };
}

/** Runs a request handler, logging failures; ResponseErrors reach the client. */
function handle(name, handler) {
  return (params) => {
    try {
      return handler(params);
    } catch (error) {
      if (error instanceof ResponseError) {
        return error;
      }
      log(`${name} ${params?.textDocument?.uri ?? ""}: ${errorDetail(error)}`);
      return requestFailed(`abaplint: ${errorMessage(error)}`);
    }
  };
}

function onHover({ textDocument, position }) {
  const context = requestContext(textDocument.uri);
  if (context === undefined) {
    return null;
  }
  const server = new abaplint.LanguageServer(context.registry);
  const { result: hover } = atCursor(position, (at) => server.hover(positionParams(context, at)));
  if (hover === undefined) {
    return null;
  }
  // abaplint's debugging details aren't useful in an editor.
  const value = hover.contents.value
    .split("\n")
    .filter((line) => !/^Extra: \{.*\}$/.test(line) && line.trim() !== "(Resolved)")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { contents: { kind: "markdown", value } };
}

function onDefinition({ textDocument, position }) {
  const context = requestContext(textDocument.uri);
  if (context === undefined) {
    return null;
  }
  const server = new abaplint.LanguageServer(context.registry);
  const { result } = atCursor(position, (at) => server.gotoDefinition(positionParams(context, at)));
  return toLocation(context, result) ?? null;
}

function onImplementation({ textDocument, position }) {
  // abaplint looks at every object for implementations.
  const context = requestContext(textDocument.uri, { all: true });
  if (context === undefined) {
    return null;
  }
  const server = new abaplint.LanguageServer(context.registry);
  const { result } = atCursor(position, (at) => server.implementation(positionParams(context, at)));
  return toLocations(context, result);
}

const sameLocation = (a, b) =>
  a !== undefined &&
  b !== undefined &&
  fileKey(a.uri) === fileKey(b.uri) &&
  comparePositions(a.range.start, b.range.start) === 0 &&
  comparePositions(a.range.end, b.range.end) === 0;

function onReferences({ textDocument, position, context: { includeDeclaration } }) {
  const context = requestContext(textDocument.uri, { all: true });
  if (context === undefined) {
    return null;
  }
  const server = new abaplint.LanguageServer(context.registry);
  const { result: declaration, position: at } = atCursor(position, (p) =>
    server.gotoDefinition(positionParams(context, p)),
  );
  const references = server.references({ ...positionParams(context, at), context: { includeDeclaration } });
  // abaplint leaves out some declarations and includes others.
  const others = references.filter((reference) => !sameLocation(reference, declaration));
  return toLocations(context, includeDeclaration && declaration !== undefined ? [declaration, ...others] : others);
}

function onDocumentSymbol({ textDocument }) {
  const context = requestContext(textDocument.uri);
  if (context === undefined) {
    return null;
  }
  return new abaplint.LanguageServer(context.registry).documentSymbol({ textDocument: { uri: context.filename } });
}

// The last formatting result per URI: `{ version, config, edits }`. Pretty
// printing is slow on long files, and format-on-save asks again and again.
const formatted = new Map();

function onDocumentFormatting({ textDocument }) {
  const document = documents.get(textDocument.uri);
  const context = requestContext(textDocument.uri);
  if (document === undefined || context === undefined || !context.editable) {
    return null;
  }
  const config = context.registry.getConfig();
  const last = formatted.get(textDocument.uri);
  if (last !== undefined && last.version === document.version && last.config === config) {
    return last.edits;
  }
  const result = new abaplint.LanguageServer(context.registry).documentFormatting({
    textDocument: { uri: context.filename },
  });
  // abaplint's range ends past the last line; replace exactly the document.
  const end = document.positionAt(document.getText().length);
  const edits = result.length === 0 ? [] : [{ range: { start: { line: 0, character: 0 }, end }, newText: result[0].newText }];
  formatted.set(textDocument.uri, { version: document.version, config, edits });
  return edits;
}

// ---------------------------------------------------------------------------
// Rename

/** The statement of `abapFile` at a 0-based LSP position. */
function statementAt(abapFile, { line, character }) {
  const at = new abaplint.Position(line + 1, character + 1);
  return abapFile
    ?.getStatements()
    .find((statement) => !at.isBefore(statement.getStart()) && at.isBefore(statement.getEnd()));
}

function abapFileOf(registry, filename) {
  const file = registry.getFileByName(filename);
  const object = file === undefined ? undefined : registry.findObjectForFile(file);
  return object?.getABAPFiles?.().find((abapFile) => abapFile.getFilename().toUpperCase() === filename.toUpperCase());
}

/**
 * Whether `declaration` is a parameter of a method, event or function
 * module. Callers name those in arguments (`iv_x = 1`), which abaplint's
 * references don't find, so renaming one would break its callers.
 */
function isParameter(context, declaration) {
  const statement = statementAt(abapFileOf(context.registry, declaration.uri), declaration.range.start);
  const type = statement?.get().constructor.name;
  if (type === "FunctionModule") {
    return true;
  }
  if (type !== "MethodDef" && type !== "Events") {
    return false;
  }
  // The method's or event's own name is in the same statement.
  const name = statement.findFirstExpression(type === "MethodDef" ? abaplint.Expressions.MethodName : abaplint.Expressions.EventName);
  const start = name?.getFirstToken().getStart();
  return start === undefined || start.getRow() !== declaration.range.start.line + 1 || start.getCol() !== declaration.range.start.character + 1;
}

/** The part of a name after `intf~` (an interface's method or attribute). */
const shortName = (name) => name.slice(name.lastIndexOf("~") + 1);

/**
 * The range of `name` within a reference (registry filename and range), or
 * undefined if the reference's text isn't that name. abaplint's references
 * cover all of `zif_x~meth` for an interface method, and point at the start
 * of a macro call for a name used in one.
 */
function nameRange(context, location, name) {
  const { start, end } = location.range;
  const row = context.registry.getFileByName(location.uri)?.getRawRows()[start.line];
  if (row === undefined || start.line !== end.line) {
    return undefined;
  }
  const text = row.slice(start.character, end.character).toUpperCase();
  const wanted = name.toUpperCase();
  if (text === wanted) {
    return location.range;
  }
  // `zif_x~name`, and `!name` (a name escaped from being a keyword).
  if (text.endsWith(`~${wanted}`) || text === `!${wanted}`) {
    return { start: { line: start.line, character: end.character - name.length }, end };
  }
  return undefined;
}

/**
 * What a rename at `position` would rename: `{ placeholder, range, position,
 * declaration, global }`, or `{ reason }` if it can't be renamed.
 */
function renameTarget(context, position) {
  const server = new abaplint.LanguageServer(context.registry);
  const { result: prepared, position: at } = atCursor(position, (p) =>
    server.prepareRename(positionParams(context, p)),
  );
  if (prepared === undefined) {
    return { reason: "abaplint can't rename this" };
  }
  const placeholder = shortName(prepared.placeholder);
  const declaration = server.gotoDefinition(positionParams(context, at));
  if (declaration === undefined || !isEditableFile(context, declaration.uri)) {
    return { reason: `${placeholder} isn't declared in this project, so it can't be renamed here` };
  }
  if (isParameter(context, declaration)) {
    return { reason: `${placeholder} is a parameter, and renaming parameters isn't supported (callers' arguments wouldn't be renamed)` };
  }
  // A global class or interface: its definition names the object itself.
  const object = context.registry.findObjectForFile(context.registry.getFileByName(declaration.uri));
  const global =
    (object?.getType() === "CLAS" || object?.getType() === "INTF") &&
    object.getName().toUpperCase() === placeholder.toUpperCase();
  const range = nameRange(context, { uri: context.filename, range: prepared.range }, placeholder) ?? prepared.range;
  return { placeholder, range, position: at, declaration, global, server };
}

function onPrepareRename({ textDocument, position }) {
  const context = requestContext(textDocument.uri);
  if (context === undefined || !context.editable) {
    return null;
  }
  const target = renameTarget(context, position);
  return target.reason === undefined ? { range: target.range, placeholder: target.placeholder } : null;
}

function onRename({ textDocument, position, newName }) {
  const context = requestContext(textDocument.uri, { all: true });
  if (context === undefined) {
    return null;
  }
  if (!context.editable) {
    throw requestFailed("abaplint can't rename from this file");
  }
  const target = renameTarget(context, position);
  if (target.reason !== undefined) {
    throw requestFailed(target.reason);
  }
  const name = shortName(newName.trim());
  if (!/^[A-Za-z_/][A-Za-z0-9_/]*$/.test(name)) {
    throw requestFailed(`${newName} isn't a valid ABAP name`);
  }
  const { placeholder, declaration, global, server } = target;
  const params = positionParams(context, target.position);
  if (global) {
    // abaplint's renamer also renames the files and the name in their XML.
    const edit = server.rename({ ...params, newName: name });
    if (edit === undefined) {
      throw requestFailed(`abaplint can't rename ${placeholder}`);
    }
    return toWorkspaceEdit(context, edit, { oldName: placeholder, newName: name });
  }
  // A variable, attribute or method: its declaration and every reference.
  // (abaplint's own rename sends a method's declaration edit to the wrong
  // file when renaming from another one.)
  const locations = [declaration, ...server.references({ ...params, context: { includeDeclaration: true } })];
  const changes = {};
  for (const location of locations) {
    const range = nameRange(context, location, placeholder);
    if (range === undefined) {
      const line = location.range.start.line + 1;
      throw requestFailed(`abaplint can't rename every use of ${placeholder} (${basename(location.uri)} line ${line})`);
    }
    (changes[location.uri] ??= []).push({ range, newText: name });
  }
  return toWorkspaceEdit(context, { changes });
}

// ---------------------------------------------------------------------------
// Quick fixes

/** Whether any edit of `a` overlaps one of `b` (LSP workspace edits with `changes`). */
function editsOverlap(a, b) {
  for (const [file, edits] of Object.entries(a.changes)) {
    for (const x of edits) {
      for (const y of b.changes[file] ?? []) {
        const touching = comparePositions(x.range.start, y.range.start) === 0;
        if (touching || (comparePositions(x.range.start, y.range.end) < 0 && comparePositions(y.range.start, x.range.end) < 0)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Quick fixes from the findings at `range`, from the same findings as the diagnostics. */
function onCodeAction({ textDocument, range }) {
  const document = documents.get(textDocument.uri);
  const context = requestContext(textDocument.uri);
  if (document === undefined || context === undefined || !context.editable) {
    return null;
  }
  const result = currentIssues(document);
  if (result === undefined) {
    return [];
  }
  const upper = result.filename.toUpperCase();
  const issues = result.issues.filter((issue) => issue.getFilename().toUpperCase() === upper);
  const start = new abaplint.Position(range.start.line + 1, range.start.character + 1);
  const end = new abaplint.Position(range.end.line + 1, range.end.character + 1);
  const overlaps = (issue) => !issue.getEnd().isBefore(start) && !end.isBefore(issue.getStart());
  const diagnostic = (issue) => toDiagnostics([issue], issue.getFilename())[0];
  const action = (title, edit, diagnostics) => {
    try {
      return { title, kind: CodeActionKind.QuickFix, diagnostics, edit: toWorkspaceEdit(context, edit) };
    } catch {
      return undefined; // a fix that would change a file it can't, or overlaps itself
    }
  };

  const actions = [];
  const fixable = new Map(); // rule -> issues with a default fix
  for (const issue of issues) {
    const fix = issue.getDefaultFix();
    if (fix !== undefined) {
      fixable.set(issue.getKey(), [...(fixable.get(issue.getKey()) ?? []), issue]);
    }
    if (!overlaps(issue)) {
      continue;
    }
    if (fix !== undefined) {
      actions.push(action(`Fix: ${issue.getMessage()}`, abaplint.LSPEdit.mapEdit(fix), [diagnostic(issue)]));
    }
    for (const alternative of issue.getAlternativeFixes() ?? []) {
      actions.push(action(alternative.description, abaplint.LSPEdit.mapEdit(alternative.edit), [diagnostic(issue)]));
    }
  }
  // "Fix all" for a rule with a finding here and others in the file. Each fix
  // was computed against the current text on its own, so fixes that overlap
  // an earlier one are left for a second round.
  const here = new Set(issues.filter(overlaps).map((issue) => issue.getKey()));
  for (const [key, all] of fixable) {
    if (!here.has(key) || all.length < 2) {
      continue;
    }
    const chosen = [];
    let combined = { changes: {} };
    for (const issue of all) {
      const edit = abaplint.LSPEdit.mapEdit(issue.getDefaultFix());
      if (!editsOverlap(edit, combined)) {
        chosen.push(issue);
        combined = abaplint.LSPEdit.mapEdits(chosen.map((each) => each.getDefaultFix()));
      }
    }
    if (chosen.length > 1) {
      actions.push(action(`Fix all ${key} findings in this file`, combined, chosen.map(diagnostic)));
    }
  }
  return actions.filter((each) => each !== undefined);
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
  if (open || !isObjectFilename(filename)) {
    // An open document's editor contents win until it is closed.
    return undefined;
  }
  if (basename(filename) === PACKAGE_FILE && !project.isProjectFile(filename)) {
    // A new package.devc.xml can make an open file's package folder bigger.
    let changed = false;
    for (const document of documents.all()) {
      const open = uriToFilename(document.uri);
      if (open !== undefined && project.isExtraFile(open)) {
        changed = project.addFolder(packageFolder(open, project.root)) || changed;
      }
    }
    return changed ? "file" : undefined;
  }
  if (!project.isProjectFile(filename)) {
    if (!project.isFolderFile(filename)) {
      return undefined;
    }
    if (project.isExtraFile(filename) && readText(filename) === undefined) {
      project.extraFiles.delete(key);
      project.removeFile(filename);
      return "file";
    }
    return project.addExtraFile(filename) ? "file" : undefined;
  }
  // The project's own copy of an object wins over one from a package folder.
  project.evictExtras(filename);
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
  const workspaceEdit = params.capabilities.workspace?.workspaceEdit;
  clientSupportsDocumentChanges = workspaceEdit?.documentChanges === true;
  clientSupportsFileRenames = workspaceEdit?.resourceOperations?.includes("rename") === true;
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
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    },
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
  connection.onHover(handle("hover", onHover));
  connection.onDefinition(handle("definition", onDefinition));
  connection.onImplementation(handle("implementation", onImplementation));
  connection.onReferences(handle("references", onReferences));
  connection.onDocumentSymbol(handle("documentSymbol", onDocumentSymbol));
  connection.onDocumentFormatting(handle("formatting", onDocumentFormatting));
  connection.onPrepareRename(handle("prepareRename", onPrepareRename));
  connection.onRenameRequest(handle("rename", onRename));
  connection.onCodeAction(handle("codeAction", onCodeAction));
  process.on("uncaughtException", (error) => log(`Uncaught: ${errorDetail(error)}`));
  documents.listen(connection);
  connection.listen();
}

if (require.main === module) {
  main();
}

module.exports = { globToRegExp, globBase, isObjectFilename, findFiles };
