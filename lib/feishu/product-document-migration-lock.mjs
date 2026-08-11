const lockState = globalThis;

export class ProductDocumentMigrationBusyError extends Error {
  constructor() {
    super("已有产品文档迁移正在执行");
    this.name = "ProductDocumentMigrationBusyError";
  }
}

function tryAcquireProductDocumentMigrationLock() {
  if (lockState.__feishuProductDocumentMigrationLock) return null;
  const owner = Symbol("feishu-product-document-migration");
  lockState.__feishuProductDocumentMigrationLock = owner;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (lockState.__feishuProductDocumentMigrationLock === owner) {
      delete lockState.__feishuProductDocumentMigrationLock;
    }
  };
}

/**
 * Run one mutating migration at a time in this application instance. Lock
 * ownership is token-based so a stale/double release cannot unlock a newer run.
 * @template T
 * @param {() => Promise<T> | T} operation
 * @returns {Promise<T>}
 */
export async function withProductDocumentMigrationLock(operation) {
  const release = tryAcquireProductDocumentMigrationLock();
  if (!release) throw new ProductDocumentMigrationBusyError();
  try {
    return await operation();
  } finally {
    release();
  }
}
