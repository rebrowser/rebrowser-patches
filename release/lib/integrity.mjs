// Hashes computed the same way npm computes them for dist.integrity / dist.shasum.
import crypto from 'node:crypto';
import fs from 'node:fs';

/** `sha512-<base64>`, identical to npm's `dist.integrity` for a tarball. */
export const integrityOf = (buf) => `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
/** Hex sha1, identical to npm's `dist.shasum`. */
export const shasumOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
export const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const integrityOfFile = (file) => integrityOf(fs.readFileSync(file));
export const shasumOfFile = (file) => shasumOf(fs.readFileSync(file));
export const sha256OfFile = (file) => sha256Of(fs.readFileSync(file));
