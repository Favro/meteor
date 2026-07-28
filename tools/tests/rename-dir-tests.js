import assert from 'node:assert';

const selftest = require('../tool-testing/selftest.js');
const files = require('../fs/files');

// Builds a parent directory holding a source directory to move into place, and
// returns both paths. The source is named after the temporary directory so the
// tests cannot depend on it being called anything in particular.
function makeReplacement(targetName, contents) {
  const parentDir = files.mkdtemp('rename-dir');
  const fromDir = files.pathJoin(parentDir, 'incoming');
  files.mkdir_p(fromDir);
  files.writeFile(files.pathJoin(fromDir, 'payload'), contents, 'utf8');

  return { parentDir, fromDir, toDir: files.pathJoin(parentDir, targetName) };
}

function makeDirectoryWithPayload(directory, contents) {
  files.mkdir_p(directory);
  files.writeFile(files.pathJoin(directory, 'payload'), contents, 'utf8');
}

function payloadOf(directory) {
  return files.readFile(files.pathJoin(directory, 'payload'), 'utf8');
}

function entriesOf(directory) {
  return files.readdir(directory).sort();
}

// A build killed between the rename aside and the delete leaves the copy behind,
// and nothing looks at it again unless the same directory is replaced.
selftest.define("rename dir - removes the copies an interrupted replacement left behind",
                async function () {
  const { parentDir, fromDir, toDir } = makeReplacement('isopack', 'new');
  makeDirectoryWithPayload(toDir, 'old');
  // Tokens generated before 457ff50e02 keep the '.' of the fraction they come
  // from, so both spellings have to be recognized.
  makeDirectoryWithPayload(files.pathJoin(parentDir, '.isopack-garbage-ma7olb.pxfrn'), 'leaked');
  makeDirectoryWithPayload(files.pathJoin(parentDir, '.isopack-garbage-1f6qtua'), 'leaked');

  await files.renameDirAlmostAtomically(fromDir, toDir);

  assert.deepStrictEqual(entriesOf(parentDir), ['isopack']);
  assert.strictEqual(payloadOf(toDir), 'new');
});

selftest.define("rename dir - leaves the copies of a different directory alone",
                async function () {
  const { parentDir, fromDir, toDir } = makeReplacement('isopack', 'new');
  makeDirectoryWithPayload(toDir, 'old');
  const otherGarbage = files.pathJoin(parentDir, '.other-garbage-1f6qtua');
  makeDirectoryWithPayload(otherGarbage, 'not ours');

  await files.renameDirAlmostAtomically(fromDir, toDir);

  assert.deepStrictEqual(entriesOf(parentDir), ['.other-garbage-1f6qtua', 'isopack']);
  assert.strictEqual(payloadOf(otherGarbage), 'not ours');
});

// The first build of a package has nothing to replace, which must not be
// mistaken for a parent that cannot be listed.
selftest.define("rename dir - puts a directory in place that was not there before",
                async function () {
  const { parentDir, fromDir, toDir } = makeReplacement('isopack', 'new');

  await files.renameDirAlmostAtomically(fromDir, toDir);

  assert.deepStrictEqual(entriesOf(parentDir), ['isopack']);
  assert.strictEqual(payloadOf(toDir), 'new');
});
