//! Shared with the generated Tauri transition build. No credential access.
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

// Only real initialization work reports progress; there is no idle heartbeat.
thread_local! {
    static PROGRESS: std::cell::RefCell<Option<Box<dyn FnMut()>>> = std::cell::RefCell::new(None);
}
pub(crate) fn with_progress<T>(callback: impl FnMut() + 'static, work: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            PROGRESS.with(|p| *p.borrow_mut() = None);
        }
    }
    PROGRESS.with(|p| *p.borrow_mut() = Some(Box::new(callback)));
    let _reset = Reset;
    work()
}
fn progress() {
    PROGRESS.with(|p| {
        if let Some(callback) = p.borrow_mut().as_mut() {
            callback();
        }
    });
}
extern "C" fn sqlite_progress(_: *mut std::ffi::c_void) -> std::ffi::c_int {
    // Never unwind through SQLite's C callback boundary.
    if std::panic::catch_unwind(progress).is_ok() {
        0
    } else {
        1
    }
}
fn observe_sqlite(conn: &Connection) {
    // The callback has no borrowed state. SQLite invokes it synchronously on
    // this connection's calling thread; it cannot outlive thread-local scope.
    unsafe {
        rusqlite::ffi::sqlite3_progress_handler(
            conn.handle(),
            10000,
            Some(sqlite_progress),
            std::ptr::null_mut(),
        );
    }
}
fn copy_with_progress(source: &Path, dest: &Path) -> Result<()> {
    let mut input = File::open(source).map_err(err)?;
    let mut output = File::create(dest).map_err(err)?;
    let mut buf = [0; 65536];
    loop {
        let n = input.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(err)?;
        progress();
    }
    fs::set_permissions(dest, input.metadata().map_err(err)?.permissions()).map_err(err)?;
    output.sync_all().map_err(err)?;
    progress();
    Ok(())
}

const APP_ENTRIES: &[&str] = &["agent-runtime", "agent-native-call-checkpoints"];
const LOCK: &str = ".shellspan-write.lock";
const BACKUP: &str = ".migration-backup-v1";
const FORMAT: &str = ".migration-format.json";
const PENDING: &str = ".migration-restore-pending";

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn private_dir(path: &Path) -> Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(path).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    Ok(())
}
fn sync_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(err)?;
    file.write_all(bytes).map_err(err)?;
    file.sync_all().map_err(err)
}
fn hash(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(err)?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        progress();
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
fn safe_file(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(err)?;
    if !meta.file_type().is_symlink() && !meta.is_dir() && !meta.is_file() {
        return Err(format!("Unsupported migration entry: {}", path.display()));
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotLink {
    target: PathBuf,
    expanded: bool,
    directory: bool,
}
fn snapshot_tree(
    source: &Path,
    dest: &Path,
    root: &Path,
    links: &mut BTreeMap<String, SnapshotLink>,
    ancestors: &mut Vec<PathBuf>,
) -> Result<()> {
    safe_file(source)?;
    progress();
    let symlink = fs::symlink_metadata(source)
        .map_err(err)?
        .file_type()
        .is_symlink();
    if symlink {
        let target = fs::read_link(source).map_err(err)?;
        let canonical = source.canonicalize().ok();
        let expanded = canonical.as_ref().is_some_and(|p| !ancestors.contains(p));
        links.insert(
            dest.strip_prefix(root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/"),
            SnapshotLink {
                target: target.clone(),
                expanded,
                directory: source.is_dir(),
            },
        );
        if !expanded {
            return make_link(&target, dest, source.is_dir());
        }
    }
    if source.is_dir() {
        let canonical = source.canonicalize().map_err(err)?;
        ancestors.push(canonical);
        private_dir(dest)?;
        for item in fs::read_dir(source).map_err(err)? {
            let item = item.map_err(err)?;
            if item.file_name() == LOCK {
                continue;
            }
            snapshot_tree(
                &item.path(),
                &dest.join(item.file_name()),
                root,
                links,
                ancestors,
            )?;
        }
        ancestors.pop();
    } else {
        copy_with_progress(source, dest)?;
        if hash(source)? != hash(dest)? {
            return Err("Migration copy changed while reading".into());
        }
    }
    Ok(())
}
fn make_link(target: &Path, dest: &Path, _directory: bool) -> Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, dest).map_err(err)
    }
    #[cfg(windows)]
    {
        if _directory {
            std::os::windows::fs::symlink_dir(target, dest).map_err(err)
        } else {
            std::os::windows::fs::symlink_file(target, dest).map_err(err)
        }
    }
}
fn restore_tree(
    source: &Path,
    dest: &Path,
    root: &Path,
    links: &BTreeMap<String, SnapshotLink>,
) -> Result<()> {
    let key = source
        .strip_prefix(root)
        .map_err(err)?
        .to_string_lossy()
        .replace('\\', "/");
    if let Some(link) = links.get(&key) {
        if dest.symlink_metadata().is_ok() {
            remove(dest)?;
        }
        if link.expanded {
            let target = if link.target.is_absolute() {
                link.target.clone()
            } else {
                dest.parent()
                    .ok_or("Invalid link parent")?
                    .join(&link.target)
            };
            if target.symlink_metadata().is_ok() {
                remove(&target)?;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(err)?;
            }
            restore_contents(source, &target, root, links)?;
        }
        make_link(&link.target, dest, link.directory)
    } else {
        restore_contents(source, dest, root, links)
    }
}
fn restore_contents(
    source: &Path,
    dest: &Path,
    root: &Path,
    links: &BTreeMap<String, SnapshotLink>,
) -> Result<()> {
    if source.is_dir() {
        private_dir(dest)?;
        for item in fs::read_dir(source).map_err(err)? {
            let item = item.map_err(err)?;
            restore_tree(&item.path(), &dest.join(item.file_name()), root, links)?;
        }
        Ok(())
    } else {
        fs::copy(source, dest).map_err(err)?;
        File::open(dest).map_err(err)?.sync_all().map_err(err)
    }
}
fn entries(root: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for item in fs::read_dir(root).map_err(err)? {
        let item = item.map_err(err)?;
        let name = item.file_name();
        let name = name.to_string_lossy();
        if name == LOCK
            || name.starts_with(".migration-")
            || name == "shellspan.db-wal"
            || name == "shellspan.db-shm"
        {
            continue;
        }
        paths.push(item.path());
    }
    paths.sort();
    Ok(paths)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    files: BTreeMap<String, String>,
    links: BTreeMap<String, SnapshotLink>,
}
fn index(root: &Path, at: &Path, out: &mut BTreeMap<String, String>) -> Result<()> {
    for item in fs::read_dir(at).map_err(err)? {
        let path = item.map_err(err)?.path();
        progress();
        safe_file(&path)?;
        if fs::symlink_metadata(&path)
            .map_err(err)?
            .file_type()
            .is_symlink()
        {
            out.insert(
                path.strip_prefix(root)
                    .map_err(err)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                format!("symlink:{}", fs::read_link(&path).map_err(err)?.display()),
            );
        } else if path.is_dir() {
            index(root, &path, out)?;
        } else {
            out.insert(
                path.strip_prefix(root)
                    .map_err(err)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                hash(&path)?,
            );
        }
    }
    Ok(())
}
fn validate(backup: &Path) -> Result<()> {
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(backup.join("manifest.json")).map_err(err)?)
            .map_err(err)?;
    if manifest.version != 1 {
        return Err("Unsupported migration backup version".into());
    }
    let mut actual = BTreeMap::new();
    index(backup, &backup.join("data"), &mut actual)?;
    index(backup, &backup.join("app"), &mut actual)?;
    if actual != manifest.files {
        return Err("Migration backup integrity check failed".into());
    }
    Ok(())
}
/// Files are never unlinked on release: another process may already hold the inode.
/// The OS releases the locks even after SIGKILL or an installation crash.
pub(crate) struct DataGuard {
    _locks: Vec<File>,
    data: PathBuf,
    app: PathBuf,
}
impl DataGuard {
    pub(crate) fn acquire(data: &Path, app: &Path) -> Result<Self> {
        private_dir(data)?;
        private_dir(app)?;
        let data = data.canonicalize().map_err(err)?;
        let app = app.canonicalize().map_err(err)?;
        if data == app || data.starts_with(&app) || app.starts_with(&data) {
            return Err("Migration data roots must be separate".into());
        }
        let mut roots = vec![data.clone(), app.clone()];
        roots.sort();
        let mut locks = Vec::new();
        for root in roots {
            let path = root.join(LOCK);
            if path.exists() {
                safe_file(&path)?;
                if fs::symlink_metadata(&path)
                    .map_err(err)?
                    .file_type()
                    .is_symlink()
                {
                    return Err("Migration lock cannot be a symbolic link".into());
                }
            }
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(&path).map_err(err)?;
            file.try_lock()
                .map_err(|e| format!("ShellSpan data is in use; close the other version: {e}"))?;
            locks.push(file);
        }
        Ok(Self {
            _locks: locks,
            data,
            app,
        })
    }
    pub(crate) fn check_compatible(&self) -> Result<()> {
        if self.data.join(PENDING).exists() {
            return Err(
                "Interrupted migration restore; rerun the offline restore before opening ShellSpan"
                    .into(),
            );
        }
        let format = self.data.join(FORMAT);
        if format.exists() {
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(&format).map_err(err)?).map_err(err)?;
            if value != serde_json::json!({"version":1}) {
                return Err("Data belongs to an unsupported migration version".into());
            }
        }
        Ok(())
    }
    pub(crate) fn prepare(&self) -> Result<()> {
        self.check_compatible()?;
        progress();
        let format = self.data.join(FORMAT);
        self.snapshot(&self.data.join(BACKUP))?;
        if !format.exists() {
            sync_write(&format, b"{\"version\":1}")?;
        }
        Ok(())
    }
    fn snapshot(&self, target: &Path) -> Result<()> {
        if target.exists() {
            return validate(target);
        }
        let staging = target.with_extension("incomplete");
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(err)?;
        }
        private_dir(&staging)?;
        private_dir(&staging.join("data"))?;
        private_dir(&staging.join("app"))?;
        let mut links = BTreeMap::new();
        for source in entries(&self.data)? {
            let dest = staging
                .join("data")
                .join(source.file_name().ok_or("Invalid migration path")?);
            if source.file_name().is_some_and(|n| n == "shellspan.db") {
                safe_file(&source)?;
                if fs::symlink_metadata(&source)
                    .map_err(err)?
                    .file_type()
                    .is_symlink()
                {
                    links.insert(
                        "data/shellspan.db".into(),
                        SnapshotLink {
                            target: fs::read_link(&source).map_err(err)?,
                            expanded: true,
                            directory: false,
                        },
                    );
                }
                let conn = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(err)?;
                observe_sqlite(&conn);
                conn.busy_timeout(std::time::Duration::from_secs(2))
                    .map_err(err)?;
                let integrity: String = conn
                    .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                    .map_err(err)?;
                if integrity != "ok" {
                    return Err("Source database integrity check failed".into());
                }
                conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])
                    .map_err(err)?;
                File::open(dest).map_err(err)?.sync_all().map_err(err)?;
            } else {
                snapshot_tree(
                    &source,
                    &dest,
                    &staging,
                    &mut links,
                    &mut vec![self.data.clone()],
                )?;
            }
        }
        for name in APP_ENTRIES {
            let source = self.app.join(name);
            if source.symlink_metadata().is_ok() {
                snapshot_tree(
                    &source,
                    &staging.join("app").join(name),
                    &staging,
                    &mut links,
                    &mut vec![self.app.clone()],
                )?;
            }
        }
        let mut files = BTreeMap::new();
        index(&staging, &staging.join("data"), &mut files)?;
        index(&staging, &staging.join("app"), &mut files)?;
        sync_write(
            &staging.join("manifest.json"),
            &serde_json::to_vec_pretty(&Manifest {
                version: 1,
                files,
                links,
            })
            .map_err(err)?,
        )?;
        validate(&staging)?;
        fs::rename(&staging, target).map_err(err)?;
        Ok(())
    }
    /// Offline only. A persistent pending marker blocks normal startup after any
    /// interruption; rerunning completes from the verified immutable backup.
    pub(crate) fn restore(&self) -> Result<()> {
        let backup = self.data.join(BACKUP);
        validate(&backup)?;
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(backup.join("manifest.json")).map_err(err)?)
                .map_err(err)?;
        if !self.data.join(PENDING).exists() {
            let name = format!(".migration-before-restore-{}", uuid::Uuid::new_v4());
            self.snapshot(&self.data.join(&name))?;
            sync_write(&self.data.join(PENDING), name.as_bytes())?;
        }
        for path in entries(&self.data)? {
            remove(&path)?;
        }
        for name in ["shellspan.db-wal", "shellspan.db-shm"] {
            let path = self.data.join(name);
            if path.exists() {
                remove(&path)?;
            }
        }
        for item in fs::read_dir(backup.join("data")).map_err(err)? {
            let path = item.map_err(err)?.path();
            progress();
            restore_tree(
                &path,
                &self
                    .data
                    .join(path.file_name().ok_or("Invalid restore path")?),
                &backup,
                &manifest.links,
            )?;
        }
        for name in APP_ENTRIES {
            let target = self.app.join(name);
            if target.symlink_metadata().is_ok() {
                remove(&target)?;
            }
            let source = backup.join("app").join(name);
            if source.symlink_metadata().is_ok() {
                restore_tree(&source, &target, &backup, &manifest.links)?;
            }
        }
        fs::remove_file(self.data.join(PENDING)).map_err(err)?;
        Ok(())
    }
}
fn remove(path: &Path) -> Result<()> {
    safe_file(path)?;
    if path.is_dir()
        && !fs::symlink_metadata(path)
            .map_err(err)?
            .file_type()
            .is_symlink()
    {
        fs::remove_dir_all(path).map_err(err)
    } else {
        fs::remove_file(path).map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wal_backup_locks_restore_and_future_format() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let app = root.path().join("app");
        let guard = DataGuard::acquire(&data, &app).unwrap();
        assert!(DataGuard::acquire(&data, &app).is_err());
        let conn = Connection::open(data.join("shellspan.db")).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE evidence(value); INSERT INTO evidence VALUES ('committed WAL');").unwrap();
        private_dir(&app.join("agent-runtime")).unwrap();
        fs::write(app.join("agent-runtime/history"), b"old").unwrap();
        guard.prepare().unwrap();
        let backup = Connection::open(data.join(BACKUP).join("data/shellspan.db")).unwrap();
        assert_eq!(
            backup
                .query_row("SELECT value FROM evidence", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "committed WAL"
        );
        drop(backup);
        drop(conn);
        fs::write(app.join("agent-runtime/history"), b"new").unwrap();
        guard.restore().unwrap();
        assert_eq!(fs::read(app.join("agent-runtime/history")).unwrap(), b"old");
        fs::write(data.join(FORMAT), b"{\"version\":2}").unwrap();
        assert!(guard.prepare().is_err());
        drop(guard);
        assert!(DataGuard::acquire(&data, &app).is_ok());
    }
    #[test]
    fn repeated_restore_preserves_each_generation_and_native_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let app = root.path().join("app");
        let guard = DataGuard::acquire(&data, &app).unwrap();
        private_dir(&app.join("agent-native-call-checkpoints")).unwrap();
        let checkpoint = serde_json::json!({"checkpointId":"checkpoint-fixture","taskId":"task-fixture","targetId":"local","targetKind":"local","targetPath":"/fixture/file","originalSha256":"fixture-hash","originalByteLength":3,"createdAtUnixMs":1,"expiresAtUnixMs":2,"backupFile":"checkpoint-fixture.bin","permissions":384});
        fs::write(
            app.join("agent-native-call-checkpoints/checkpoint-fixture.json"),
            serde_json::to_vec(&checkpoint).unwrap(),
        )
        .unwrap();
        fs::write(
            app.join("agent-native-call-checkpoints/checkpoint-fixture.bin"),
            b"old",
        )
        .unwrap();
        guard.prepare().unwrap();
        for text in ["first", "second"] {
            fs::write(data.join("known_hosts"), text).unwrap();
            fs::write(
                app.join("agent-native-call-checkpoints/checkpoint-fixture.bin"),
                text,
            )
            .unwrap();
            guard.restore().unwrap();
            assert_eq!(
                fs::read(app.join("agent-native-call-checkpoints/checkpoint-fixture.bin")).unwrap(),
                b"old"
            );
        }
        let saves: Vec<_> = fs::read_dir(&data)
            .unwrap()
            .map(|i| i.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".migration-before-restore-")
            })
            .collect();
        assert_eq!(saves.len(), 2);
        let mut values: Vec<_> = saves
            .iter()
            .map(|p| fs::read_to_string(p.join("data/known_hosts")).unwrap())
            .collect();
        values.sort();
        assert_eq!(values, vec!["first", "second"]);
    }
    #[cfg(unix)]
    #[test]
    fn links_and_existing_directory_permissions_are_preserved() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let app = root.path().join("app");
        fs::create_dir_all(&data).unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o750)).unwrap();
        let guard = DataGuard::acquire(&data, &app).unwrap();
        fs::write(root.path().join("hosts"), b"host").unwrap();
        symlink("../hosts", data.join("known_hosts")).unwrap();
        fs::create_dir(root.path().join("history")).unwrap();
        fs::write(root.path().join("history/event"), b"event").unwrap();
        symlink("../history", app.join("agent-runtime")).unwrap();
        guard.prepare().unwrap();
        fs::write(root.path().join("hosts"), b"changed").unwrap();
        fs::write(root.path().join("history/event"), b"changed").unwrap();
        guard.restore().unwrap();
        assert_eq!(
            fs::read_link(data.join("known_hosts")).unwrap(),
            PathBuf::from("../hosts")
        );
        assert_eq!(
            fs::read_link(app.join("agent-runtime")).unwrap(),
            PathBuf::from("../history")
        );
        assert_eq!(
            fs::metadata(&data).unwrap().permissions().mode() & 0o777,
            0o750
        );
        assert_eq!(fs::read(data.join("known_hosts")).unwrap(), b"host");
        assert_eq!(fs::read(app.join("agent-runtime/event")).unwrap(), b"event");
    }
    #[test]
    fn incomplete_and_corrupt_backup_never_claim_success() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let app = root.path().join("app");
        let guard = DataGuard::acquire(&data, &app).unwrap();
        fs::write(data.join("shellspan.db"), b"broken SQLite").unwrap();
        assert!(guard.prepare().is_err());
        assert!(!data.join(BACKUP).exists());
        assert!(!data.join(FORMAT).exists());
        fs::remove_file(data.join("shellspan.db")).unwrap();
        fs::write(data.join("known_hosts"), b"host").unwrap();
        guard.prepare().unwrap();
        fs::write(data.join(BACKUP).join("data/known_hosts"), b"tampered").unwrap();
        assert!(guard.restore().is_err());
        assert_eq!(fs::read(data.join("known_hosts")).unwrap(), b"host");
    }
}
