#!/usr/bin/env python3
"""Verify a macOS listener by its cwd and immediate parent executable, not argv."""
import ctypes
import os
import subprocess
import sys


def process_executable(pid):
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    lib.proc_pidpath.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid, buffer, len(buffer)) <= 0:
        raise OSError("Process executable is unavailable")
    return os.fsdecode(buffer.value)


def belongs_to_app(pid, app):
    try:
        app = os.path.realpath(app)
        name = os.path.basename(app)
        if not name.endswith(".app") or pid <= 0:
            return False
        cwd_output = subprocess.check_output(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            text=True, stderr=subprocess.DEVNULL, timeout=5)
        cwd = next(line[1:] for line in cwd_output.splitlines() if line.startswith("n"))
        parent = int(subprocess.check_output(
            ["ps", "-o", "ppid=", "-p", str(pid)],
            text=True, stderr=subprocess.DEVNULL, timeout=5).strip())
        if parent <= 1:
            return False
        return (os.path.realpath(cwd) == os.path.join(app, "Contents", "Resources", "standalone")
                and os.path.realpath(process_executable(parent)) ==
                os.path.join(app, "Contents", "MacOS", name[:-4]))
    except (OSError, ValueError, StopIteration, subprocess.SubprocessError):
        return False


if __name__ == "__main__":
    try:
        valid = len(sys.argv) == 3 and belongs_to_app(int(sys.argv[1]), sys.argv[2])
    except ValueError:
        valid = False
    sys.exit(0 if valid else 1)
