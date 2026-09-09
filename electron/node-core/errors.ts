const unixErrors: Record<string, [string, number]> = {
  EPERM: ['Operation not permitted', 1],
  ENOENT: ['No such file or directory', 2],
  EACCES: ['Permission denied', 13],
  EEXIST: ['File exists', 17],
  EXDEV: ['Cross-device link', 18],
  ENOTDIR: ['Not a directory', 20],
  EISDIR: ['Is a directory', 21],
  EINVAL: ['Invalid argument', 22],
  ENOTEMPTY: ['Directory not empty', 66],
};

export function rustIoDetail(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && process.platform !== 'win32' && unixErrors[code]) {
    const [message, number] = unixErrors[code];
    return `${message} (os error ${number})`;
  }
  if (code === 'ENOENT' && process.platform === 'win32')
    return 'The system cannot find the file specified. (os error 2)';
  return error instanceof Error ? error.message : String(error);
}
