import assert from 'node:assert';
import {
  exclusiveLockPath,
  lockIdentity,
  withExclusiveLock,
} from '../fs/exclusive-lock';
const selftest = require('../tool-testing/selftest.js');
const files = require('../fs/files');
const utils = require('../utils/utils.js');

const { spawn } = require('child_process');

function makeLockPath() {
  return files.pathJoin(files.mkdtemp('exclusive-lock'), 'thing.db');
}

// Takes the same lock from another process, the way a second build would. It
// reports what happened on stdout, a line at a time, and holds the lock until it
// is killed or its input closes.
function holdLockInAnotherProcess(lockPath, { waitMs }) {
  const script = `
    const sqlite3 = require(${JSON.stringify(files.pathJoin(files.getDevBundle(), 'lib', 'node_modules', 'sqlite3'))});
    const db = new sqlite3.Database(${JSON.stringify(files.convertToOSPath(lockPath))});
    db.serialize(() => {
      db.run("PRAGMA busy_timeout = ${waitMs}");
      db.run("BEGIN EXCLUSIVE", err => {
        console.log(err ? "busy:" + err.code : "acquired");
        if (err) process.exit(1);
      });
    });
    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
  `;

  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  child.stdout.on('data', data => lines.push(...String(data).trim().split('\n')));

  return { child, lines };
}

async function waitForLine(lines, description) {
  for (let waited = 0; waited < 10000; waited += 50) {
    if (lines.length > 0) {
      return lines.shift();
    }

    await utils.sleepMs(50);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

selftest.define("exclusive lock - holds the lock for the callback and releases it",
                async function () {
  const lockPath = makeLockPath();

  const result = await withExclusiveLock(lockPath, {}, async function () {
    return 'returned';
  });

  assert.strictEqual(result, 'returned');

  // Released, so the next caller gets straight in.
  let ran = false;
  await withExclusiveLock(lockPath, {}, async function () {
    ran = true;
  });
  assert.ok(ran);
});

selftest.define("exclusive lock - releases the lock when the callback throws",
                async function () {
  const lockPath = makeLockPath();

  await assert.rejects(
    () => withExclusiveLock(lockPath, {}, async function () {
      throw new Error('work failed');
    }),
    /work failed/);

  let ran = false;
  await withExclusiveLock(lockPath, {}, async function () {
    ran = true;
  });
  assert.ok(ran);
});

// An advisory lock would not keep this process out of its own transaction, so
// callers within one process have to take turns before reaching it.
selftest.define("exclusive lock - gives callers in one process their turn",
                async function () {
  const lockPath = makeLockPath();
  const order = [];

  async function hold(name) {
    await withExclusiveLock(lockPath, {}, async function () {
      order.push(`${name} in`);
      await utils.sleepMs(200);
      order.push(`${name} out`);
    });
  }

  await Promise.all([hold('first'), hold('second')]);

  // Whichever went first, neither ran while the other held the lock.
  assert.strictEqual(order.length, 4);
  assert.ok(order[0].endsWith(' in'));
  assert.strictEqual(order[1], order[0].replace(' in', ' out'));
});

selftest.define("exclusive lock - lets a failed turn pass to the next caller",
                async function () {
  const lockPath = makeLockPath();
  let ran = false;

  const failing = withExclusiveLock(lockPath, {}, async function () {
    await utils.sleepMs(100);
    throw new Error('work failed');
  });
  const following = withExclusiveLock(lockPath, {}, async function () {
    ran = true;
  });

  await assert.rejects(() => failing, /work failed/);
  await following;
  assert.ok(ran, "a caller was left waiting behind a failed one");
});

selftest.define("exclusive lock - keeps another process out while it is held",
                async function () {
  const lockPath = makeLockPath();
  let reportedWaiting = 0;

  await withExclusiveLock(lockPath, { onWaiting: () => ++reportedWaiting },
                          async function () {
    const { child, lines } = holdLockInAnotherProcess(lockPath, { waitMs: 100 });
    try {
      assert.strictEqual(await waitForLine(lines, "the other process to report"),
        "busy:SQLITE_BUSY");
    } finally {
      child.kill('SIGKILL');
    }
  });

  // It was free when we asked for it, so there was nothing to report.
  assert.strictEqual(reportedWaiting, 0);
});

selftest.define("exclusive lock - says once that it is waiting for another process",
                async function () {
  const lockPath = makeLockPath();
  files.mkdir_p(files.pathDirname(lockPath));

  const { child, lines } = holdLockInAnotherProcess(lockPath, { waitMs: 10000 });
  assert.strictEqual(await waitForLine(lines, "the other process to take the lock"),
    "acquired");

  let reportedWaiting = 0;
  const acquiring = withExclusiveLock(lockPath, { onWaiting: () => ++reportedWaiting },
                                      async function () {});

  // Long enough for several rounds of waiting on a 200 ms busy timeout.
  await utils.sleepMs(700);
  assert.strictEqual(reportedWaiting, 1);

  child.kill('SIGKILL');
  await acquiring;
});

// What no lock of our own making could do: the holder is killed outright, and the
// next caller takes the lock without anything having to notice or clean up.
selftest.define("exclusive lock - is released when its holder is killed",
                async function () {
  const lockPath = makeLockPath();
  files.mkdir_p(files.pathDirname(lockPath));

  const { child, lines } = holdLockInAnotherProcess(lockPath, { waitMs: 10000 });
  assert.strictEqual(await waitForLine(lines, "the other process to take the lock"),
    "acquired");

  child.kill('SIGKILL');

  let ran = false;
  await withExclusiveLock(lockPath, {}, async function () {
    ran = true;
  });
  assert.ok(ran);
});

// The work a lock guards may rename its directory away, and such directories sit
// in checked-out repositories, so the lock belongs in neither place.
selftest.define("exclusive lock - names a lock under the root it was given",
                async function () {
  const lockRoot = files.mkdtemp('lock-root');
  const resource = files.pathJoin(files.mkdtemp('resource'), '.npm');

  const lockPath = exclusiveLockPath(lockRoot, resource);

  assert.strictEqual(files.pathDirname(lockPath), lockRoot);
  assert.notStrictEqual(lockPath,
    exclusiveLockPath(lockRoot, files.pathJoin(files.mkdtemp('resource'), '.npm')));
});

// Locks are named after the directory holding what they stand for, so that
// builds reaching one directory by different paths still meet on one lock.
selftest.define("exclusive lock - names one lock however the path is spelled",
                async function () {
  const lockRoot = files.mkdtemp('lock-root');
  const packageDir = files.mkdtemp('resource');
  const resource = files.pathJoin(packageDir, '.npm');
  const lockPath = exclusiveLockPath(lockRoot, resource);

  const spelledWithDotDot = files.pathJoin(packageDir, 'elsewhere', '..', '.npm');
  assert.strictEqual(exclusiveLockPath(lockRoot, spelledWithDotDot), lockPath);

  // What a second package directory reached through a link would give.
  const link = files.pathJoin(files.mkdtemp('link'), 'linked');
  files.symlink(packageDir, link);
  assert.strictEqual(exclusiveLockPath(lockRoot, files.pathJoin(link, '.npm')),
    lockPath);

  // Only where the filesystem itself treats the two as one directory, which
  // rules out a case-sensitive one, where they are two.
  const otherCase = files.pathJoin(files.pathDirname(packageDir),
    files.pathBasename(packageDir).toUpperCase(), '.npm');
  if (files.statOrNull(otherCase) || files.statOrNull(files.pathDirname(otherCase))) {
    assert.strictEqual(exclusiveLockPath(lockRoot, otherCase), lockPath);
  }
});

// A package's .npm directory usually has to be built before it exists.
selftest.define("exclusive lock - stands for something not created yet",
                async function () {
  const resource = files.pathJoin(files.mkdtemp('resource'), 'not-there-yet');

  const lockPath = exclusiveLockPath(files.mkdtemp('lock-root'), resource);

  let ran = false;
  await withExclusiveLock(lockPath, {}, async function () {
    ran = true;
  });
  assert.ok(ran);
  assert.ok(! files.exists(resource), "the lock created what it stands for");
});

// Some filesystems, network and FAT-formatted ones among them, report no inode at
// all. Naming every directory on such a device after inode zero would report them
// all as one and serialize builds that have nothing to do with each other.
selftest.define("exclusive lock - identifies a directory without inode numbers",
                async function () {
  const unnumbered = { dev: 42, ino: 0 };
  const packageDir = files.realpath(files.mkdtemp('resource'));
  const resource = files.pathJoin(packageDir, '.npm');

  assert.strictEqual(lockIdentity(resource, { dev: 42, ino: 1234 }),
    '42:1234:.npm');

  // Two directories of one device, still told apart.
  assert.notStrictEqual(
    lockIdentity(files.pathJoin(files.mkdtemp('resource'), '.npm'), unnumbered),
    lockIdentity(resource, unnumbered));

  // And one directory reached two ways still identified as one, which the path
  // as given would not have managed.
  const link = files.pathJoin(files.mkdtemp('link'), 'linked');
  files.symlink(packageDir, link);
  assert.strictEqual(lockIdentity(files.pathJoin(link, '.npm'), unnumbered),
    lockIdentity(resource, unnumbered));
});
