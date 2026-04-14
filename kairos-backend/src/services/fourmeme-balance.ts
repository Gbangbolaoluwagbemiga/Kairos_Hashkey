import { ethers } from "ethers";
import { getChainProvider, loadFourmemeChainConfigFromEnv } from "./fourmeme-chain.js";

export async function getNativeBalance(address: string): Promise<string> {
    const cfg = loadFourmemeChainConfigFromEnv();
    const { provider } = await getChainProvider(cfg);
    const bal = await provider.getBalance(address);
    return ethers.formatEther(bal);
}

