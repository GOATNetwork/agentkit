import { Contract, ContractFactory, type Provider, type Signer } from 'ethers';
import type { WalletProvider, WalletCallOptions } from './wallet-provider';

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

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Operation aborted');
  }

  private raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    this.throwIfAborted(signal);
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Operation aborted')), { once: true });
      }),
    ]);
  }

  async transferNative(to: string, amountWei: string, options?: WalletCallOptions): Promise<{ txHash: string }> {
    this.throwIfAborted(options?.signal);
    const tx = await this.raceSignal(this.signer.sendTransaction({ to, value: BigInt(amountWei) }), options?.signal);
    const receipt = await this.raceSignal(tx.wait(), options?.signal);
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async transferErc20(tokenAddress: string, to: string, amount: string, options?: WalletCallOptions): Promise<{ txHash: string }> {
    this.throwIfAborted(options?.signal);
    const token = new Contract(tokenAddress, ERC20_ABI, this.signer);
    const tx = await this.raceSignal(token.transfer(to, BigInt(amount)), options?.signal);
    const receipt = await this.raceSignal(tx.wait() as Promise<any>, options?.signal);
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async approveErc20(tokenAddress: string, spender: string, amount: string, options?: WalletCallOptions): Promise<{ txHash: string }> {
    this.throwIfAborted(options?.signal);
    const token = new Contract(tokenAddress, ERC20_ABI, this.signer);
    const tx = await this.raceSignal(token.approve(spender, BigInt(amount)), options?.signal);
    const receipt = await this.raceSignal(tx.wait() as Promise<any>, options?.signal);
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, unknown[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.signer.signTypedData(domain, types as any, value);
  }

  async callContract(
    contractAddress: string,
    abi: string[],
    functionName: string,
    args: unknown[],
  ): Promise<unknown> {
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
    this.throwIfAborted(options?.signal);
    const contract = new Contract(contractAddress, abi, this.signer);
    const overrides = value ? { value: BigInt(value) } : {};
    const tx = await this.raceSignal(contract[functionName](...args, overrides), options?.signal);
    const receipt = await this.raceSignal(tx.wait() as Promise<any>, options?.signal);
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async deployContract(
    abi: string[],
    bytecode: string,
    args: unknown[] = [],
    value?: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string; contractAddress: string }> {
    this.throwIfAborted(options?.signal);
    const factory = new ContractFactory(abi, bytecode, this.signer);
    const overrides = value ? { value: BigInt(value) } : {};
    const contract = await this.raceSignal(factory.deploy(...args, overrides), options?.signal);
    const deployTx = contract.deploymentTransaction()!;
    await this.raceSignal(deployTx.wait(), options?.signal);
    const contractAddress = await contract.getAddress();
    return { txHash: deployTx.hash, contractAddress };
  }
}
