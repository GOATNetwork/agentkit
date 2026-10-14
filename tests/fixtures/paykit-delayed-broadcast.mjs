// Loaded only by CLI subprocess regression tests; no transaction reaches an RPC.
import { JsonRpcProvider, Wallet } from 'ethers';
import fs, { appendFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';

JsonRpcProvider.prototype.getNetwork = async () => ({ chainId: 4217n });
// The SDK's background replacement watcher must not reach the real transport.
JsonRpcProvider.prototype.getTransactionReceipt = async () => {
  throw new Error('No receipt in mock transport');
};
Wallet.prototype.populateTransaction = async (transaction) => transaction;
Wallet.prototype.signTransaction = async () => '0xdeadbeef';
JsonRpcProvider.prototype.broadcastTransaction = async function () {
  await appendFile(process.env.PAYKIT_TEST_BROADCAST_LOG, 'accepted\n');
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.PAYKIT_TEST_BROADCAST_DELAY_MS ?? 1500)));
  return { hash: `0x${'44'.repeat(32)}` };
};

// Inject failures at the file write, inside the real store's I/O error wrapper.
// Emergency recovery uses another directory and must remain available.
if (
  process.env.PAYKIT_TEST_FAIL_STATE_DIR ||
  process.env.PAYKIT_TEST_COMPLETION_DELAY_MS ||
  process.env.PAYKIT_TEST_FAIL_COMPLETION_DIR
) {
  const open = fs.open;
  fs.open = async function (path, flags, ...options) {
    const file = await open(path, flags, ...options);
    if (flags === 'wx' && typeof path === 'string' && path.endsWith('.tmp')) {
      const writeFile = file.writeFile.bind(file);
      file.writeFile = async (data, ...writeOptions) => {
        const record = JSON.parse(String(data));
        if (record.phase === 'complete' && record.result && process.env.PAYKIT_TEST_COMPLETION_DELAY_MS)
          await new Promise((resolve) => setTimeout(resolve, Number(process.env.PAYKIT_TEST_COMPLETION_DELAY_MS)));
        if (dirname(path) === process.env.PAYKIT_TEST_FAIL_COMPLETION_DIR && record.phase === 'complete')
          throw Object.assign(new Error('test completion storage unavailable'), { code: 'ENOSPC' });
        if (dirname(path) === process.env.PAYKIT_TEST_FAIL_STATE_DIR && record.rail === 'mpp' && record.txHash)
          throw Object.assign(new Error('test primary storage unavailable'), { code: 'ENOSPC' });
        return writeFile(data, ...writeOptions);
      };
    }
    return file;
  };
  syncBuiltinESMExports();
}
