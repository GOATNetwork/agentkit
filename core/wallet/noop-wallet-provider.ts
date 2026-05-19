import type { WalletProvider } from './wallet-provider';

export interface NoopWalletProviderOptions {
  networkName?: string;
  chainId?: number;
}

export class NoopWalletProvider implements WalletProvider {
  private readonly address: string;
  private readonly networkName: string;
  private readonly chainId: number;

  constructor(address = '0x0000000000000000000000000000000000000001', options: NoopWalletProviderOptions = {}) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NoopWalletProvider must not be used in production. Provide a real WalletProvider implementation.');
    }
    this.address = address;
    this.networkName = options.networkName ?? 'goat-testnet';
    this.chainId = options.chainId ?? 48816;
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async getNetwork(): Promise<string> {
    return this.networkName;
  }

  async getChainId(): Promise<number> {
    return this.chainId;
  }

  async getBalance(): Promise<string> {
    return '0';
  }

  async getErc20Balance(): Promise<string> {
    return '0';
  }

  async transferNative(): Promise<{ txHash: string }> {
    return { txHash: `0xmocktx_native_${Date.now().toString(16)}` };
  }

  async transferErc20(): Promise<{ txHash: string }> {
    return { txHash: `0xmocktx_erc20_${Date.now().toString(16)}` };
  }

  async approveErc20(): Promise<{ txHash: string }> {
    return { txHash: `0xmocktx_approve_${Date.now().toString(16)}` };
  }

  async signTypedData(): Promise<string> {
    return '0xmock_typed_data_signature';
  }

  async callContract(): Promise<unknown> {
    return '0x';
  }

  async writeContract(): Promise<{ txHash: string }> {
    return { txHash: `0xmocktx_write_${Date.now().toString(16)}` };
  }

  async deployContract(): Promise<{ txHash: string; contractAddress: string }> {
    return {
      txHash: `0xmocktx_deploy_${Date.now().toString(16)}`,
      contractAddress: `0xmock_contract_${Date.now().toString(16)}`,
    };
  }
}
