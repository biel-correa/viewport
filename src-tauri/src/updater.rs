use semver::Version;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tracing::{info, warn};

const REPO_PREFIX: &str = "https://github.com/biel-correa/viewport/";
const RELEASES_API_URL: &str = "https://api.github.com/repos/biel-correa/viewport/releases/latest";
const RELEASES_PAGE_URL: &str = "https://github.com/biel-correa/viewport/releases/latest";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub notes: Option<String>,
    pub can_auto_update: bool,
    pub download_url: String,
    pub release_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

fn ensure_rustls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

fn is_updater_pubkey_configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|cfg| cfg.get("pubkey"))
        .and_then(|val| val.as_str())
        .map(str::trim)
        .is_some_and(|key| !key.is_empty() && !key.starts_with("REPLACE_"))
}

pub fn parse_semver(raw: &str) -> Option<Version> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    Version::parse(trimmed).ok()
}

pub fn is_newer_version(current: &str, candidate: &str) -> bool {
    match (parse_semver(current), parse_semver(candidate)) {
        (Some(cur), Some(cand)) => cand > cur,
        _ => false,
    }
}

fn select_platform_asset_url_for_os(
    assets: &[GitHubAsset],
    fallback_url: &str,
    os: &str,
) -> String {
    let preferred_exts: &[&str] = match os {
        "macos" => &[".dmg", ".app.zip"],
        "windows" => &[".exe", ".msi"],
        "linux" => &[".AppImage", ".deb", ".rpm"],
        _ => &[],
    };

    for ext in preferred_exts {
        let ext_lower = ext.to_ascii_lowercase();
        if let Some(asset) = assets.iter().find(|a| {
            let lower = a.name.to_ascii_lowercase();
            lower.ends_with(&ext_lower) && !lower.ends_with(".sig")
        }) {
            return asset.browser_download_url.clone();
        }
    }

    fallback_url.to_string()
}

async fn check_github_release_fallback(current_version: &str) -> Result<UpdateInfo, String> {
    ensure_rustls_provider();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(format!("ViewPort/{}", current_version))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client
        .get(RELEASES_API_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to reach GitHub Releases: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateInfo {
            available: false,
            current_version: current_version.to_string(),
            latest_version: current_version.to_string(),
            notes: None,
            can_auto_update: false,
            download_url: RELEASES_PAGE_URL.to_string(),
            release_url: RELEASES_PAGE_URL.to_string(),
        });
    }

    if !resp.status().is_success() {
        return Err(format!("GitHub Releases API returned HTTP {}", resp.status()));
    }

    let release: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub Release metadata: {}", e))?;

    if release.draft || release.prerelease {
        return Ok(UpdateInfo {
            available: false,
            current_version: current_version.to_string(),
            latest_version: current_version.to_string(),
            notes: None,
            can_auto_update: false,
            download_url: RELEASES_PAGE_URL.to_string(),
            release_url: RELEASES_PAGE_URL.to_string(),
        });
    }

    let latest_clean = release
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    let available = is_newer_version(current_version, &latest_clean);
    let download_url =
        select_platform_asset_url_for_os(&release.assets, &release.html_url, std::env::consts::OS);

    Ok(UpdateInfo {
        available,
        current_version: current_version.to_string(),
        latest_version: if latest_clean.is_empty() {
            current_version.to_string()
        } else {
            latest_clean
        },
        notes: release.body,
        can_auto_update: false,
        download_url,
        release_url: release.html_url,
    })
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    if is_updater_pubkey_configured(&app) {
        ensure_rustls_provider();
        match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    let latest_version = update.version.clone();
                    let release_url = format!(
                        "{}releases/tag/v{}",
                        REPO_PREFIX,
                        latest_version.trim_start_matches(['v', 'V'])
                    );
                    info!(
                        "Signed auto-update available: {} -> {}",
                        current_version, latest_version
                    );
                    return Ok(UpdateInfo {
                        available: true,
                        current_version,
                        latest_version,
                        notes: update.body,
                        can_auto_update: true,
                        download_url: release_url.clone(),
                        release_url,
                    });
                }
                Ok(None) => {
                    info!("App is up to date according to signed updater manifest ({})", current_version);
                    return Ok(UpdateInfo {
                        available: false,
                        current_version: current_version.clone(),
                        latest_version: current_version,
                        notes: None,
                        can_auto_update: true,
                        download_url: RELEASES_PAGE_URL.to_string(),
                        release_url: RELEASES_PAGE_URL.to_string(),
                    });
                }
                Err(err) => {
                    warn!(
                        "Tauri updater check unavailable ({}); falling back to GitHub Releases API",
                        err
                    );
                }
            },
            Err(err) => {
                warn!(
                    "Failed to initialize Tauri updater ({}); falling back to GitHub Releases API",
                    err
                );
            }
        }
    }

    check_github_release_fallback(&current_version).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if !is_updater_pubkey_configured(&app) {
        return Err("Auto-update signing key is not configured for this build.".to_string());
    }

    ensure_rustls_provider();
    let updater = app
        .updater()
        .map_err(|e| format!("Failed to initialize updater: {}", e))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for update: {}", e))?
    else {
        return Err("No update is currently available.".to_string());
    };

    info!(
        "Downloading and installing ViewPort update {}...",
        update.version
    );

    let downloaded_bytes = AtomicU64::new(0);
    let progress_app = app.clone();
    let finish_app = app.clone();

    update
        .download_and_install(
            move |chunk_length, content_length| {
                let total_downloaded =
                    downloaded_bytes.fetch_add(chunk_length as u64, Ordering::Relaxed)
                        + chunk_length as u64;
                let percent = content_length.filter(|&t| t > 0).map(|total| {
                    ((total_downloaded.saturating_mul(100)) / total).min(100) as u8
                });
                let _ = progress_app.emit(
                    "update-download-progress",
                    UpdateProgressEvent {
                        downloaded: total_downloaded,
                        total: content_length,
                        percent,
                    },
                );
            },
            move || {
                let _ = finish_app.emit(
                    "update-download-progress",
                    UpdateProgressEvent {
                        downloaded: 0,
                        total: None,
                        percent: Some(100),
                    },
                );
            },
        )
        .await
        .map_err(|e| format!("Auto-update installation failed: {}", e))?;

    info!("Update installed successfully; restarting ViewPort...");
    app.restart();
}

#[tauri::command]
pub fn open_download_url(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let target = if trimmed.is_empty() {
        RELEASES_PAGE_URL
    } else if trimmed.starts_with(REPO_PREFIX) {
        trimmed
    } else {
        return Err("Blocked opening non-ViewPort external URL".to_string());
    };

    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_semver_comparison() {
        assert!(is_newer_version("0.1.0", "v0.2.0"));
        assert!(is_newer_version("0.1.0", "0.1.1"));
        assert!(!is_newer_version("0.2.0", "v0.2.0"));
        assert!(!is_newer_version("0.2.0", "v0.1.9"));
        assert!(!is_newer_version("0.2.0", "not-a-version"));
    }

    #[test]
    fn test_select_platform_asset_url_prefers_os_installers_and_skips_sigs() {
        let assets = vec![
            GitHubAsset {
                name: "ViewPort_0.2.0_universal.dmg.sig".to_string(),
                browser_download_url: "https://example.com/dmg.sig".to_string(),
            },
            GitHubAsset {
                name: "ViewPort_0.2.0_universal.dmg".to_string(),
                browser_download_url: "https://example.com/ViewPort.dmg".to_string(),
            },
            GitHubAsset {
                name: "ViewPort_0.2.0_x64-setup.exe".to_string(),
                browser_download_url: "https://example.com/ViewPort-setup.exe".to_string(),
            },
            GitHubAsset {
                name: "ViewPort_0.2.0_amd64.AppImage".to_string(),
                browser_download_url: "https://example.com/ViewPort.AppImage".to_string(),
            },
        ];

        assert_eq!(
            select_platform_asset_url_for_os(&assets, "https://example.com/release", "macos"),
            "https://example.com/ViewPort.dmg"
        );
        assert_eq!(
            select_platform_asset_url_for_os(&assets, "https://example.com/release", "windows"),
            "https://example.com/ViewPort-setup.exe"
        );
        assert_eq!(
            select_platform_asset_url_for_os(&assets, "https://example.com/release", "linux"),
            "https://example.com/ViewPort.AppImage"
        );
        assert_eq!(
            select_platform_asset_url_for_os(&[], "https://example.com/release", "macos"),
            "https://example.com/release"
        );
    }
}
