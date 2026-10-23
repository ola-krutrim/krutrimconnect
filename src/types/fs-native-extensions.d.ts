declare module "fs-native-extensions" {
  export interface LockOptions {
    shared?: boolean;
  }

  export function tryLock(
    fileDescriptor: number,
    offset?: number,
    length?: number,
    options?: LockOptions,
  ): boolean;

  export function unlock(fileDescriptor: number, offset?: number, length?: number): void;
}
