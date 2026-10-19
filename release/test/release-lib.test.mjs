// Unit tests for the release tooling helpers: node --test 'release/test/*.test.mjs'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { treeOf } from '../lib/gittree.mjs';
import { ORIG_TAR, SRC_TAR, UPSTREAM_TOOLING, writeSourceTars } from '../lib/pysource.mjs';
import { planUploads, readRecord } from '../lib/wheel.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rbp-test-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

test('planUploads: upload missing, skip same bytes or same RECORD, conflict on a different RECORD', () => {
  const rec = ['a.py,sha256=1,1', 'b.dist-info/RECORD,,'];
  const local = [
    { file: 'new.whl', sha256: 'n' },
    { file: 'same-bytes.whl', sha256: 's' },
    { file: 'rebuilt.whl', sha256: 'r2', record: rec },
    { file: 'changed.whl', sha256: 'c2', record: ['a.py,sha256=2,1', 'b.dist-info/RECORD,,'] },
  ];
  const published = new Map([
    ['same-bytes.whl', { sha256: 's' }],
    ['rebuilt.whl', { sha256: 'r1', record: [...rec] }],
    ['changed.whl', { sha256: 'c1', record: rec }],
  ]);
  assert.deepEqual(planUploads(local, published), { upload: ['new.whl'], skip: ['same-bytes.whl', 'rebuilt.whl'], conflicts: ['changed.whl'] });
  assert.deepEqual(planUploads(local, new Map()).upload, local.map((w) => w.file));
});

test('readRecord returns the sorted RECORD lines of a wheel', async () => {
  const dir = tmpDir();
  const whl = path.join(dir, 'x-1.0-py3-none-any.whl');
  execFileSync('python3', ['-c', `import zipfile; z = zipfile.ZipFile(${JSON.stringify(whl)}, 'w'); z.writestr('x/__init__.py', ''); z.writestr('x-1.0.dist-info/RECORD', 'x/__init__.py,sha256=b,0\\nx-1.0.dist-info/RECORD,,\\n'); z.close()`]);
  assert.deepEqual(await readRecord(whl), ['x-1.0.dist-info/RECORD,,', 'x/__init__.py,sha256=b,0']);
});

test('treeOf with drop ignores the dropped top-level entries only', async () => {
  const dir = tmpDir();
  git(dir, 'init', '-q');
  write(dir, 'a.txt', 'a');
  write(dir, 'src/b.txt', 'b');
  write(dir, '.github/workflows/ci.yml', 'x');
  write(dir, '.azure-pipelines/build.yml', 'x');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'with tooling');
  fs.rmSync(path.join(dir, '.github'), { recursive: true });
  fs.rmSync(path.join(dir, '.azure-pipelines'), { recursive: true });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'without tooling');
  assert.notEqual(await treeOf(dir, 'HEAD~1'), await treeOf(dir, 'HEAD'));
  assert.equal(await treeOf(dir, 'HEAD~1', { drop: UPSTREAM_TOOLING }), await treeOf(dir, 'HEAD', { drop: UPSTREAM_TOOLING }));
  write(dir, 'src/b.txt', 'changed');
  git(dir, 'commit', '-q', '-am', 'real change');
  assert.notEqual(await treeOf(dir, 'HEAD~1', { drop: UPSTREAM_TOOLING }), await treeOf(dir, 'HEAD', { drop: UPSTREAM_TOOLING }));
});

test('writeSourceTars: tracked + untracked files, not ignored ones or egg-info; orig = the commit', async () => {
  const clone = tmpDir();
  const out = tmpDir();
  git(clone, 'init', '-q');
  write(clone, '.gitignore', 'build/\n');
  write(clone, 'setup.py', 'orig');
  fs.chmodSync(path.join(clone, 'setup.py'), 0o755);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'tag');
  write(clone, 'setup.py', 'patched');
  write(clone, 'pkg/new.py', 'new');
  write(clone, 'build/lib/x.py', 'ignored');
  write(clone, 'pkg.egg-info/PKG-INFO', 'egg');
  await writeSourceTars(clone, out);
  const list = (tar) => execFileSync('tar', ['-tf', path.join(out, tar)], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  assert.deepEqual(list(SRC_TAR), ['.gitignore', 'pkg/new.py', 'setup.py']);
  assert.deepEqual(list(ORIG_TAR), ['.gitignore', 'setup.py']);
  const ex = tmpDir();
  execFileSync('tar', ['-xpf', path.join(out, SRC_TAR), '-C', ex]);
  assert.equal(fs.readFileSync(path.join(ex, 'setup.py'), 'utf8'), 'patched');
  assert.ok(fs.statSync(path.join(ex, 'setup.py')).mode & 0o100, 'keeps the exec bit');
  assert.deepEqual(fs.readdirSync(out).sort(), [ORIG_TAR, SRC_TAR]);
});
