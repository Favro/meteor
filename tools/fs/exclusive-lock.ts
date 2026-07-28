/// A lock held across processes, so that two builds do not do the same piece of
/// work in the same place at the same time.
///
/// The lock is SQLite's exclusive transaction: advisory locking on the database
/// file, which the kernel owns and releases when the process ends, so an
/// interrupted build leaves nothing to detect or clean up. That is the whole
/// reason for the roundabout mechanism. A lock made out of a file or directory
/// treats its own existence as ownership, so something must decide a dead
/// holder's lock is abandoned and remove it, and no ordering makes that safe:
/// two waiters can agree it is abandoned, and the second removes the lock the
/// first has since taken. Nothing is written to the database; only its lock
/// state is used.
///
/// Two processes only meet on a lock if they name the same file for it, which is
/// why callers say where their locks live and locks are named after what they
/// stand for rather than the path that reached it. Some ways of sharing a
/// resource still fall outside that:
///
/// XXX A lock root belonging to one user, as an installed Meteor's does, does
///     not meet the other users of a resource they share.
/// XXX A lock root belonging to one checkout does not meet another checkout
///     working on the same resource, such as a package directory named by
///     METEOR_PACKAGE_DIRS in both. Where a resource can be kept per checkout,
///     as isopackets are, prefer that; it leaves nothing to contend over.
/// XXX On a filesystem that numbers no inodes, one directory reached through two
///     capitalizations is taken for two.
///
/// A caller that shares a resource on purpose, as an isopack cache pointed at by
/// more than one application is shared, should name a lock root beside that
/// resource, so that everything reaching the resource reaches the locks too.

import { createHash } from "crypto";
import os from "os";
import { Stats } from "fs";
import * as files from "./files";

const sqlite3 = require("sqlite3");

// The little of sqlite3's API this module uses; the package ships no types.
interface LockDatabase {
  run(statement: string,
      callback: (err: (Error & { code?: string }) | null) => void): void;
  close(callback: (err: Error | null) => void): void;
}

export interface ExclusiveLockOptions {
  onWaiting?: () => void;
}

// How long SQLite waits for a lock before reporting that it is busy, which is
// also how soon a caller gets to say that it is waiting.
const LOCK_BUSY_MS = 200;

// Runs the callback while holding the lock at lockPath, and returns what the
// callback returns. Waits for as long as another process holds it: the holder is
// a live process, so it will finish or die, and either releases the lock.
//
// options.onWaiting is called once, if the lock turns out to be held elsewhere,
// so that a caller can report that it is waiting rather than looking stuck.
//
// Taking a lock that this call already holds would wait for itself; callers that
// nest have to pass the lock down instead.
export async function withExclusiveLock<TResult>(
  lockPath: string,
  options: ExclusiveLockOptions,
  callback: () => TResult | Promise<TResult>,
): Promise<TResult> {
  return await queueForLock(lockPath, async function () {
    files.mkdir_p(files.pathDirname(lockPath));

    const db = await openLockDatabase(lockPath);
    try {
      await beginExclusiveTransaction(db, options);
      try {
        return await callback();
      } finally {
        // Nothing was written, so there is nothing to keep.
        await runLockStatement(db, "ROLLBACK");
      }
    } finally {
      await closeLockDatabase(db);
    }
  });
}

// Names the lock for something that lives elsewhere in the filesystem, such as a
// directory that is about to be rebuilt, placing it under lockRoot. Creates the
// directory that will contain the resource, since that is what the name is taken
// from.
//
// The caller chooses lockRoot because only the caller knows which processes could
// contend for its resource, and the lock has to be somewhere all of them will
// look. It cannot be inside the resource, which the work being guarded replaces,
// leaving later arrivals to open a different file and hold a lock of their own.
export function exclusiveLockPath(lockRoot: string, resourcePath: string): string {
  const resolvedPath = files.pathResolve(resourcePath);
  const containingDir = files.pathDirname(resolvedPath);
  // Created if it is not there yet, so that the name is always taken from the
  // directory; falling back to the path when it happens to be missing would let
  // two processes name one lock two ways and never meet.
  files.mkdir_p(containingDir);

  const key = createHash("sha1")
    .update(lockIdentity(resolvedPath, files.stat(containingDir)))
    .digest("hex");
  // A debugging aid only; the identity hash already covers this name, so two
  // callers the hash brings together cannot disagree over it.
  const readableName = files.pathBasename(resolvedPath)
    .replace(/[^a-zA-Z0-9._-]/g, "_");

  return files.pathJoin(lockRoot, `${readableName}-${key}.db`);
}

// Where locks go when a caller has no better place for them. Everything built
// from a checkout shares that checkout, whichever user started it and whichever
// Meteor installation it came from, and the checkout's .meteor directory is not
// part of what is checked in. An installed Meteor has no such place, since its own
// tree may be read-only, so the user's Meteor home stands in for it.
export function defaultLockRoot(): string {
  if (files.inCheckout()) {
    return files.pathJoin(files.getCurrentToolsDir(), ".meteor", "locks");
  }

  const homeDir = files.getHomeDir();
  if (homeDir) {
    return files.pathJoin(homeDir, ".meteor", "locks");
  }

  // Nowhere dependable to keep them, so somewhere writable will have to do: it
  // keeps processes on the same lock for as long as it lasts.
  return files.pathJoin(os.tmpdir(), "meteor-locks");
}

// What identifies the thing being locked, given the directory that contains it.
//
// A path does not: one directory reached through a symlink, another
// capitalization, or a differently configured package directory would hash to a
// separate lock per spelling. The containing directory's device and inode do,
// together with the name within it. The containing directory rather than the
// thing itself, because the thing is often about to be created, and the guarded
// work replaces it, which would change its inode while the lock has to stay put.
export function lockIdentity(
  resolvedPath: string,
  containingStat: Pick<Stats, "dev" | "ino">,
): string {
  // Not every filesystem numbers its inodes; a network or FAT-formatted one can
  // report nothing at all. The directory's real path stands in: it resolves
  // links, which is most of what the inode would have settled, and unlike a
  // shared inode of zero it still tells one device's directories apart.
  if (! containingStat.ino) {
    return files.pathJoin(files.realpath(files.pathDirname(resolvedPath)),
      files.pathBasename(resolvedPath));
  }

  return `${containingStat.dev}:${containingStat.ino}:${files.pathBasename(resolvedPath)}`;
}

// An advisory lock belongs to the process holding it, so a second connection
// from this one would not be kept out, and would go on to wait for a transaction
// only this process can finish. Callers here take their turns first.
const queuedLocks = new Map<string, Promise<void>>();

function queueForLock<TResult>(
  lockPath: string,
  takeLock: () => Promise<TResult>,
): Promise<TResult> {
  const ahead = queuedLocks.get(lockPath);
  // Whatever went wrong ahead of us is that caller's to report, not ours.
  const ours = (ahead || Promise.resolve()).then(takeLock, takeLock);
  const settled = ours.then(() => {}, () => {});

  queuedLocks.set(lockPath, settled);
  settled.then(() => {
    // Nothing queued behind us, so stop remembering this lock.
    if (queuedLocks.get(lockPath) === settled) {
      queuedLocks.delete(lockPath);
    }
  });

  return ours;
}

// SQLite waits out a lock held by another process itself, reporting SQLITE_BUSY
// once busy_timeout runs out, which is the only chance to say anything about the
// wait before going back to waiting.
async function beginExclusiveTransaction(
  db: LockDatabase,
  options: ExclusiveLockOptions,
): Promise<void> {
  await runLockStatement(db, `PRAGMA busy_timeout = ${LOCK_BUSY_MS}`);

  let reportedWaiting = false;

  while (true) {
    try {
      await runLockStatement(db, "BEGIN EXCLUSIVE");
      return;
    } catch (e: any) {
      if (e.code !== "SQLITE_BUSY") {
        throw e;
      }

      if (! reportedWaiting) {
        if (options.onWaiting) {
          options.onWaiting();
        }

        reportedWaiting = true;
      }
    }
  }
}

function openLockDatabase(lockPath: string): Promise<LockDatabase> {
  return new Promise((resolve, reject) => {
    const db: LockDatabase = new sqlite3.Database(
      files.convertToOSPath(lockPath),
      (err: Error | null) => err ? reject(err) : resolve(db));
  });
}

function runLockStatement(db: LockDatabase, statement: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(statement, err => err ? reject(err) : resolve());
  });
}

function closeLockDatabase(db: LockDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close(err => err ? reject(err) : resolve());
  });
}
