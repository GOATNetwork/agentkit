import { Contract, ContractFactory, getCreateAddress, type Provider, type Signer } from 'ethers';
import type { WalletProvider, WalletCallOptions } from './wallet-provider';
import { broadcastTransaction, confirmEthersTransaction } from './broadcast-transaction';

import { throwIfAborted } from '../runtime/abort';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
];

export class EvmWalletProvider implements WalletProvider {
  constructor(
    private readonly signer: Signer,
    private readonly provider: Provider,
    private readonly networkName: string = 'goat-testnet',
  ) {}

  async getAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  async getNetwork(): Promise<string> {
    return this.networkName;
  }

  async getChainId(): Promise<number> {
    // ethers v6 returns a bigint for chainId; cast to plain number for the WalletProvider contract.
    return Number((await this.provider.getNetwork()).chainId);
  }

  /**
   * Read the latest block's timestamp (Unix seconds) from the underlying provider.
   *
   * Used by time-gated read actions (e.g. GNS `waitForCommitment`) that must
   * compare against on-chain `block.timestamp` rather than wall-clock time —
   * the on-chain commit window enforcement uses `block.timestamp` and the
   * local clock can drift arbitrarily from miners.
   *
   * Not part of the base `WalletProvider` interface yet: only EVM-backed
   * providers can satisfy it. Actions that need this capability narrow-cast
   * to `EvmWalletProvider` and throw `INVALID_INPUT` otherwise.
   */
  async getLatestBlockTimestamp(): Promise<number> {
    const block = await this.provider.getBlock('latest');
    if (!block) {
      throw new Error('EvmWalletProvider.getLatestBlockTimestamp: provider returned null for latest block');
    }
    return Number(block.timestamp);
  }

  async getBalance(address?: string): Promise<string> {
    const addr = address ?? (await this.getAddress());
    const balance = await this.provider.getBalance(addr);
    return balance.toString();
  }

  async getErc20Balance(tokenAddress: string, owner?: string): Promise<string> {
    const addr = owner ?? (await this.getAddress());
    const token = new Contract(tokenAddress, ERC20_ABI, this.provider);
    const balance = await token.balanceOf(addr);
    return balance.toString();
  }

  async transferNative(to: string, amountWei: string, options?: WalletCallOptions): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const tx = await broadcastTransaction(
      this.signer,
      { to, value: BigInt(amountWei) },
      options?.signal,
      options?.onSignedTransaction,
    );
    const receipt = await confirmEthersTransaction(tx, options);
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async broadcastErc20(
    tokenAddress: string,
    to: string,
    amount: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const token = new Contract(tokenAddress, ERC20_ABI, this.signer);
    const request = await token.transfer.populateTransaction(to, BigInt(amount));
    const tx = await broadcastTransaction(this.signer, request, options?.signal, options?.onSignedTransaction);
    if (!tx.hash) throw new Error('Transfer submission returned no transaction hash');
    return { txHash: tx.hash };
  }

  async transferErc20(
    tokenAddress: string,
    to: string,
    amount: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const token = new Contract(tokenAddress, ERC20_ABI, this.signer);
    const request = await token.transfer.populateTransaction(to, BigInt(amount));
    const tx = await broadcastTransaction(this.signer, request, options?.signal, options?.onSignedTransaction);
    const receipt = await confirmEthersTransaction(tx, options);
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async approveErc20(
    tokenAddress: string,
    spender: string,
    amount: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    throwIfAborted(options?.signal);
    const token = new Contract(tokenAddress, ERC20_ABI, this.signer);
    const request = await token.approve.populateTransaction(spender, BigInt(amount));
    const tx = await broadcastTransaction(this.signer, request, options?.signal, options?.onSignedTransaction);
    const receipt = await confirmEthersTransaction(tx, options);
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, unknown[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.signer.signTypedData(domain, types as any, value);
  }

  async callContract(contractAddress: string, abi: string[], functionName: string, args: unknown[]): Promise<unknown> {
    const contract = new Contract(contractAddress, abi, this.provider);
    return contract[functionName](...args);
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
    const contract = new Contract(contractAddress, abi, this.signer);
    const overrides = value ? { value: BigInt(value) } : {};
    const request = await contract[functionName].populateTransaction(...args, overrides);
    const tx = await broadcastTransaction(this.signer, request, options?.signal, options?.onSignedTransaction);
    const receipt = await confirmEthersTransaction(tx, options);
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async deployContract(
    abi: string[],
    bytecode: string,
    args: unknown[] = [],
    value?: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string; contractAddress: string }> {
    throwIfAborted(options?.signal);
    const factory = new ContractFactory(abi, bytecode, this.signer);
    const overrides = value ? { value: BigInt(value) } : {};
    const request = await factory.getDeployTransaction(...args, overrides);
    const deployTx = await broadcastTransaction(this.signer, request, options?.signal, options?.onSignedTransaction);
    const receipt = await confirmEthersTransaction(deployTx, options);
    return {
      txHash: receipt?.hash ?? deployTx.hash,
      contractAddress: receipt?.contractAddress ?? getCreateAddress({ from: deployTx.from, nonce: deployTx.nonce }),
    };
  }
}
