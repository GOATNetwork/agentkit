import {
  createWalletClient,
  createPublicClient,
  parseAbi,
  encodeFunctionData,
  encodeDeployData,
  keccak256,
  type Account,
  type Chain,
  type Transport,
  type WalletClient,
  type PublicClient,
} from 'viem';
import type { WalletProvider, WalletCallOptions } from './wallet-provider';

import { AgentkitRuntimeError } from '../errors/error';
import { ErrorCodes } from '../errors/error-codes';
import { raceSignal, throwIfAborted } from '../runtime/abort';
import { confirmTransaction, signTransaction } from './broadcast-transaction';

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
]);

export class ViemWalletProvider implements WalletProvider {
  private readonly walletClient: WalletClient;
  private readonly publicClient: PublicClient;
  private readonly networkName: string;

  constructor(account: Account, chain: Chain, transport: Transport, networkName?: string) {
    this.walletClient = createWalletClient({ account, chain, transport });
    this.publicClient = createPublicClient({ chain, transport });
    this.networkName = networkName ?? chain.name;
  }

  async getAddress(): Promise<string> {
    // Transactions use this bound account, not the first account returned by
    // eth_accounts. Both local and JSON-RPC accounts already carry its address.
    return this.walletClient.account!.address;
  }

  async getNetwork(): Promise<string> {
    return this.networkName;
  }

  async getChainId(): Promise<number> {
    return await this.publicClient.getChainId();
  }

  async getBalance(address?: string): Promise<string> {
    const addr = (address ?? (await this.getAddress())) as `0x${string}`;
    const balance = await this.publicClient.getBalance({ address: addr });
    return balance.toString();
  }

  async getErc20Balance(tokenAddress: string, owner?: string): Promise<string> {
    const addr = (owner ?? (await this.getAddress())) as `0x${string}`;
    const balance = await this.publicClient.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [addr],
    });
    return balance.toString();
  }

  async transferNative(to: string, amountWei: string, options?: WalletCallOptions): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const hash = await this.broadcast({ to: to as `0x${string}`, value: BigInt(amountWei) }, options);
    const receipt = await this.confirm(hash, options);
    return { txHash: receipt.transactionHash ?? hash };
  }

  async transferErc20(
    tokenAddress: string,
    to: string,
    amount: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const { txHash: hash } = await this.broadcastErc20(tokenAddress, to, amount, options);
    const receipt = await this.confirm(hash as `0x${string}`, options);
    return { txHash: receipt.transactionHash ?? hash };
  }

  async broadcastErc20(
    tokenAddress: string,
    to: string,
    amount: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const hash = await this.broadcast(
      {
        to: tokenAddress as `0x${string}`,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [to as `0x${string}`, BigInt(amount)],
        }),
      },
      options,
    );
    return { txHash: hash };
  }

  private async broadcast(
    transaction: { to?: `0x${string}`; value?: bigint; data?: `0x${string}` },
    options?: WalletCallOptions,
  ): Promise<`0x${string}`> {
    throwIfAborted(options?.signal);
    const request = await raceSignal(
      this.walletClient.prepareTransactionRequest({
        ...transaction,
        chain: this.walletClient.chain,
        account: this.walletClient.account!,
        // sendTransaction normally forwards this for local accounts. Preserve
        // its reservations when preparing and signing in separate steps.
        nonceManager: this.walletClient.account?.type === 'local' ? this.walletClient.account.nonceManager : undefined,
      }),
      options?.signal,
    );
    throwIfAborted(options?.signal);
    const serializedTransaction = await signTransaction(
      () =>
        this.walletClient.signTransaction({
          ...request,
          chain: this.walletClient.chain,
          account: this.walletClient.account!,
        }),
      options?.signal,
    );
    throwIfAborted(options?.signal);
    const signedTxHash = keccak256(serializedTransaction);
    await options?.onSignedTransaction?.(signedTxHash);
    throwIfAborted(options?.signal);
    try {
      return await this.walletClient.sendRawTransaction({ serializedTransaction });
    } catch (cause) {
      const error = new AgentkitRuntimeError(
        ErrorCodes.ADAPTER_REQUEST_FAILED,
        'Transaction submission incomplete; inspect the signed transaction hash before retrying',
        cause,
      );
      error.recovery = { kind: 'transaction', operationId: signedTxHash, phase: 'submitting', signedTxHash };
      error.recoveryGuidance = true;
      throw error;
    }
  }

  private async confirm(hash: `0x${string}`, options?: WalletCallOptions) {
    let replacementReason: string | undefined;
    const receipt = await confirmTransaction(
      hash,
      () =>
        this.publicClient.waitForTransactionReceipt({
          hash,
          onReplaced: ({ reason }) => {
            replacementReason = reason;
          },
        }),
      options,
    );
    const confirmedHash = receipt.transactionHash ?? hash;
    // viem resolves even for reverted or cancellation receipts. Validate after
    // the wait, and checkpoint a mined replacement before returning its outcome.
    return confirmTransaction(
      confirmedHash,
      async () => {
        if (confirmedHash !== hash && replacementReason !== 'repriced') {
          const error = new AgentkitRuntimeError(
            ErrorCodes.WALLET_TRANSFER_FAILED,
            'Transaction was cancelled or replaced with a different call; reconcile before retrying',
          );
          error.recoveryGuidance = true;
          throw error;
        }
        if (receipt.status !== 'success')
          throw new AgentkitRuntimeError(
            ErrorCodes.WALLET_TRANSFER_FAILED,
            'Transaction reverted or returned an invalid receipt status',
          );
        return receipt;
      },
      { ...options, onBroadcast: confirmedHash === hash ? undefined : options?.onBroadcast },
    );
  }

  async approveErc20(
    tokenAddress: string,
    spender: string,
    amount: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const hash = await this.broadcast(
      {
        to: tokenAddress as `0x${string}`,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [spender as `0x${string}`, BigInt(amount)],
        }),
      },
      options,
    );
    const receipt = await this.confirm(hash, options);
    return { txHash: receipt.transactionHash ?? hash };
  }

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, unknown[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.walletClient.signTypedData({
      domain: domain as any,
      types: types as any,
      primaryType: Object.keys(types).find((k) => k !== 'EIP712Domain') ?? '',
      message: value as any,
      account: this.walletClient.account!,
    });
  }

  async callContract(contractAddress: string, abi: string[], functionName: string, args: unknown[]): Promise<unknown> {
    const parsedAbi = parseAbi(abi as readonly string[]);
    return this.publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: parsedAbi,
      functionName,
      args: args as any,
    });
  }

  async writeContract(
    contractAddress: string,
    abi: string[],
    functionName: string,
    args: unknown[],
    value?: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const parsedAbi = parseAbi(abi as readonly string[]);
    const hash = await this.broadcast(
      {
        to: contractAddress as `0x${string}`,
        data: encodeFunctionData({ abi: parsedAbi, functionName, args }),
        value: value ? BigInt(value) : undefined,
      },
      options,
    );
    const receipt = await this.confirm(hash, options);
    return { txHash: receipt.transactionHash ?? hash };
  }

  async deployContract(
    abi: string[],
    bytecode: string,
    args: unknown[] = [],
    value?: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string; contractAddress: string }> {
    throwIfAborted(options?.signal);
    const parsedAbi = parseAbi(abi as readonly string[]);
    const hash = await this.broadcast(
      {
        data: encodeDeployData({ abi: parsedAbi, bytecode: bytecode as `0x${string}`, args }),
        value: value ? BigInt(value) : undefined,
      },
      options,
    );
    const receipt = await this.confirm(hash, options);
    return {
      txHash: receipt.transactionHash ?? hash,
      contractAddress: receipt.contractAddress ?? '',
    };
  }
}
