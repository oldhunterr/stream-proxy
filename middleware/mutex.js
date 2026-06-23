const hostLocks = new Map();

/**
 * Acquire a lock for the given hostname.
 * If the host is already locked, wait until it is released.
 */
async function acquire(host) {
  while (hostLocks.get(host)) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  hostLocks.set(host, true);
}

/**
 * Release the lock for the given hostname.
 */
function release(host) {
  hostLocks.delete(host);
}

module.exports = {
  acquire,
  release
};
