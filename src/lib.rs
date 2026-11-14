//! Zed extension for ABAP. Everything else (grammar, queries, icons) is
//! declarative; this crate only starts the abaplint language server.
//!
//! The server is `server/server.js`, embedded here and written into the
//! extension's work directory next to its npm dependencies, then run with
//! Zed's Node. The dependencies and their versions come from
//! `server/package.json`, except `@abaplint/core`, which is kept at its latest
//! version so new ABAP syntax and rule fixes arrive without an extension
//! release.

use std::{env, fs};

use zed_extension_api::{
    self as zed, serde_json, settings::LspSettings, LanguageServerId,
    LanguageServerInstallationStatus, Result,
};

const SERVER_SCRIPT: &str = include_str!("../server/server.js");
const SERVER_PACKAGE_JSON: &str = include_str!("../server/package.json");
/// Where the script is written, relative to the extension's work directory.
const SERVER_SCRIPT_PATH: &str = "abaplint-server.js";
/// Installed at its latest version rather than the pinned one.
const ABAPLINT_CORE: &str = "@abaplint/core";

struct AbapExtension {
    /// Set once the npm packages and the script are in place, so they are
    /// checked once per Zed session, not every time the server (re)starts.
    installed: bool,
}

/// `(name, pinned version)` for each dependency in `server/package.json`.
fn server_dependencies() -> Result<Vec<(String, String)>> {
    let manifest: serde_json::Value = serde_json::from_str(SERVER_PACKAGE_JSON)
        .map_err(|e| format!("server/package.json: {e}"))?;
    let dependencies = manifest["dependencies"]
        .as_object()
        .ok_or("server/package.json: no dependencies")?;
    dependencies
        .iter()
        .map(|(name, version)| match version.as_str() {
            Some(version) => Ok((name.clone(), version.to_string())),
            None => Err(format!(
                "server/package.json: version of {name} is not a string"
            )),
        })
        .collect()
}

impl AbapExtension {
    /// Installs or updates the server's npm packages and writes the script.
    /// Returns the script's absolute path.
    fn install_server(&mut self, id: &LanguageServerId) -> Result<String> {
        let script = env::current_dir()
            .map_err(|e| format!("extension work directory: {e}"))?
            .join(SERVER_SCRIPT_PATH)
            .to_string_lossy()
            .into_owned();
        if self.installed {
            return Ok(script);
        }

        zed::set_language_server_installation_status(
            id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );
        for (name, pinned) in server_dependencies()? {
            let installed = zed::npm_package_installed_version(&name)?;
            let wanted = if name == ABAPLINT_CORE {
                // Offline: keep whatever is installed, or fall back to the pin.
                match zed::npm_package_latest_version(&name) {
                    Ok(latest) => latest,
                    Err(_) => installed.clone().unwrap_or_else(|| pinned.clone()),
                }
            } else {
                pinned.clone()
            };
            if installed.as_deref() == Some(wanted.as_str()) {
                continue;
            }
            zed::set_language_server_installation_status(
                id,
                &LanguageServerInstallationStatus::Downloading,
            );
            if let Err(error) = zed::npm_install_package(&name, &wanted) {
                // An update that fails (offline, or a proxy that holds back
                // new releases) isn't fatal while an older version is still
                // installed. Without one, the pinned version (tested in CI)
                // is the next best.
                if installed.is_none()
                    && (wanted == pinned || zed::npm_install_package(&name, &pinned).is_err())
                {
                    return Err(format!("installing {name}@{wanted}: {error}"));
                }
            }
        }

        fs::write(SERVER_SCRIPT_PATH, SERVER_SCRIPT)
            .map_err(|e| format!("writing {SERVER_SCRIPT_PATH}: {e}"))?;
        zed::set_language_server_installation_status(id, &LanguageServerInstallationStatus::None);
        self.installed = true;
        Ok(script)
    }
}

impl zed::Extension for AbapExtension {
    fn new() -> Self {
        Self { installed: false }
    }

    fn language_server_command(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary);
        let env = binary
            .as_ref()
            .and_then(|binary| binary.env.clone())
            .map(|env| env.into_iter().collect())
            .unwrap_or_default();

        // `lsp.abaplint.binary.path` in Zed's settings replaces the bundled
        // server, e.g. to run a local checkout of server/server.js.
        if let Some(path) = binary.as_ref().and_then(|binary| binary.path.clone()) {
            return Ok(zed::Command {
                command: path,
                args: binary
                    .and_then(|binary| binary.arguments)
                    .unwrap_or_default(),
                env,
            });
        }

        let script = match self.install_server(id) {
            Ok(script) => script,
            Err(error) => {
                zed::set_language_server_installation_status(
                    id,
                    &LanguageServerInstallationStatus::Failed(error.clone()),
                );
                return Err(error);
            }
        };
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![script, "--stdio".to_string()],
            env,
        })
    }
}

zed::register_extension!(AbapExtension);
