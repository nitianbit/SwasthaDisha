/**
 * Imported FIRST by the Q5 test, before any application module reads its configuration: creates the test's own upload
 * directory and points UPLOAD_DIR at it. A supplied UPLOAD_DIR is refused, so the test never touches (or deletes) a
 * directory it did not create.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.UPLOAD_DIR !== undefined) throw new Error('Refusing to run: do not set UPLOAD_DIR; the test creates its own');
/** Created here, exclusively (mkdtemp), so its exact path is ours to remove. */
export const FIXTURE_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'q5-files-')));
export const UPLOAD_DIR = path.join(FIXTURE_DIR, 'files');
fs.mkdirSync(UPLOAD_DIR);
process.env.UPLOAD_DIR = UPLOAD_DIR;

/** Removes exactly the directory created above (never a symlink, never anything else). */
export function removeFixtureDir(): void {
  const st = fs.lstatSync(FIXTURE_DIR);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.()) throw new Error('fixture directory changed');
  fs.rmSync(FIXTURE_DIR, { recursive: true });
}
