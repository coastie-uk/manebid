const fs = require('node:fs');
const path = require('node:path');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const ZIP_SIGNATURES = new Set([
  '504b0304',
  '504b0506',
  '504b0708'
]);

function assertZipSignature(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const signature = Buffer.alloc(4);
    if (fs.readSync(fd, signature, 0, signature.length, 0) !== signature.length
      || !ZIP_SIGNATURES.has(signature.toString('hex'))) {
      throw new Error('Uploaded file is not a ZIP archive.');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function validateArchivePath(name) {
  if (
    typeof name !== 'string'
    || !name
    || name.startsWith('/')
    || name.includes('\\')
    || name.includes('\0')
  ) {
    throw new Error(`Invalid archive entry path: ${name || '(empty)'}`);
  }
  const normalized = path.posix.normalize(name);
  if (normalized !== name || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid archive entry path: ${name}`);
  }
}

function isUnsupportedUnixEntry(entry, isDirectory) {
  const platform = (entry.versionMadeBy >>> 8) & 0xff;
  if (platform !== 3) return false;
  const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (fileType === 0) return false;
  return isDirectory ? fileType !== 0o040000 : fileType !== 0o100000;
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

/**
 * Streams and validates every ZIP entry. Files selected by destinationForEntry
 * are written only to an isolated caller-owned staging directory.
 */
async function processZipArchive(zipPath, {
  maxArchiveBytes,
  maxExpandedBytes,
  maxEntryBytes,
  maxEntries,
  validateEntryName,
  destinationForEntry = () => null
}) {
  const archiveStats = fs.statSync(zipPath);
  if (!archiveStats.isFile()) {
    throw new Error('Backup archive is not a regular file.');
  }
  if (archiveStats.size > maxArchiveBytes) {
    throw new Error(`Backup archive exceeds the ${maxArchiveBytes}-byte compressed size limit.`);
  }
  assertZipSignature(zipPath);

  const zip = await openZip(zipPath);
  const entries = [];
  const seenNames = new Set();
  let entryCount = 0;
  let declaredExpandedBytes = 0;
  let actualExpandedBytes = 0;

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch (_closeError) {
        // Preserve the validation error.
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({
        archiveSizeBytes: archiveStats.size,
        expandedSizeBytes: actualExpandedBytes,
        entries
      });
    });

    zip.on('entry', (entry) => {
      void (async () => {
        const name = entry.fileName;
        const isDirectory = name.endsWith('/');
        entryCount += 1;
        if (entryCount > maxEntries) {
          throw new Error(`Backup archive contains more than ${maxEntries} entries.`);
        }
        validateArchivePath(name);
        if (seenNames.has(name)) {
          throw new Error(`Backup archive contains duplicate entry: ${name}`);
        }
        seenNames.add(name);
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          throw new Error(`Encrypted archive entries are not supported: ${name}`);
        }
        if (isUnsupportedUnixEntry(entry, isDirectory)) {
          throw new Error(`Unsupported archive entry type: ${name}`);
        }
        validateEntryName(name);

        if (isDirectory) {
          zip.readEntry();
          return;
        }

        if (entry.uncompressedSize > maxEntryBytes) {
          throw new Error(`Archive entry exceeds the per-entry size limit: ${name}`);
        }
        declaredExpandedBytes += entry.uncompressedSize;
        if (declaredExpandedBytes > maxExpandedBytes) {
          throw new Error('Backup archive exceeds the total expanded size limit.');
        }

        const input = await openEntryStream(zip, entry);
        let actualEntryBytes = 0;
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            actualEntryBytes += chunk.length;
            actualExpandedBytes += chunk.length;
            if (actualEntryBytes > maxEntryBytes) {
              callback(new Error(`Archive entry exceeds the per-entry size limit: ${name}`));
              return;
            }
            if (actualExpandedBytes > maxExpandedBytes) {
              callback(new Error('Backup archive exceeds the total expanded size limit.'));
              return;
            }
            callback(null, chunk);
          }
        });

        const destination = destinationForEntry(name);
        if (destination) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          await pipeline(input, meter, fs.createWriteStream(destination, {
            flags: 'wx',
            mode: 0o600
          }));
        } else {
          await pipeline(input, meter, new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            }
          }));
        }

        entries.push({
          name,
          compressedSize: entry.compressedSize,
          uncompressedSize: actualEntryBytes
        });
        zip.readEntry();
      })().catch(fail);
    });

    zip.readEntry();
  });
}

module.exports = {
  assertZipSignature,
  processZipArchive
};
