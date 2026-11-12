import { Service } from 'typedi';
import fs, { constants, Stats } from 'fs';
import { FileHandle, mkdir, lstat, realpath, open, unlink, rmdir } from 'fs/promises';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { Writable } from 'stream';
import formidable from 'formidable';
import { Request, Response } from 'express';
import { CONFIG } from '@/config/config';
import { CapturedObject, DOCUMENT_BYTES, FileVersion, PRIVATE_SUBTREE, VerifiedObject } from './documentTypes';
import { documentError, input, media } from './validation';

function identity(st: Stats): string { return [st.dev, st.ino, st.uid, st.mode & 0o777, st.nlink, st.size, st.mtimeMs, st.ctimeMs].join(':'); }
function directory(st: Stats): string {
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw documentError();
  return [st.dev, st.ino, st.uid, st.mode & 0o777].join(':');
}
function file(st: Stats): void {
  if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) throw documentError();
}

/** Used by EVERY legacy read/write/delete alias, before any legacy byte operation.
 * Trusted-root/same-uid threat boundary is the same as the private storage adapter.
 */
export function legacyPath(raw: unknown, root: string): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 1024 || /[%\\\x00-\x1f\x7f?#~]/.test(raw) || path.isAbsolute(raw)) {
    throw documentError(400, 'DOCUMENT_INPUT_INVALID');
  }
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === PRIVATE_SUBTREE)) {
    throw documentError(404, 'DOCUMENT_NOT_FOUND');
  }
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  if (!full.startsWith(base + path.sep)) throw documentError(404, 'DOCUMENT_NOT_FOUND');
  // Reject existing symlink components, including a symlink to a private object under a public name.
  let current = base;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw documentError(404, 'DOCUMENT_NOT_FOUND');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return full;
}
export function legacyUploadScope(module: unknown, recordId: unknown): void {
  input(typeof module === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(module) && module.toLowerCase() !== PRIVATE_SUBTREE);
  input(recordId === undefined || (typeof recordId === 'string' && /^[a-fA-F0-9]{24}$/.test(recordId)));
}

@Service()
export class FileDocumentStorage {
  private readonly root = path.resolve(CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files'));
  private readonly privateRoot = path.join(this.root, PRIVATE_SUBTREE);
  private rootIdentity?: string;
  private privateIdentity?: string;

  private async roots(): Promise<void> {
    const root = await lstat(this.root);
    const rootId = directory(root);
    if (await realpath(this.root) !== this.root || (this.rootIdentity !== undefined && this.rootIdentity !== rootId)) throw documentError();
    this.rootIdentity = rootId;
    try { await mkdir(this.privateRoot, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const privateId = directory(await lstat(this.privateRoot));
    if (await realpath(this.privateRoot) !== this.privateRoot || (this.privateIdentity !== undefined && this.privateIdentity !== privateId)) throw documentError();
    this.privateIdentity = privateId;
    if (directory(await lstat(this.root)) !== rootId) throw documentError();
  }
  private async child(parent: string, name: string): Promise<string> {
    if (!/^[a-f0-9]{24}$/.test(name)) throw documentError();
    const dir = path.join(parent, name);
    try { await mkdir(dir, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    directory(await lstat(dir));
    if (await realpath(dir) !== dir) throw documentError();
    return dir;
  }
  private key(key: string): string {
    if (!/^[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9]{64}$/.test(key)) throw documentError();
    return path.join(this.privateRoot, key);
  }
  private async verify(handle: FileHandle, expected: CapturedObject, deadline = Date.now() + 30000): Promise<VerifiedObject> {
    const before = await handle.stat(); file(before);
    if (before.size !== expected.actualSize || before.size < 1 || before.size > DOCUMENT_BYTES) throw documentError();
    const hash = createHash('sha256'); let position = 0; let prefix = Buffer.alloc(0);
    const buffer = Buffer.alloc(65536);
    while (position < before.size) {
      if (Date.now() >= deadline) throw documentError();
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!result.bytesRead) throw documentError();
      const chunk = buffer.subarray(0, result.bytesRead); hash.update(chunk);
      if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (Date.now() >= deadline || identity(before) !== identity(after) || hash.digest('hex') !== expected.contentSha256 || media(prefix) !== expected.mediaType) throw documentError();
    return { handle, size: position, mediaType: expected.mediaType, identity: identity(after) };
  }
  async verified(v: Pick<FileVersion, 'storageKey' | 'actualSize' | 'contentSha256' | 'mediaType'>, deadline = Date.now() + 30000): Promise<VerifiedObject> {
    await this.roots();
    const [assetId, versionId] = v.storageKey.split('/');
    const full = this.key(v.storageKey);
    for (const dir of [path.join(this.privateRoot, assetId), path.join(this.privateRoot, assetId, versionId)]) {
      directory(await lstat(dir)); if (await realpath(dir) !== dir) throw documentError();
    }
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const verified = await this.verify(handle, v, deadline); await this.roots(); return verified; }
    catch (error) { await handle.close(); throw error; }
  }
  async boundedRead(verified: VerifiedObject, position: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > 65536 || position + length > verified.size) throw documentError();
    if (identity(await verified.handle.stat()) !== verified.identity) throw documentError();
    const buffer = Buffer.alloc(length);
    const result = await verified.handle.read(buffer, 0, length, position);
    return buffer.subarray(0, result.bytesRead);
  }
  async capture(req: Request, assetId: string, versionId: string): Promise<CapturedObject> {
    await this.roots();
    const staging = path.join(this.privateRoot, 'stage-' + randomBytes(32).toString('hex'));
    await mkdir(staging, { mode: 0o700 });
    const stageIdentity = directory(await lstat(staging));
    const temporary = path.join(staging, randomBytes(32).toString('hex'));
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const temporaryIdentity = identity(await handle.stat());
    let size = 0; let pending = Promise.resolve(); let seen = 0; let declared: string | null = null;
    let prefix = Buffer.alloc(0); const hash = createHash('sha256');
    const writer = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        pending = pending.then(async () => {
          if (!Buffer.isBuffer(chunk) || size + chunk.length > DOCUMENT_BYTES) throw documentError(413, 'DOCUMENT_TOO_LARGE');
          let offset = 0;
          while (offset < chunk.length) {
            const wrote = await handle.write(chunk, offset, chunk.length - offset, size + offset);
            if (!wrote.bytesWritten) throw documentError(); offset += wrote.bytesWritten;
          }
          hash.update(chunk); if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
          size += chunk.length;
        });
        pending.then(() => callback(), error => callback(error));
      },
      final: callback => { pending.then(() => handle.sync()).then(() => callback(), error => callback(error)); },
    });
    // Formidable receives no default public/temp file writer; one owned fd handles its sole file.
    const form = formidable({ maxFiles: 1, maxFileSize: DOCUMENT_BYTES, maxTotalFileSize: DOCUMENT_BYTES,
      maxFields: 1, maxFieldsSize: 4096, allowEmptyFiles: false, minFileSize: 1,
      fileWriteStreamHandler: () => writer });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let requestBytes = 0;
    const boundRequest = (chunk: Buffer) => {
      requestBytes += chunk.length;
      if (requestBytes > DOCUMENT_BYTES + 16384) { form.emit('error', documentError(413, 'DOCUMENT_TOO_LARGE')); req.destroy(); }
    };
    const abort = () => form.emit('error', documentError());
    req.once('aborted', abort);
    req.on('data', boundRequest);
    form.on('fileBegin', (name, upload) => {
      seen += 1;
      if (seen !== 1 || name !== 'file' || typeof upload.originalFilename !== 'string' || Buffer.byteLength(upload.originalFilename) > 128) {
        form.emit('error', documentError(400, 'DOCUMENT_INPUT_INVALID')); return;
      }
      declared = upload.mimetype;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => { form.emit('error', documentError()); req.destroy(); }, 30000);
        form.parse(req, (error, fields, files) => {
          if (error) { reject(error); return; }
          if (seen !== 1 || Object.keys(fields).length !== 0 || Object.keys(files).length !== 1 || !files.file) {
            reject(documentError(400, 'DOCUMENT_INPUT_INVALID')); return;
          }
          resolve();
        });
      });
      await pending; await handle.sync();
      const actualMedia = media(prefix);
      if (declared !== actualMedia || size < 1 || size > DOCUMENT_BYTES) throw documentError(415, 'DOCUMENT_MEDIA_UNSUPPORTED');
      file(await handle.stat());
      await handle.close();
      const reader = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const captured = { storageKey: '', contentSha256: hash.digest('hex'), actualSize: size, mediaType: actualMedia };
        const verified = await this.verify(reader, captured);
        const assetDir = await this.child(this.privateRoot, assetId);
        const versionDir = await this.child(assetDir, versionId);
        captured.storageKey = assetId + '/' + versionId + '/' + randomBytes(32).toString('hex');
        const target = await open(path.join(versionDir, captured.storageKey.split('/')[2]),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          file(await target.stat());
          let position = 0;
          while (position < size) {
            const chunk = await this.boundedRead(verified, position, Math.min(65536, size - position));
            if (!chunk.length) throw documentError();
            let offset = 0;
            while (offset < chunk.length) {
              const wrote = await target.write(chunk, offset, chunk.length - offset, position + offset);
              if (!wrote.bytesWritten) throw documentError(); offset += wrote.bytesWritten;
            }
            position += chunk.length;
          }
          await target.sync();
        } finally { await target.close(); }
        const persisted = await this.verified(captured);
        await persisted.handle.close();
        return captured;
      } finally { await reader.close(); }
    } catch (error) {
      if ((error as { name?: string }).name === 'AppError') throw error;
      const status = (error as { httpCode?: number }).httpCode;
      throw status === 413 ? documentError(413, 'DOCUMENT_TOO_LARGE') : documentError();
    } finally {
      if (timeout) clearTimeout(timeout); req.removeListener('aborted', abort); req.removeListener('data', boundRequest); writer.destroy();
      await pending.catch(() => undefined);
      // Only delete this admitted staging inode/directory; final private orphans are retained.
      try { await handle.close(); } catch { /* Handle may already have been closed before promotion. */ }
      const current = await lstat(temporary).catch(() => null);
      if (current && [current.dev, current.ino, current.uid, current.mode & 0o777, current.nlink].join(':') === temporaryIdentity.split(':').slice(0, 5).join(':') &&
        directory(await lstat(staging)) === stageIdentity) {
        await unlink(temporary); await rmdir(staging);
      }
    }
  }
  async stream(v: VerifiedObject, req: Request, res: Response, count: (n: number) => void, end = Date.now() + 30000): Promise<void> {
    let position = 0; let responseFailed = false;
    const failed = () => { responseFailed = true; };
    res.on('error', failed);
    try {
      while (position < v.size && req.method !== 'HEAD') {
        if (Date.now() >= end || req.aborted || res.destroyed || responseFailed) throw documentError();
        const chunk = await this.boundedRead(v, position, Math.min(65536, v.size - position));
        if (!chunk.length || Date.now() >= end) throw documentError();
        position += chunk.length;
        const draining = res.write(chunk); count(position);
        if (!draining) await new Promise<void>((resolve, reject) => {
          const done = (error?: Error) => { clearTimeout(timer); res.removeListener('drain', drain); res.removeListener('close', close); error ? reject(error) : resolve(); };
          const drain = () => done(); const close = () => done(documentError());
          const timer = setTimeout(() => done(documentError()), Math.max(1, end - Date.now()));
          res.once('drain', drain); res.once('close', close);
        });
      }
      if (responseFailed || identity(await v.handle.stat()) !== v.identity) throw documentError();
      await this.roots();
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => { clearTimeout(timer); res.removeListener('close', close); error ? reject(error) : resolve(); };
        const close = () => { if (!res.writableFinished) done(documentError()); };
        const timer = setTimeout(() => done(documentError()), Math.max(1, end - Date.now()));
        res.once('close', close); res.end(() => done(responseFailed ? documentError() : undefined));
      });
    } finally { res.removeListener('error', failed); }
  }
}
