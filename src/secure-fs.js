#!/usr/bin/env node
/**
 * Shared owner-only file writes for the claude-flow helper scripts.
 *
 * Session state and cross-session memory hold conversation context, cwd paths
 * and whatever callers stash in them. They were being written with a bare
 * fs.writeFileSync, so the umask decided the mode and every file landed
 * world-readable (0644).
 *
 * Two things matter here and only one of them is the `mode` option:
 *
 *   1. `{ mode }` applies only when the file is CREATED, and is masked by the
 *      umask on top of that. `current.json` and `memory.json` are rewritten in
 *      place on every session, so an already-0644 file stays 0644 forever no
 *      matter what mode later writes request. That was the actual failure mode.
 *   2. Writing in place is also non-atomic — a reader that opens the file
 *      mid-write sees truncated JSON. Every consumer here does a bare
 *      JSON.parse.
 *
 * Writing to a temp file and renaming solves both: the rename swaps in a fresh
 * inode that carries the temp file's 0600, so the mode is correct even when the
 * destination already existed, and readers see either the old file or the new
 * one and never a partial write.
 */

const fs = require('fs');
const path = require('path');

const FILE_MODE = 0o600; // rw-------
const DIR_MODE = 0o700; // rwx------

/** Creates `dir` if needed and forces owner-only permissions on it. */
function ensureDirSecure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    // Directory may be owned by another user in a shared checkout; the file
    // mode below is the control that actually matters.
  }
}

/**
 * Atomically writes `contents` to `file` with mode 0600, creating the parent
 * directory as 0700. Replaces an existing file's permissions as well as its
 * contents. Throws whatever the underlying fs call throws, after cleaning up
 * the temp file.
 */
function writeFileSecure(file, contents) {
  ensureDirSecure(path.dirname(file));
  // Same directory as the destination so the rename stays on one filesystem
  // (rename(2) is only atomic within a filesystem). PID-suffixed so concurrent
  // helper processes cannot clobber each other's temp file.
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, contents, { mode: FILE_MODE });
    // The mode option above is masked by the umask; chmod is not.
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Temp file may never have been created.
    }
    throw err;
  }
}

/** Serialises `value` as pretty JSON and writes it via writeFileSecure. */
function writeJsonSecure(file, value) {
  writeFileSecure(file, JSON.stringify(value, null, 2));
}

/**
 * Appends to `file`, creating it 0600 if absent.
 *
 * Append cannot use the temp+rename trick — the point is to add to what is
 * already there. Instead the file is created empty at 0600 first, so the
 * append never becomes the operation that creates it under the umask. An
 * existing file's mode is corrected on the way past.
 */
function appendFileSecure(file, contents) {
  ensureDirSecure(path.dirname(file));
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '', { mode: FILE_MODE });
  }
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    // Not fatal — the append below is still the caller's intent.
  }
  fs.appendFileSync(file, contents);
}

module.exports = {
  writeFileSecure,
  writeJsonSecure,
  appendFileSecure,
  ensureDirSecure,
  FILE_MODE,
  DIR_MODE,
};
