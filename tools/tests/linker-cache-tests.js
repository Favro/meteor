import assert from 'node:assert';
import { removeStaleLinkerCacheFiles } from '../isobuild/compiler-plugin';
const selftest = require('../tool-testing/selftest.js');
const files = require('../fs/files');

function makeCacheDir(entries) {
  const cacheDir = files.mkdtemp('linker-cache');
  entries.forEach(entry => {
    files.writeFile(files.pathJoin(cacheDir, entry), 'x');
  });
  return cacheDir;
}

function remaining(cacheDir) {
  return files.readdir(cacheDir).sort();
}

selftest.define("linker cache - removes superseded entries of one prefix",
                function () {
  const cacheDir = makeCacheDir([
    'aaa_1.cache',
    'aaa_2.cache',
    'aaa_3.cache',
    'bbb_1.cache',
  ]);
  const current = files.pathJoin(cacheDir, 'aaa_3.cache');

  const removed = removeStaleLinkerCacheFiles(cacheDir, 'aaa', current);

  assert.deepStrictEqual(removed.map(p => files.pathBasename(p)).sort(),
                         ['aaa_1.cache', 'aaa_2.cache']);
  // The entry about to be written stays, and another package is untouched.
  assert.deepStrictEqual(remaining(cacheDir), ['aaa_3.cache', 'bbb_1.cache']);
});

selftest.define("linker cache - matches on the whole prefix and extension",
                function () {
  const cacheDir = makeCacheDir([
    'aaa_1.cache',
    // A prefix that merely starts with the same characters is another package.
    'aaabbb_1.cache',
    // Not written by the linker cache, so not ours to remove.
    'aaa_1.cache.old-123',
    'aaa.cache',
  ]);

  const removed = removeStaleLinkerCacheFiles(
    cacheDir, 'aaa', files.pathJoin(cacheDir, 'aaa_2.cache'));

  assert.deepStrictEqual(removed.map(p => files.pathBasename(p)),
                         ['aaa_1.cache']);
  assert.deepStrictEqual(remaining(cacheDir),
                         ['aaa.cache', 'aaa_1.cache.old-123', 'aaabbb_1.cache']);
});

selftest.define("linker cache - tolerates a cache directory that is gone",
                async function () {
  const cacheDir = makeCacheDir(['aaa_1.cache']);
  await files.rm_recursive(cacheDir);

  assert.deepStrictEqual(
    removeStaleLinkerCacheFiles(cacheDir, 'aaa',
                                files.pathJoin(cacheDir, 'aaa_2.cache')),
    []);
});
