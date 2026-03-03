import { Contract, ContractFactory, type Provider, type Signer } from 'ethers';
import type { WalletProvider } from './wallet-provider';

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

  async transferNative(to: string, amountWei: string): Promise<{ txHash: string }> {
    const tx = await this.signer.sendTransaction({ to, value: BigInt(amountWei) });
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async transferErc20(tokenAddress: string, to: string, amount: string): Promise<{ txHash: string }> {
    const token = new Contract(tokenAddress, ERC20_ABI, this.signer);
    const tx = await token.transfer(to, BigInt(amount));
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async approveErc20(tokenAddress: string, spender: string, amount: string): Promise<{ txHash: string }> {
    const token = new Contract(tokenAddress, ERC20_ABI, this.signer);
    const tx = await token.approve(spender, BigInt(amount));
    const receipt = await tx.wait();
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
  ): Promise<{ txHash: string }> {
    const contract = new Contract(contractAddress, abi, this.signer);
    const overrides = value ? { value: BigInt(value) } : {};
    const tx = await contract[functionName](...args, overrides);
    const receipt = await tx.wait();
    return { txHash: receipt?.hash ?? tx.hash };
  }

  async deployContract(
    abi: string[],
    bytecode: string,
    args: unknown[] = [],
    value?: string,
  ): Promise<{ txHash: string; contractAddress: string }> {
    const factory = new ContractFactory(abi, bytecode, this.signer);
    const overrides = value ? { value: BigInt(value) } : {};
    const contract = await factory.deploy(...args, overrides);
    const tx = await contract.deploymentTransaction()!.wait();
    const contractAddress = await contract.getAddress();
    return { txHash: tx?.hash ?? '', contractAddress };
  }
}
