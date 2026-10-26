// Embeds the neutral app icon and file details. The per-brand name and icon come at runtime
// (window title, desktop shortcut), so this binary is the same for every brand.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("app.ico");
        res.set("FileDescription", "Cashier");
        res.set("ProductName", "Cashier");
        res.set("OriginalFilename", "cashier.exe");
        res.compile().expect("resources");
    }
}
