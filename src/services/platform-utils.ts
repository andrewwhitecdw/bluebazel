////////////////////////////////////////////////////////////////////////////////////
// MIT License
//
// Copyright (c) 2021-2026 NVIDIA Corporation
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
////////////////////////////////////////////////////////////////////////////////////

import * as fs from 'fs';
import * as path from 'path';

export function isWindows(): boolean {
    return process.platform === 'win32';
}

let cachedBashPath: string | undefined;

/**
 * Resolves the path to a bash executable. On Unix this is simply
 * `/bin/bash`. On Windows the function probes well-known install
 * locations for MSYS2, Git-for-Windows and WSL, falling back to a
 * bare `bash` (resolved via PATH) when nothing else is found.
 */
export function getBashPath(): string {
    if (cachedBashPath !== undefined) {
        return cachedBashPath;
    }

    if (!isWindows()) {
        cachedBashPath = '/bin/bash';
        return cachedBashPath;
    }

    const candidates: string[] = [
        // MSYS2 default locations
        'C:\\msys64\\usr\\bin\\bash.exe',
        'C:\\msys32\\usr\\bin\\bash.exe',
        // Git for Windows
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
        // WSL
        path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'bash.exe'),
    ];

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                cachedBashPath = candidate;
                return cachedBashPath;
            }
        } catch {
            // Permission errors, etc. — try next candidate.
        }
    }

    cachedBashPath = 'bash';
    return cachedBashPath;
}

/**
 * Resolves a path to GDB. On Unix this is `/usr/bin/gdb`; on Windows
 * we rely on PATH resolution (MSYS2 / MinGW put it on the path).
 */
export function getGdbPath(): string {
    if (!isWindows()) {
        return '/usr/bin/gdb';
    }
    return 'gdb';
}

/**
 * Checks whether a file is a native binary (ELF on Linux/macOS, PE on
 * Windows) by inspecting its magic bytes.
 */
export function isNativeBinary(filePath: string): boolean {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(4);
        fs.readSync(fd, buffer, 0, 4, 0);
        fs.closeSync(fd);

        // ELF: 0x7F 'E' 'L' 'F'
        if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
            return true;
        }
        // PE (Windows): 'M' 'Z'
        if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Recursively searches `startDir` for files whose name matches the
 * given `pattern` (a RegExp). Returns the first match found, or
 * undefined. This replaces shell `find` calls for cross-platform
 * compatibility.
 */
export async function findFileRecursive(startDir: string, pattern: RegExp): Promise<string | undefined> {
    try {
        const entries = await fs.promises.readdir(startDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(startDir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const found = await findFileRecursive(fullPath, pattern);
                if (found) return found;
            } else if (entry.isFile() && pattern.test(entry.name)) {
                return fullPath;
            }
        }
    } catch {
        // Directory not readable — skip.
    }
    return undefined;
}
