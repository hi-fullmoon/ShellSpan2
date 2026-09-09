//! Process containment for local terminals, including an abrupt core exit.
//! The Unix guardian owns no application state and receives only a private EOF
//! pipe. Job-control groups share the shell's session and are cleaned together.
#[cfg(unix)]
pub struct TerminalGuard(std::process::Child);
#[cfg(unix)]
impl TerminalGuard {
    pub fn attach(pid: u32) -> Result<Self, String> {
        use std::process::{Command, Stdio};
        let session = unsafe { libc::getsid(pid as i32) };
        // A short command can exit between spawn and attach; setsid succeeded
        // before exec, so its remaining descendants still own session `pid`.
        if session != pid as i32
            && !(session == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH))
        {
            return Err("local terminal did not create a private process session".into());
        }
        Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .args(["--terminal-guardian", &pid.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(Self)
            .map_err(|e| format!("failed to contain local terminal: {e}"))
    }
    pub fn terminate(&mut self) {
        drop(self.0.stdin.take());
        let _ = self.0.wait();
    }
}
#[cfg(unix)]
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(unix)]
pub fn guardian_main(session: i32) {
    use std::io::Read;
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    let mut system = sysinfo::System::new();
    for signal in [libc::SIGTERM, libc::SIGKILL] {
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        for pid in system.processes().keys() {
            let pid = pid.as_u32() as i32;
            // Only the private session created by portable-pty is eligible.
            // This includes foreground/background jobs in separate groups.
            if unsafe { libc::getsid(pid) } == session {
                unsafe {
                    libc::kill(pid, signal);
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

#[cfg(windows)]
pub struct TerminalGuard(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for TerminalGuard {}
#[cfg(windows)]
impl TerminalGuard {
    pub fn attach(pid: u32) -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) != 0
                && !process.is_null()
                && AssignProcessToJobObject(job, process) != 0;
            if !process.is_null() {
                CloseHandle(process);
            }
            if !ok {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error.to_string());
            }
            Ok(Self(job))
        }
    }
    pub fn terminate(&mut self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
