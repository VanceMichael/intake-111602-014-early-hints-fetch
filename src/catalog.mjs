import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export class Catalog {
  constructor(root) {
    this.root = root;
    this.serial = Promise.resolve();
  }

  async initialize() {
    await mkdir(join(this.root, 'objects'), { recursive: true });
    await mkdir(join(this.root, 'receipts'), { recursive: true });
    await mkdir(join(this.root, 'collections'), { recursive: true });
    return this;
  }

  async atomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async accept({ source, bytes, mediaType, preview }) {
    if (!source || !Buffer.isBuffer(bytes)) throw new TypeError('来源与原始字节不能为空');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.serial.then(async () => {
      await this.initialize();
      const objectPath = join(this.root, 'objects', digest);
      try {
        const existing = await readFile(objectPath);
        if (!existing.equals(bytes)) throw new Error('内容摘要冲突');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this.atomic(objectPath, bytes);
      }
      const receipt = { id: randomUUID(), source, digest, bytes: bytes.length,
        mediaType, preview, receivedAt: new Date().toISOString() };
      await this.atomic(join(this.root, 'receipts', `${receipt.id}.json`),
        Buffer.from(JSON.stringify(receipt, null, 2)));
      return receipt;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async list() {
    await this.initialize();
    const files = (await readdir(join(this.root, 'receipts'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(files.map(name => readFile(join(this.root, 'receipts', name), 'utf8').then(JSON.parse)));
  }

  async saveCollection(record) {
    if (!record || !record.id) throw new TypeError('采集记录缺少标识');
    const operation = this.serial.then(async () => {
      await this.initialize();
      await this.atomic(join(this.root, 'collections', `${record.id}.json`),
        Buffer.from(JSON.stringify(record, null, 2)));
      return record;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async collections() {
    await this.initialize();
    const files = (await readdir(join(this.root, 'collections'))).filter(name => name.endsWith('.json')).sort();
    return Promise.all(files.map(name => readFile(join(this.root, 'collections', name), 'utf8').then(JSON.parse)));
  }

  async collection(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的采集标识');
    await this.initialize();
    try {
      return JSON.parse(await readFile(join(this.root, 'collections', `${id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('没有此采集记录');
      throw error;
    }
  }

  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('无效的内容摘要');
    const bytes = await readFile(join(this.root, 'objects', digest));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('原件校验失败');
    return bytes;
  }
}
