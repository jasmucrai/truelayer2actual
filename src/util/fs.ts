import fs from 'fs';
import path from 'path';

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the destination. Prevents a crash mid-write from leaving a
 * truncated JSON file behind.
 */
export function atomicWriteFile(
  filePath: string,
  contents: string,
  options: { mode?: number } = {}
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: options.mode });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
