import { Global, Module } from '@nestjs/common';
import { ObjectStorage } from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';
import { StorageService } from './storage.service';

/** Provides `StorageService`. Tests override `ObjectStorage` with `FakeObjectStorage`. */
@Global()
@Module({
  providers: [{ provide: ObjectStorage, useClass: S3ObjectStorage }, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
