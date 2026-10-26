// Cashier app for Windows: one WebView2 window locked to the brand's server.
//
// The binary holds no business logic. Its only per-brand data is a JSON config the server
// writes into the CONFIG region below when it builds the brand's download
// (server/src/native/exe.js): {"server": "...", "brand": "...", "key": "...", "name": "..."}.
//
// First run from anywhere (Downloads, inside the zip): the app copies itself to
// %LOCALAPPDATA%\Programs\<brand>-cashier\, adds Desktop and Start menu shortcuts with the
// brand name and icon, and restarts from there.

#![windows_subsystem = "windows"]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::platform::windows::WindowExtWindows;
use tao::window::{Theme, WindowBuilder};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, LoadImageW, MessageBoxW, SendMessageW, SetForegroundWindow, ShowWindow, ICON_BIG, ICON_SMALL,
    IMAGE_ICON, LR_DEFAULTSIZE, LR_LOADFROMFILE, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK, SW_RESTORE, SW_SHOWNORMAL,
    WM_SETICON,
};
use wry::{NewWindowResponse, WebContext, WebViewBuilder, WebViewBuilderExtWindows};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const CONFIG_LEN: usize = 1024;
const MARKER: &[u8] = b"PAGER_APP_CONFIG_V1:";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const WEBVIEW2_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

const fn config_region() -> [u8; CONFIG_LEN] {
    let mut region = [b' '; CONFIG_LEN];
    let mut i = 0;
    while i < MARKER.len() {
        region[i] = MARKER[i];
        i += 1;
    }
    region
}

#[used]
static CONFIG: [u8; CONFIG_LEN] = config_region();

struct Config {
    server: String,
    brand: String,
    key: String,
    name: String,
}

fn read_config() -> Option<Config> {
    // Volatile reads: the compiler must not fold the template's spaces into the code.
    let bytes: Vec<u8> = (0..CONFIG_LEN).map(|i| unsafe { std::ptr::read_volatile(&CONFIG[i]) }).collect();
    let json = std::str::from_utf8(bytes.get(MARKER.len()..)?).ok()?.trim_matches(|c| c == ' ' || c == '\0');
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let field = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let config = Config { server: field("server").trim_end_matches('/').to_string(), brand: field("brand"), key: field("key"), name: field("name") };
    let local = config.server.starts_with("http://127.0.0.1:") || config.server.starts_with("http://localhost:");
    let id_ok = !config.brand.is_empty() && config.brand.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    ((config.server.starts_with("https://") || local) && id_ok).then_some(config)
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

fn message(title: &str, text: &str, warning: bool) {
    let flags = MB_OK | if warning { MB_ICONWARNING } else { MB_ICONINFORMATION };
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(title).as_ptr(), flags) };
}

fn open_outside(url: &str) {
    if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") || url.starts_with("tel:") {
        unsafe {
            ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), wide(url).as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
        };
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn install_dir(config: &Config) -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Programs").join(format!("{}-cashier", config.brand)))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()),
        _ => false,
    }
}

/// Copies the app into its install folder, makes the shortcuts, and starts the installed copy.
/// Returns false (keep running from here) when anything goes wrong.
fn install_and_relaunch(config: &Config, dir: &Path) -> bool {
    let Ok(current) = std::env::current_exe() else { return false };
    let target = dir.join(format!("{}-cashier.exe", config.brand));
    if same_file(&current, &target) {
        return false;
    }
    if std::fs::create_dir_all(dir).is_err() || std::fs::copy(&current, &target).is_err() {
        return false;
    }
    // Values travel as environment variables, never spliced into the script.
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$ico = Join-Path $env:PAGER_DIR 'icon.ico'
try { Invoke-WebRequest -UseBasicParsing -Uri $env:PAGER_ICON -OutFile $ico } catch {}
if (-not (Test-Path $ico)) { $ico = $env:PAGER_EXE }
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = $shell.CreateShortcut((Join-Path $folder ($env:PAGER_NAME + '.lnk')))
  $lnk.TargetPath = $env:PAGER_EXE
  $lnk.WorkingDirectory = $env:PAGER_DIR
  $lnk.IconLocation = "$ico,0"
  $lnk.Save()
}
"#;
    let name: String = config.name.chars().filter(|c| !"\\/:*?\"<>|".contains(*c)).collect();
    let _ = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("PAGER_DIR", dir)
        .env("PAGER_EXE", &target)
        .env("PAGER_NAME", if name.trim().is_empty() { "Cashier".to_string() } else { name })
        .env("PAGER_ICON", format!("{}/app/{}/icon.ico", config.server, config.brand))
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    Command::new(&target).current_dir(dir).spawn().is_ok()
}

fn set_window_icon(hwnd: isize, ico: &Path) {
    if !ico.exists() {
        return;
    }
    let path = wide(&ico.to_string_lossy());
    unsafe {
        let icon = LoadImageW(std::ptr::null_mut(), path.as_ptr(), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
        if !icon.is_null() {
            SendMessageW(hwnd as _, WM_SETICON, ICON_BIG as usize, icon as isize);
            SendMessageW(hwnd as _, WM_SETICON, ICON_SMALL as usize, icon as isize);
        }
    }
}

/// Shown first: waits for the server, then opens the start page (also after a cold boot
/// with no network yet).
fn boot_page(start: &str, health: &str, name: &str) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        r#"<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1e1f21;color:#eceae6;font-family:'Segoe UI',Tahoma,sans-serif;text-align:center">
<div><h1 style="font-size:24px;font-weight:600;margin:0 0 8px">{name}</h1><p id="s" style="color:#a09d97;margin:0">بيفتح...</p></div>
<script>
var start = {start}, health = {health}, tries = 0;
function go() {{
  fetch(health, {{ mode: 'no-cors', cache: 'no-store' }}).then(function () {{ location.replace(start); }}, function () {{
    tries++;
    document.getElementById('s').textContent = 'مفيش اتصال بالإنترنت. بنحاول تاني لوحدنا...';
    setTimeout(go, Math.min(10000, 2000 + tries * 1000));
  }});
}}
go();
</script></body></html>"#,
        name = esc(name),
        start = serde_json::to_string(start).unwrap(),
        health = serde_json::to_string(health).unwrap(),
    )
}

// Blocks the developer shortcuts (devtools are off anyway; the context menu is off too).
const LOCKDOWN_JS: &str = r#"
(function () {
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if (k === 'f12' || (e.ctrlKey && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) || (e.ctrlKey && k === 'u')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
})();
"#;

fn main() {
    let Some(config) = read_config() else {
        message("Cashier", "النسخة دي ناقصة. نزّل التطبيق تاني من اللينك اللي وصلك.", true);
        return;
    };
    let title = if config.name.trim().is_empty() { "Cashier".to_string() } else { config.name.clone() };

    // One window per brand: a second launch brings the open one to the front.
    let mutex_name = wide(&format!("Local\\pager-cashier-{}", config.brand));
    let mutex: HANDLE = unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr()) };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        let hwnd = unsafe { FindWindowW(std::ptr::null(), wide(&title).as_ptr()) };
        if !hwnd.is_null() {
            unsafe {
                ShowWindow(hwnd, SW_RESTORE);
                SetForegroundWindow(hwnd);
            }
        }
        return;
    }

    // PAGER_NO_INSTALL=1: run in place with a temp profile (automated smoke tests).
    let dir = if std::env::var_os("PAGER_NO_INSTALL").is_some() { None } else { install_dir(&config) };
    if let Some(dir) = &dir {
        unsafe { CloseHandle(mutex) };
        if install_and_relaunch(&config, dir) {
            return;
        }
        unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr()) };
    }
    let data_dir = dir.clone().unwrap_or_else(std::env::temp_dir).join("data");

    // A cashier screen stays on.
    unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED) };

    let model = std::env::var("COMPUTERNAME").unwrap_or_default();
    let start = format!(
        "{}/app/{}/start?k={}&platform=windows&v={}&model={}",
        config.server,
        config.brand,
        encode(&config.key),
        VERSION,
        encode(&model)
    );
    let health = format!("{}/health", config.server);

    let event_loop = EventLoop::new();
    let window = match WindowBuilder::new()
        .with_title(&title)
        .with_maximized(true)
        .with_theme(Some(Theme::Dark))
        .with_min_inner_size(LogicalSize::new(640.0, 480.0))
        .build(&event_loop)
    {
        Ok(w) => w,
        Err(_) => return,
    };
    if let Some(dir) = &dir {
        set_window_icon(window.hwnd(), &dir.join("icon.ico"));
    }

    let server = config.server.clone();
    let own = move |url: &str| url == server || url.starts_with(&format!("{server}/"));
    let mut context = WebContext::new(Some(data_dir));
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_html(boot_page(&start, &health, &title))
        .with_initialization_script(LOCKDOWN_JS)
        .with_devtools(false)
        .with_default_context_menus(false)
        .with_browser_accelerator_keys(false)
        .with_navigation_handler(move |url| {
            if own(&url) || url.starts_with("about:") || url.starts_with("data:") {
                true
            } else {
                open_outside(&url);
                false
            }
        })
        .with_new_window_req_handler(move |url, _features| {
            open_outside(&url);
            NewWindowResponse::Deny
        })
        .build(&window);
    let webview = match webview {
        Ok(w) => w,
        Err(_) => {
            message(
                &title,
                "البرنامج محتاج Microsoft Edge WebView2. هنفتح لك صفحة التحميل: نزّله وثبّته، وبعدين افتح البرنامج تاني.",
                true,
            );
            open_outside(WEBVIEW2_URL);
            return;
        }
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _ = &webview;
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *control_flow = ControlFlow::Exit;
        }
    });
}
