#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--restore-migration-backup") {
        if let Err(error) = shell_span_lib::restore_migration_backup() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(unix)]
    if std::env::args().nth(1).as_deref() == Some("--terminal-guardian") {
        let session = std::env::args()
            .nth(2)
            .and_then(|s| s.parse::<i32>().ok())
            .filter(|pid| *pid > 1)
            .expect("private terminal session id");
        shell_span_lib::terminal_guard::guardian_main(session);
        return;
    }
    shell_span_lib::run();
}
