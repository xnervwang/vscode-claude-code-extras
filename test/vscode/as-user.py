# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

# Usage: python3 as-user.py <uid> <gid> <program> [<arg>...]
#
# run.js starts the test stage under `unshare -rn`, which gives it a network namespace with nothing but loopback, and
# maps the caller to root to do so. VS Code run as root behaves differently (it says so in the title bar, and every
# file is writable to it), so this makes one more user namespace, maps the caller's own ids back in, and runs the
# program as them. Written against the system call because util-linux before 2.38 cannot map to anything but root.
import ctypes
import os
import sys

CLONE_NEWUSER = 0x10000000

uid, gid = int(sys.argv[1]), int(sys.argv[2])
libc = ctypes.CDLL(None, use_errno=True)
if libc.unshare(CLONE_NEWUSER) != 0:
    sys.exit('as-user.py: unshare(CLONE_NEWUSER): %s' % os.strerror(ctypes.get_errno()))
for name, text in (('setgroups', 'deny'), ('uid_map', '%d 0 1' % uid), ('gid_map', '%d 0 1' % gid)):
    with open('/proc/self/' + name, 'w') as f:
        f.write(text)
os.execvp(sys.argv[3], sys.argv[3:])
