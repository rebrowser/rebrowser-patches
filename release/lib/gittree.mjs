// Git tree hashes, optionally without some top-level entries (used to compare mirror branches).
import { capture, run } from './exec.mjs';

/** Tree hash of `rev` in repo `cwd`; with `drop`, the hash of the same tree without those top-level names. */
export async function treeOf(cwd, rev, { drop = [] } = {}) {
  const tree = await capture('git', ['rev-parse', `${rev}^{tree}`], { cwd });
  if (!drop.length) return tree;
  const entries = (await capture('git', ['ls-tree', tree], { cwd }))
    .split('\n')
    .filter(Boolean)
    .filter((line) => !drop.includes(line.slice(line.indexOf('\t') + 1)));
  const { stdout } = await run('git', ['mktree'], { cwd, input: entries.length ? `${entries.join('\n')}\n` : '', capture: true, echo: false });
  return stdout.trim();
}
