const path = require('path');
const zlib = require('zlib');
const tar = require('tar-stream');
const TrashWriteStream = require('./TrashWriteStream');
const { PassThrough } = require('stream');
const { streamPipelinePromise } = require('./utils');

const PUT_OBJECT_LIMIT = 5 * 1024 * 1024 * 1024;

class CosTGunzipFileTask {
  constructor({
    cosInstance,
    bucket,
    region,
    key,
    targetBucket,
    targetRegion,
    targetPrefix,
    extraRootDir,
    maxTryTime = 3,
  }) {
    const extname = /\.tar.gz$/.test(key) ? '.tar.gz' : path.extname(key);
    const basename = path.basename(key, extname);
    const dirname = path.dirname(key);
    const extraPaths = [
      extraRootDir.toLowerCase().includes('dirname') ? dirname : '',
      extraRootDir.toLowerCase().includes('basename') ? basename : '',
    ].filter(Boolean);

    Object.assign(this, {
      cosInstance,
      bucket,
      region,
      key,
      targetBucket,
      targetRegion,
      targetPrefix: path.join(targetPrefix, ...extraPaths).replace(/\\/g, '/'),
      maxTryTime,
      results: [],
      passThrough: null,
      cancelError: null,
    });
  }
  async runTask() {
    for (let i = 0; i < this.maxTryTime; i++) {
      try {
        if (this.cancelError) {
          throw this.cancelError;
        }
        await this.runTaskOnce();
        break;
      } catch (error) {
        // if task is canceled or error cause by cancelError, do not retry
        if (
          this.cancelError
          || (error.error
            && error.error.message
            && error.error.message.includes
            && error.error.message.includes('checkFileSize'))
        ) {
          break;
        }
      }
    }
    return this.results;
  }
  runTaskOnce() {
    return new Promise((resolve, reject) => {
      const { bucket, region, key } = this;
      this.results = this.results.filter(item => !item.error);

      let index = -1;
      this.cosInstance
        .getObjectStream({
          Bucket: bucket,
          Region: region,
          Key: key,
        })
        .pipe(zlib.createGunzip())
        .pipe(tar.extract())
        .on('entry', async (header, stream, next) => {
          index += 1;
          const params = {
            name: header.name,
            size: header.size,
          };
          try {
            if (this.cancelError) {
              throw this.cancelError;
            }
            if (this.results[index]) {
              await this.skipOneTask({ stream });
              next();
            } else {
              const result = await this.runOneTask({ header, stream });
              this.results.push({
                params,
                result,
              });
              next();
            }
          } catch (error) {
            this.results.push({
              params,
              error,
            });
            next(error);
          }
        })
        .on('error', error => reject(error))
        .on('finish', () => resolve(this.results));
    });
  }
  async skipOneTask({ stream }) {
    const result = await streamPipelinePromise([
      stream,
      new TrashWriteStream(),
    ]);
    return result;
  }
  async runOneTask({ header, stream }) {
    await this.checkFileSize(header);
    const result = await this.uploadToCos({
      targetBucket: this.targetBucket,
      targetRegion: this.targetRegion,
      targetKey: path.join(this.targetPrefix, header.name).replace(/\\/g, '/'),
      stream,
    });
    return result;
  }
  async checkFileSize({ size }) {
    if (size > PUT_OBJECT_LIMIT) {
      throw new Error(`checkFileSize error, fileSize(${size}) is larger than PUT_OBJECT_LIMIT(${PUT_OBJECT_LIMIT})`);
    }
  }
  async uploadToCos({ targetBucket, targetRegion, targetKey, stream }) {
    this.passThrough = new PassThrough();
    const result = await Promise.all([
      this.cosInstance.putObject({
        Bucket: targetBucket,
        Region: targetRegion,
        Key: targetKey,
        Body: this.passThrough,
      }),
      streamPipelinePromise([stream, this.passThrough]),
    ]);
    this.passThrough = null;
    return result[0];
  }
  cancelTask(error = new Error('task is canceled')) {
    this.cancelError = error;
    if (this.passThrough) {
      this.passThrough.emit('error', error);
    }
  }
}

module.exports = CosTGunzipFileTask;
