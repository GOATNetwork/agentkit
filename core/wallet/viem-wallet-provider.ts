import {
  createWalletClient,
  createPublicClient,
  parseAbi,
  type Account,
  type Chain,
  type Transport,
  type WalletClient,
  type PublicClient,
} from 'viem';
import type { WalletProvider, WalletCallOptions } from './wallet-provider';

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

  async getAddress(): Promise<string> {
    const [address] = await this.walletClient.getAddresses();
    return address;
  }

  async getNetwork(): Promise<string> {
    return this.networkName;
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
    this.throwIfAborted(options?.signal);
    const hash = await this.raceSignal(this.walletClient.sendTransaction({
      to: to as `0x${string}`,
      value: BigInt(amountWei),
      chain: this.walletClient.chain,
      account: this.walletClient.account!,
    }), options?.signal);
    await this.raceSignal(this.publicClient.waitForTransactionReceipt({ hash }), options?.signal);
    return { txHash: hash };
  }

  async transferErc20(
    tokenAddress: string,
    to: string,
    amount: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    this.throwIfAborted(options?.signal);
    const hash = await this.raceSignal(this.walletClient.writeContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [to as `0x${string}`, BigInt(amount)],
      chain: this.walletClient.chain,
      account: this.walletClient.account!,
    }), options?.signal);
    await this.raceSignal(this.publicClient.waitForTransactionReceipt({ hash }), options?.signal);
    return { txHash: hash };
  }

  async approveErc20(
    tokenAddress: string,
    spender: string,
    amount: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string }> {
    this.throwIfAborted(options?.signal);
    const hash = await this.raceSignal(this.walletClient.writeContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender as `0x${string}`, BigInt(amount)],
      chain: this.walletClient.chain,
      account: this.walletClient.account!,
    }), options?.signal);
    await this.raceSignal(this.publicClient.waitForTransactionReceipt({ hash }), options?.signal);
    return { txHash: hash };
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

  async callContract(
    contractAddress: string,
    abi: string[],
    functionName: string,
    args: unknown[],
  ): Promise<unknown> {
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
    this.throwIfAborted(options?.signal);
    const parsedAbi = parseAbi(abi as readonly string[]);
    const hash = await this.raceSignal(this.walletClient.writeContract({
      address: contractAddress as `0x${string}`,
      abi: parsedAbi,
      functionName,
      args: args as any,
      value: value ? BigInt(value) : undefined,
      chain: this.walletClient.chain,
      account: this.walletClient.account!,
    }), options?.signal);
    await this.raceSignal(this.publicClient.waitForTransactionReceipt({ hash }), options?.signal);
    return { txHash: hash };
  }

  async deployContract(
    abi: string[],
    bytecode: string,
    args: unknown[] = [],
    value?: string,
    options?: WalletCallOptions,
  ): Promise<{ txHash: string; contractAddress: string }> {
    this.throwIfAborted(options?.signal);
    const parsedAbi = parseAbi(abi as readonly string[]);
    const hash = await this.raceSignal(this.walletClient.deployContract({
      abi: parsedAbi,
      bytecode: bytecode as `0x${string}`,
      args: args as any,
      value: value ? BigInt(value) : undefined,
      chain: this.walletClient.chain,
      account: this.walletClient.account!,
    }), options?.signal);
    const receipt = await this.raceSignal(this.publicClient.waitForTransactionReceipt({ hash }), options?.signal);
    return {
      txHash: hash,
      contractAddress: receipt.contractAddress ?? '',
    };
  }
}
